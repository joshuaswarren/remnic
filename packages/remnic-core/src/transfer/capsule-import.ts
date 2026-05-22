import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  createVersion,
  type VersioningConfig,
  type VersioningLogger,
} from "../page-versioning.js";
import {
  assertIsDirectoryNotSymlink,
  assertRealpathInsideRoot,
  fromPosixRelPath,
  isPathInsideRoot,
  sha256String,
} from "./fs-utils.js";
import {
  parseExportBundle,
  type CapsuleBlock,
  type ExportManifestV2,
  type ExportMemoryRecordV1,
} from "./types.js";
import { isEncryptedCapsuleFile, decryptCapsuleFileInMemory } from "./capsule-crypto.js";

/**
 * Conflict-resolution mode for {@link importCapsule}. Inverse of the
 * `mode` selector in PR 4/6's CLI surface.
 *
 *  - `"skip"` (default) — when a target file already exists at the same
 *    relative path, leave it untouched. The corresponding record is reported
 *    via {@link ImportCapsuleResult.skipped}.
 *  - `"overwrite"` — when a target file exists, snapshot the prior content
 *    via {@link createVersion} (gotcha #54: write-before-delete; gotcha #25:
 *    don't destroy old state until new state is confirmed), then write the
 *    incoming content. The snapshot's `note` includes the source capsule id.
 *  - `"fork"` — never overwrite. Every record is rebased under
 *    `forks/<capsule-id>/<original-path>` and any YAML-frontmatter `id:`
 *    field is rewritten to a new fork-scoped value. The original tree is
 *    not touched.
 *
 * The mode is selected once per call and applied uniformly to every record
 * in the bundle. Mixed-mode imports are not supported by design — that
 * would let a single corrupted manifest silently land partial state.
 */
export type ImportCapsuleMode = "skip" | "overwrite" | "fork";

/**
 * Options accepted by {@link importCapsule}.
 *
 * `archivePath` — absolute or cwd-relative path to a `.capsule.json.gz`
 * archive produced by `exportCapsule`. The archive must contain a V2
 * bundle (`schemaVersion: 2`); V1 archives are rejected.
 *
 * `root` — absolute or cwd-relative path to the memory directory that
 * will receive the records. Must be an existing directory.
 *
 * `mode` — see {@link ImportCapsuleMode}. Defaults to `"skip"`.
 *
 * `versioning` — optional page-versioning config used by `mode: "overwrite"`
 * to snapshot prior content before replacing it. Snapshots are skipped when
 * not provided or when `enabled === false`. Tests pass an enabled config
 * to assert snapshot creation; production callers thread the
 * orchestrator's resolved versioning config.
 *
 * `log` — optional logger forwarded to {@link createVersion}.
 *
 * `now` — optional clock override (ms epoch) used to derive deterministic
 * fork ids in tests. Production callers omit this.
 */
export interface ImportCapsuleOptions {
  archivePath: string;
  root: string;
  mode?: ImportCapsuleMode;
  versioning?: VersioningConfig;
  log?: VersioningLogger;
  now?: number;
  /**
   * Memory directory whose secure-store keyring is used when the archive is
   * encrypted. Required when `archivePath` ends with `.enc` or when the file
   * starts with the REMNIC-ENC magic header. If `memoryDir` is omitted and the
   * archive turns out to be encrypted, `importCapsule` throws a clear error
   * rather than silently failing.
   *
   * When provided and the archive is NOT encrypted, the value is ignored.
   */
  memoryDir?: string;
  /**
   * Original secure-store passphrase for encrypted format-v2 archives. When
   * supplied, the importer derives the archive key from the embedded KDF
   * header, enabling restore without the source machine's unlocked keyring.
   */
  passphrase?: string;
}

export interface ImportCapsuleSkippedRecord {
  /** Original record path (capsule-relative, posix). */
  path: string;
  /**
   * Why this record was not written.
   *
   * `"exists"` — the target path already existed and the mode was `"skip"`,
   * OR the computed fork path already existed in fork mode.
   *
   * `"checksum_mismatch"` is intentionally absent: a checksum failure aborts
   * the import entirely (fail-closed) rather than skipping the offending
   * record, so no `ImportCapsuleSkippedRecord` is ever produced for it.
   */
  reason: "exists";
}

export interface ImportCapsuleImportedRecord {
  /** Capsule-relative posix path the record carried. */
  sourcePath: string;
  /** Memory-dir-relative posix path the file was written to. */
  targetPath: string;
  /** Whether a prior version snapshot was taken (overwrite-mode only). */
  snapshotted: boolean;
  /** Whether the frontmatter `id:` field was rewritten (fork-mode only). */
  rewroteId: boolean;
}

export interface ImportCapsuleResult {
  /** Records that landed on disk. */
  imported: ImportCapsuleImportedRecord[];
  /** Records that were not written. */
  skipped: ImportCapsuleSkippedRecord[];
  /** The manifest decoded from the archive. */
  manifest: ExportManifestV2;
}

/**
 * Pure async function that imports a capsule archive into a memory
 * directory. Inverse of {@link import("./capsule-export.js").exportCapsule}.
 *
 * Sequence:
 *   1. Read + gunzip + JSON.parse the archive.
 *   2. Validate the bundle through `parseExportBundle` (V1 rejected).
 *   3. Verify each record's content sha256 against the manifest entry.
 *      Any mismatch aborts the import BEFORE any file is written —
 *      partial-write recovery would require a full rollback we cannot
 *      offer cheaply, so we fail closed (gotcha #25).
 *   4. Apply the selected {@link ImportCapsuleMode} to every record.
 *
 * Determinism guarantees:
 *  - Imported records are returned sorted by `sourcePath`.
 *  - Skipped records are returned sorted by `path`.
 *  - Fork-mode rebases under a stable `forks/<capsule-id>/` prefix so
 *    repeated fork imports of the same capsule shape land in predictable
 *    locations (subsequent fork imports still skip-on-exist because the
 *    target tree is computed from the source path).
 */
export async function importCapsule(
  opts: ImportCapsuleOptions,
): Promise<ImportCapsuleResult> {
  const archiveAbs = path.resolve(opts.archivePath);
  const rootAbs = path.resolve(opts.root);
  await assertIsDirectoryNotSymlink(rootAbs, "importCapsule", "root");

  const mode: ImportCapsuleMode = opts.mode ?? "skip";
  // Reject unknown mode values up-front (rule 51). TypeScript callers get a
  // compile-time check via the union type; JS/CLI callers get a runtime error
  // here before any write begins — not a silent destructive fallback.
  if (mode !== "skip" && mode !== "overwrite" && mode !== "fork") {
    throw new Error(
      `importCapsule: unknown mode ${JSON.stringify(mode)}; expected "skip", "overwrite", or "fork"`,
    );
  }

  // Auto-detect encrypted archives. If the file ends with `.enc` or starts
  // with the REMNIC-ENC magic header, decrypt it first before gunzip+parse.
  // Rule 48: default is "not encrypted"; we only attempt decryption when the
  // header is definitively present, never on ambiguous content.
  const encrypted = await isEncryptedCapsuleFile(archiveAbs);
  let raw: Buffer;
  if (encrypted) {
    if (!opts.memoryDir && !opts.passphrase) {
      throw new Error(
        `importCapsule: archive is encrypted but 'memoryDir' was not provided. ` +
          `Pass the memory directory so the secure-store key can be retrieved, ` +
          `provide the original passphrase for a format-v2 archive restore, ` +
          `or run \`remnic secure-store unlock\` before importing.`,
      );
    }
    raw = await decryptCapsuleFileInMemory(archiveAbs, opts.memoryDir, {
      passphrase: opts.passphrase,
    });
  } else {
    raw = await readFile(archiveAbs);
  }
  const json = gunzipSync(raw).toString("utf-8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch (cause) {
    throw new Error(
      `importCapsule: archive is not valid JSON after gunzip: ${archiveAbs}`,
      { cause: cause as Error },
    );
  }

  const parsed = parseExportBundle(parsedJson);
  if (parsed.capsuleVersion !== 2) {
    // PR 1/6 ships a V1 reader; capsule import is V2-only by design. A V1
    // bundle does not carry a capsule block, so fork-mode (which depends on
    // `capsule.id` for the rebase prefix) cannot work. Reject up-front per
    // gotcha #51 instead of silently routing to a different code path.
    throw new Error(
      "importCapsule: archive is V1; only V2 capsule archives are supported",
    );
  }
  const bundle = parsed.bundle as { manifest: ExportManifestV2; records: ExportMemoryRecordV1[] };
  const manifest = bundle.manifest;
  const capsule = manifest.capsule;

  // Build a path → manifest-entry index for O(1) checksum lookup. The
  // manifest is the source of truth; records-without-manifest-entries and
  // manifest-entries-without-records are both treated as corruption.
  const manifestIndex = new Map<string, ExportManifestV2["files"][number]>();
  for (const f of manifest.files) {
    manifestIndex.set(f.path, f);
  }
  if (manifestIndex.size !== manifest.files.length) {
    throw new Error(
      "importCapsule: manifest contains duplicate file paths",
    );
  }
  const recordPaths = new Set<string>();
  for (const rec of bundle.records) {
    if (recordPaths.has(rec.path)) {
      throw new Error(
        `importCapsule: bundle contains duplicate record path: ${rec.path}`,
      );
    }
    recordPaths.add(rec.path);
  }

  // Phase 1: verify every record matches its manifest entry AND validate all
  // target paths before any filesystem mutation.  We do both in a single pass
  // so a corrupted or malicious archive cannot leave the memory dir partially
  // written (fail-closed per gotcha #25).
  //
  // The real root is resolved once via realpath so the subsequent per-record
  // inside-root checks are symlink-aware: a record path like `facts/a.md`
  // cannot write outside the intended sandbox via a symlinked subdirectory
  // (Codex P1 feedback).  If realpath fails (root does not exist) the earlier
  // assertIsDirectoryNotSymlink call already threw, so this should always succeed.
  const rootReal = await realpath(rootAbs).catch(() => rootAbs);

  // Tracks normalized, case-folded target paths seen so far in phase 1.  Maps
  // targetAbs.toLowerCase() → first source path so the collision error can name
  // both offending entries.  Two manifest entries whose computed target paths
  // normalize to the same absolute path (e.g. `subdir/file.md` and
  // `subdir/./file.md`, or differing case on case-insensitive filesystems such
  // as macOS and Windows) would both try to write the same inode — the second
  // would silently overwrite the first.  We reject the import up-front before
  // any write (Codex P2 thread on PR #741, line 283).
  const seenTargetPaths = new Map<string, string>();

  for (const rec of bundle.records) {
    // Checksum validation.
    const entry = manifestIndex.get(rec.path);
    if (!entry) {
      throw new Error(
        `importCapsule: archive checksum mismatch (record without manifest entry: ${rec.path})`,
      );
    }
    const { sha256, bytes } = sha256String(rec.content);
    if (sha256 !== entry.sha256 || bytes !== entry.bytes) {
      throw new Error(
        `importCapsule: archive checksum mismatch for ${rec.path}: ` +
          `expected sha256=${entry.sha256} bytes=${entry.bytes}, ` +
          `got sha256=${sha256} bytes=${bytes}`,
      );
    }

    // Source path validation: reject any record whose posix source path
    // contains a `..` segment, an absolute prefix, or any component that would
    // let fork-mode bypass its isolation invariant.  This check runs before
    // `computeTargetPath` so that fork mode's `forks/<id>/` rebase cannot be
    // bypassed by a path like `../../profile.md` (which `path.join` would
    // silently collapse, landing the file inside root but outside the fork
    // prefix — Cursor medium thread #741).  Rejecting `..` up-front is simpler
    // and more robust than normalising after the fact.
    //
    // Extended guard (Codex P1 #741 round 5): also reject paths containing
    // backslash separators (`\`), which are Windows path separators. On Windows
    // a path like `..\\escape.md` or `subdir\\..\\..\\escape.md` would resolve
    // to a parent traversal but would bypass a purely posix-split check.
    // Additionally, after posix-normalizing the path we re-check for a leading
    // `..` or `/` — this catches edge-cases such as `subdir/../..` where the
    // individual split segments are not `..` but the normalized result is.
    if (rec.path.includes("\\")) {
      throw new Error(
        `importCapsule: record path contains backslash separators (Windows-style paths are not allowed): ${rec.path}`,
      );
    }
    const posixNormalized = path.posix.normalize(rec.path);
    if (
      rec.path.startsWith("/") ||
      rec.path.split("/").some((seg) => seg === "..") ||
      posixNormalized.startsWith("..") ||
      posixNormalized.startsWith("/")
    ) {
      throw new Error(
        `importCapsule: record path escapes target root: ${rec.path}`,
      );
    }

    // Path-traversal validation (moved here from phase 2 per Cursor feedback:
    // the traversal check must run before ANY write so a malicious archive
    // with an escaping path that sorts last cannot land partial writes).
    //
    // We build targetAbs relative to the real-resolved root (rootReal) so
    // that the inside-root check is symlink-aware: if `rootReal !== rootAbs`
    // (the import root is itself behind a symlink), we still compare against
    // the canonical path (Codex P1).
    const targetRel = computeTargetPath(rec.path, mode, capsule.id);
    const targetAbs = path.join(rootReal, fromPosixRelPath(targetRel));
    if (!isPathInsideRoot(rootReal, targetAbs)) {
      throw new Error(
        `importCapsule: record path escapes target root: ${rec.path}`,
      );
    }

    // Symlink-aware containment check (Cursor thread #741 line 247/264).
    // The lexical check above handles `..`-traversal but cannot detect
    // symlinked subdirectories that point outside the root. We resolve the
    // nearest existing ancestor of the target via realpath to catch symlinks
    // anywhere in the path components. If any resolved prefix escapes rootReal,
    // the import is rejected before any write. This applies to ALL modes,
    // including fork mode whose rebase prefix may itself traverse a symlink.
    await assertRealpathInsideRoot(rootReal, targetAbs, rec.path, "importCapsule");

    // Target-file symlink check (Codex P1 #741 round 4, line 260).
    // `assertRealpathInsideRoot` resolves the nearest existing *ancestor* to
    // catch symlinked parent directories, but if the TARGET FILE itself already
    // exists and is a symlink, that check passes (the parent is real) while the
    // write would silently follow the symlink to a path outside root.  We
    // therefore lstat the target directly: if it exists and is a symlink we
    // reject the record up-front.  For new files the parent-canonicalization
    // performed above is sufficient; no realpath of a non-existent file is
    // needed.
    const targetLstat = await lstat(targetAbs).catch(() => null);
    if (targetLstat !== null && targetLstat.isSymbolicLink()) {
      throw new Error(
        `importCapsule: record target is a symlink and cannot be written to safely: ${rec.path}`,
      );
    }

    // Duplicate normalized target path detection (Codex P2 #741, line 283).
    // `path.join` already normalises `.` segments (e.g. `subdir/./file.md` →
    // `subdir/file.md`).  On case-insensitive filesystems (macOS default,
    // Windows), two paths that differ only in case would resolve to the same
    // inode.  We fold the dedup key to lowercase so that `subdir/File.md` and
    // `subdir/file.md` are detected as duplicates before any write occurs.
    // This is intentionally unconditional: the cost of an extra `.toLowerCase()`
    // on case-sensitive filesystems is negligible, and a defensive lowercase
    // is far simpler than probing filesystem case-sensitivity at runtime.
    const dedupKey = targetAbs.toLowerCase();
    const firstSourcePath = seenTargetPaths.get(dedupKey);
    if (firstSourcePath !== undefined) {
      throw new Error(
        `importCapsule: manifest contains two entries that resolve to the same target path: ` +
          `"${firstSourcePath}" and "${rec.path}" both map to "${targetRel}"`,
      );
    }
    seenTargetPaths.set(dedupKey, rec.path);
  }
  // Detect manifest-only entries (missing record). Treat as corruption.
  for (const f of manifest.files) {
    if (!recordPaths.has(f.path)) {
      throw new Error(
        `importCapsule: archive checksum mismatch (manifest entry without record: ${f.path})`,
      );
    }
  }

  // Phase 2: apply the mode. All records were validated in phase 1; we now
  // write to disk. Per-record errors propagate; each individual write is
  // atomic (mkdir + writeFile pair).
  const imported: ImportCapsuleImportedRecord[] = [];
  const skipped: ImportCapsuleSkippedRecord[] = [];

  // Sort by source path so the imported/skipped lists are deterministic
  // regardless of bundle order. (`exportCapsule` already sorts; we re-sort
  // defensively in case a hand-edited archive ships records in another order.)
  const sortedRecords = [...bundle.records].sort((a, b) =>
    a.path.localeCompare(b.path),
  );

  for (const rec of sortedRecords) {
    const targetRel = computeTargetPath(rec.path, mode, capsule.id);
    // Use rootReal (realpath-resolved) to stay consistent with phase 1's
    // traversal validation and avoid writing through stale symlinks.
    const targetAbs = path.join(rootReal, fromPosixRelPath(targetRel));

    const exists = await fileExistsAt(targetAbs);

    // Skip logic applies to both `skip` mode (explicit) and `fork` mode
    // (Cursor medium: fork mode must also be skip-on-exist for the computed
    // fork path, because production imports generate non-deterministic IDs —
    // so re-importing the same capsule should not overwrite user edits in the
    // fork tree or silently change file identities by generating new IDs).
    if ((mode === "skip" || mode === "fork") && exists) {
      skipped.push({ path: rec.path, reason: "exists" });
      continue;
    }

    let snapshotted = false;
    if (mode === "overwrite" && exists) {
      // Gotcha #54: snapshot BEFORE overwriting. If snapshot creation fails
      // we abort this record's import rather than silently destroying
      // history. The page-versioning module is responsible for atomic
      // sidecar writes; we just call it.
      if (opts.versioning && opts.versioning.enabled) {
        const prior = await readFile(targetAbs, "utf-8").catch(() => "");
        await createVersion(
          targetAbs,
          prior,
          "manual",
          opts.versioning,
          opts.log,
          `capsule-import: ${capsule.id}`,
          rootReal,
        );
        snapshotted = true;
      }
    }

    let contentToWrite = rec.content;
    let rewroteId = false;
    if (mode === "fork") {
      const forked = rewriteFrontmatterIdForFork(rec.content, capsule.id, opts.now);
      contentToWrite = forked.content;
      rewroteId = forked.rewrote;
    }

    await mkdir(path.dirname(targetAbs), { recursive: true });
    await writeFile(targetAbs, contentToWrite, "utf-8");
    imported.push({
      sourcePath: rec.path,
      targetPath: targetRel,
      snapshotted,
      rewroteId,
    });
  }

  // Sort skipped for stable output (see comment above).
  skipped.sort((a, b) => a.path.localeCompare(b.path));

  return { imported, skipped, manifest };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Compute the destination relative path for a record under the chosen
 * mode.
 *
 *  - `skip` / `overwrite` — identity: the record's posix path is used as-is.
 *  - `fork` — rebased under `forks/<capsule-id>/<original-path>` so the
 *    original tree is never modified.
 */
function computeTargetPath(
  sourcePosix: string,
  mode: ImportCapsuleMode,
  capsuleId: string,
): string {
  if (mode === "fork") return `forks/${capsuleId}/${sourcePosix}`;
  return sourcePosix;
}

async function fileExistsAt(absPath: string): Promise<boolean> {
  const st = await stat(absPath).catch(() => null);
  return st !== null && st.isFile();
}

// ---------------------------------------------------------------------------
// Fork-mode id rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite a YAML-frontmatter `id:` field to a fork-scoped value.
 *
 * Strategy: we deliberately do NOT parse the entire YAML — memory files
 * use a deterministic top-of-file frontmatter delimited by `---` lines,
 * and the orchestrator's `parseFrontmatter` reads `id` as a top-level
 * key with a single-line scalar value. We mirror that contract:
 *
 *   - Detect a leading `---\n` … `\n---` block at the top of the file.
 *   - Within that block, locate the first `id:` line that is not nested
 *     under another key (cheap heuristic: line starts at column 0).
 *   - Replace its value with a new fork-id derived from `capsuleId` and
 *     a short random suffix (or {@link opts.now} when provided for tests).
 *
 * Files without a frontmatter block, or without an `id:` key inside one,
 * are returned unchanged with `rewrote: false`. This keeps non-memory
 * artifacts (READMEs, transcripts) byte-identical to the source.
 */
function rewriteFrontmatterIdForFork(
  content: string,
  capsuleId: string,
  now: number | undefined,
): { content: string; rewrote: boolean } {
  // Detect the dominant line ending in the file so we can preserve it when
  // rebuilding the frontmatter delimiters. Splitting/joining on `\n` silently
  // drops `\r` from CRLF files, changing the byte content (Cursor thread #741
  // line 467). We detect the ending of the very first line (the opening `---`)
  // and use that as the canonical separator for the reconstructed delimiters.
  // All three cases are covered: CRLF (\r\n), LF (\n), and bare CR (\r).
  const crlfMatch = /^---(\r\n|\r|\n)/.exec(content);
  // Fall back to LF if the file starts with `---` but has no newline (EOF).
  const eol = crlfMatch ? crlfMatch[1] : "\n";

  // Frontmatter block detection: `---` on its own line at the very start,
  // followed by content, followed by `---` on its own line. The closing
  // delimiter must be at column 0. We capture the trailing terminator
  // (`\r?\n` or end-of-string) as a separate group so we can re-emit it
  // verbatim, preserving CRLF/LF/EOF shape from the original file.
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(content);
  if (!fmMatch) return { content, rewrote: false };
  const fmBody = fmMatch[1];
  const fmTrailer = fmMatch[2];
  const fmStart = fmMatch.index;
  const fmEnd = fmStart + fmMatch[0].length;

  // Find a top-level `id:` line. Top-level means the line begins at
  // column 0 inside the frontmatter body (no leading whitespace) and the
  // key is exactly `id`. We deliberately accept `id:` and `id : ` shapes
  // but reject `nested_id:` to avoid touching unrelated keys.
  const idLineRe = /^id:[ \t]*([^\r\n]*)$/m;
  const idMatch = idLineRe.exec(fmBody);
  if (!idMatch) return { content, rewrote: false };

  const newId = mintForkId(capsuleId, idMatch[1]?.trim() ?? "", now);
  const replacedBody = fmBody.replace(idLineRe, `id: ${newId}`);
  // Reconstruct the file: original prefix (always empty here, fmStart === 0
  // by the `^` anchor) + frontmatter delimiters around the rewritten body.
  // Use the detected `eol` for the opening/closing `---` lines so that CRLF
  // files remain CRLF and LF files remain LF, preserving byte-content fidelity
  // (Cursor thread #741 line 467).  The captured `fmTrailer` (the newline
  // immediately after the closing `---`, or end-of-string) is re-emitted
  // verbatim so the byte immediately after the closing fence is unchanged.
  const prefix = content.slice(0, fmStart);
  const tail = content.slice(fmEnd);
  const rebuilt = `${prefix}---${eol}${replacedBody}${eol}---${fmTrailer}${tail}`;
  return { content: rebuilt, rewrote: true };
}

/**
 * Derive a deterministic-when-`now`-is-set fork id from the capsule id and
 * the original record id. Production callers omit `now` and get a UUID
 * suffix; tests pass `now` for byte-stable assertions.
 */
function mintForkId(capsuleId: string, originalId: string, now: number | undefined): string {
  const base = originalId.length > 0 ? originalId : "fork";
  if (now === undefined) {
    const suffix = randomUUID().slice(0, 8);
    return `${base}-fork-${capsuleId}-${suffix}`;
  }
  // Deterministic suffix: short hash of (capsuleId, originalId, now). Using
  // sha256 over a sorted-key serialization (gotcha #38) so the suffix does
  // not depend on Object.entries order.
  const payload = JSON.stringify({ c: capsuleId, i: originalId, n: now });
  const suffix = createHash("sha256").update(payload, "utf-8").digest("hex").slice(0, 8);
  return `${base}-fork-${capsuleId}-${suffix}`;
}

// Note: `CapsuleBlock` is re-exported here purely so callers that want to
// inspect the manifest block don't have to deep-import from `./types.js`.
export type { CapsuleBlock };
