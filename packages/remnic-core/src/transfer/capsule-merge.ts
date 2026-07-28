import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { bumpMemoryCorpusVersionForDir } from "../memory-corpus-version.js";
import {
  HistoricalEntityCanonicalIdCache,
  canonicalizeEntityRefFrontmatter,
  classifyEntityRefWritePath,
  repairContentAfterJournalMove,
  requestEntityCanonicalIdReconcile,
} from "../storage/entity-canonical-id-references.js";
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

/**
 * Three-way conflict-resolution mode for {@link mergeCapsule}.
 *
 * A "conflict" is defined as: the same memory-file path exists in both the
 * source archive and the target directory AND the content hash of the local
 * file differs from the archive's manifest entry for that path.
 *
 * Files that exist only in the archive (no local counterpart) are always
 * written regardless of mode — there is no conflict to resolve.
 *
 * Files that are byte-identical (same content hash in both locations) are
 * recorded as {@link MergeCapsuleResult.skipped} with reason `"identical"` and
 * are never re-written regardless of mode; this is a no-op optimisation rather
 * than a conflict.
 *
 *  - `"skip-conflicts"` (default) — log the conflict, skip the conflicting
 *    archive entries, but continue importing non-conflicting entries. The
 *    resulting merge is the union of:
 *      - all non-conflicting archive files (written to target)
 *      - all pre-existing local files (left unchanged)
 *
 *  - `"prefer-source"` — for conflicting files, snapshot the local content via
 *    page-versioning (gotcha #54: snapshot before overwrite) then overwrite
 *    with the archive content.
 *
 *  - `"prefer-local"` — for conflicting files, keep the local content; the
 *    archive entry is skipped.
 */
export type MergeCapsuleConflictMode =
  | "skip-conflicts"
  | "prefer-source"
  | "prefer-local";

/**
 * Options accepted by {@link mergeCapsule}.
 *
 * `sourceArchive` — absolute or cwd-relative path to a `.capsule.json.gz`
 * archive produced by `exportCapsule`. Must be a V2 bundle.
 *
 * `targetRoot` — absolute or cwd-relative path to the memory directory that
 * receives the merged records. Must be an existing, non-symlink directory.
 *
 * `conflictMode` — see {@link MergeCapsuleConflictMode}. Defaults to
 * `"skip-conflicts"`.
 *
 * `versioning` — optional page-versioning config forwarded to
 * {@link createVersion} in `"prefer-source"` mode. When omitted or disabled,
 * overwrites proceed without snapshotting (not recommended for production).
 *
 * `log` — optional logger forwarded to {@link createVersion}.
 */
export interface MergeCapsuleOptions {
  sourceArchive: string;
  targetRoot: string;
  conflictMode?: MergeCapsuleConflictMode;
  versioning?: VersioningConfig;
  log?: VersioningLogger;
}

export interface MergeCapsuleWrittenRecord {
  /** Capsule-relative posix path. */
  sourcePath: string;
  /** Memory-dir-relative posix path written on disk. */
  targetPath: string;
  /** Whether a page-versioning snapshot was taken before overwriting. */
  snapshotted: boolean;
}

export interface MergeCapsuleSkippedRecord {
  /** Capsule-relative posix path. */
  path: string;
  /**
   * Why the archive entry was not written.
   *
   * `"conflict"` — the entry existed locally with different content and the
   * active mode did not resolve the conflict with a write (`"skip-conflicts"` /
   * `"prefer-local"`).
   *
   * `"identical"` — the entry's content hash matches what is already on disk;
   * no write is needed.
   */
  reason: "conflict" | "identical";
}

export interface MergeCapsuleConflictRecord {
  /** Capsule-relative posix path of the conflicting entry. */
  path: string;
  /** SHA-256 of the archive's copy. */
  archiveSha256: string;
  /** SHA-256 of the local copy. */
  localSha256: string;
}

export interface MergeCapsuleResult {
  /** Records that were written to the target directory. */
  merged: MergeCapsuleWrittenRecord[];
  /**
   * Records that were NOT written (conflict skipped, or byte-identical).
   * Includes conflicts that were resolved by `"prefer-local"`.
   */
  skipped: MergeCapsuleSkippedRecord[];
  /**
   * Metadata about every detected conflict, regardless of which mode resolved
   * it. Callers can use this to report "N conflicts encountered; M overwritten".
   */
  conflicts: MergeCapsuleConflictRecord[];
  /** The manifest decoded from the archive. */
  manifest: ExportManifestV2;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Merge a V2 capsule archive into an existing memory directory using
 * three-way conflict semantics.
 *
 * Sequence:
 *   1. Read + gunzip + JSON.parse the archive.
 *   2. Validate through `parseExportBundle` (V1 rejected).
 *   3. Verify every record's content sha256 against the manifest.
 *      Any mismatch aborts BEFORE any file is written (gotcha #25).
 *   4. Classify each record as: new (no local copy), identical (same hash),
 *      or conflicting (different hash).
 *   5. Apply the selected {@link MergeCapsuleConflictMode} to conflicting
 *      entries; always write new entries; always skip identical entries.
 *
 * Determinism: `merged`, `skipped`, and `conflicts` are all returned sorted
 * by `path`/`sourcePath` so callers get stable output regardless of bundle
 * order.
 */
export async function mergeCapsule(
  opts: MergeCapsuleOptions,
): Promise<MergeCapsuleResult> {
  const archiveAbs = path.resolve(opts.sourceArchive);
  const rootAbs = path.resolve(opts.targetRoot);

  await assertIsDirectoryNotSymlink(rootAbs, "mergeCapsule", "targetRoot");

  const conflictMode: MergeCapsuleConflictMode =
    opts.conflictMode ?? "skip-conflicts";

  // Rule 51: reject invalid conflictMode values up-front before any I/O.
  if (
    conflictMode !== "skip-conflicts" &&
    conflictMode !== "prefer-source" &&
    conflictMode !== "prefer-local"
  ) {
    throw new Error(
      `mergeCapsule: unknown conflictMode ${JSON.stringify(conflictMode)}; ` +
        `expected "skip-conflicts", "prefer-source", or "prefer-local"`,
    );
  }

  // ---------------------------------------------------------------------------
  // Parse + validate archive
  // ---------------------------------------------------------------------------

  const raw = await readFile(archiveAbs);
  let json: string;
  try {
    json = gunzipSync(raw).toString("utf-8");
  } catch (cause) {
    throw new Error(
      `mergeCapsule: archive is not a valid gzip file: ${archiveAbs}`,
      { cause: cause as Error },
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch (cause) {
    throw new Error(
      `mergeCapsule: archive is not valid JSON after gunzip: ${archiveAbs}`,
      { cause: cause as Error },
    );
  }

  const parsed = parseExportBundle(parsedJson);
  if (parsed.capsuleVersion !== 2) {
    throw new Error(
      "mergeCapsule: archive is V1; only V2 capsule archives are supported",
    );
  }

  const bundle = parsed.bundle as {
    manifest: ExportManifestV2;
    records: ExportMemoryRecordV1[];
  };
  const manifest = bundle.manifest;
  const capsule = manifest.capsule;

  // Build path → manifest entry index for O(1) checksum lookup.
  const manifestIndex = new Map<string, ExportManifestV2["files"][number]>();
  for (const f of manifest.files) {
    manifestIndex.set(f.path, f);
  }
  if (manifestIndex.size !== manifest.files.length) {
    throw new Error("mergeCapsule: manifest contains duplicate file paths");
  }

  const recordPaths = new Set<string>();
  for (const rec of bundle.records) {
    if (recordPaths.has(rec.path)) {
      throw new Error(
        `mergeCapsule: bundle contains duplicate record path: ${rec.path}`,
      );
    }
    recordPaths.add(rec.path);
  }

  // ---------------------------------------------------------------------------
  // Phase 1: verify checksums + validate paths before ANY filesystem mutation.
  // (gotcha #25: don't destroy old state before confirming new state succeeds)
  // ---------------------------------------------------------------------------

  const rootReal = await realpath(rootAbs).catch(() => rootAbs);

  // Tracks normalized, case-folded target paths seen so far in phase 1.  Maps
  // targetAbs.toLowerCase() → first source path so the collision error can name
  // both offending entries.  Two manifest entries whose computed target paths
  // normalise to the same absolute path (e.g. `subdir/file.md` and
  // `subdir/./file.md`, or differing case on case-insensitive filesystems such
  // as macOS and Windows) would both refer to the same inode.  In
  // `skip-conflicts`/`prefer-local` modes one entry would be misclassified as a
  // local conflict against the OTHER entry's just-written content; in
  // `prefer-source` the second entry would silently overwrite the first.  We
  // reject the import up-front before any write (Codex P2 thread on PR #748,
  // mirroring `capsule-import.ts`).
  const seenTargetPaths = new Map<string, string>();

  for (const rec of bundle.records) {
    // Checksum validation.
    const entry = manifestIndex.get(rec.path);
    if (!entry) {
      throw new Error(
        `mergeCapsule: archive checksum mismatch (record without manifest entry: ${rec.path})`,
      );
    }
    const { sha256, bytes } = sha256String(rec.content);
    if (sha256 !== entry.sha256 || bytes !== entry.bytes) {
      throw new Error(
        `mergeCapsule: archive checksum mismatch for ${rec.path}: ` +
          `expected sha256=${entry.sha256} bytes=${entry.bytes}, ` +
          `got sha256=${sha256} bytes=${bytes}`,
      );
    }

    // Path-traversal validation (mirrors capsule-import.ts).
    if (rec.path.includes("\\")) {
      throw new Error(
        `mergeCapsule: record path contains backslash separators (Windows-style paths are not allowed): ${rec.path}`,
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
        `mergeCapsule: record path escapes target root: ${rec.path}`,
      );
    }

    // Lexical root containment check.
    const targetAbs = path.join(rootReal, fromPosixRelPath(rec.path));
    if (!isPathInsideRoot(rootReal, targetAbs)) {
      throw new Error(
        `mergeCapsule: record path escapes target root: ${rec.path}`,
      );
    }

    // Symlink-aware containment check (shared helper from fs-utils).
    await assertRealpathInsideRoot(rootReal, targetAbs, rec.path, "mergeCapsule");

    // Target-file symlink guard: if the target already exists as a symlink,
    // reject — writes through symlinks can redirect to unexpected locations.
    const targetLstat = await lstat(targetAbs).catch(() => null);
    if (targetLstat !== null && targetLstat.isSymbolicLink()) {
      throw new Error(
        `mergeCapsule: record target is a symlink and cannot be written to safely: ${rec.path}`,
      );
    }

    // Duplicate normalized target path detection (Codex P2 #748, mirrors
    // capsule-import.ts).  `path.join` already normalises `.` segments
    // (e.g. `subdir/./file.md` → `subdir/file.md`).  On case-insensitive
    // filesystems (macOS default, Windows), two paths that differ only in case
    // would resolve to the same inode.  We fold the dedup key to lowercase so
    // that `subdir/File.md` and `subdir/file.md` are detected as duplicates
    // before any write occurs.  This is intentionally unconditional: the cost
    // of an extra `.toLowerCase()` on case-sensitive filesystems is negligible,
    // and a defensive lowercase is far simpler than probing filesystem
    // case-sensitivity at runtime.  Without this guard, prefer-source mode
    // would silently overwrite one entry with the other, and skip-conflicts /
    // prefer-local would misclassify the second entry as a local conflict
    // against the first entry's freshly written content.
    const dedupKey = targetAbs.toLowerCase();
    const firstSourcePath = seenTargetPaths.get(dedupKey);
    if (firstSourcePath !== undefined) {
      throw new Error(
        `mergeCapsule: manifest contains two entries that resolve to the same target path: ` +
          `"${firstSourcePath}" and "${rec.path}" both map to "${rec.path}"`,
      );
    }
    seenTargetPaths.set(dedupKey, rec.path);
  }

  // Detect manifest-only entries (missing record). Treat as corruption.
  for (const f of manifest.files) {
    if (!recordPaths.has(f.path)) {
      throw new Error(
        `mergeCapsule: archive checksum mismatch (manifest entry without record: ${f.path})`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 2: classify records and apply conflict mode.
  // ---------------------------------------------------------------------------

  const merged: MergeCapsuleWrittenRecord[] = [];
  const skipped: MergeCapsuleSkippedRecord[] = [];
  const conflicts: MergeCapsuleConflictRecord[] = [];
  // Same write-boundary rule as capsule-import (issue #2213): records land
  // with their entityRef resolved through the target's migration journal,
  // read through the identity-keyed cache PER RECORD so a peer migration
  // completing mid-merge is picked up for every record written after it.
  const journalStateDir = path.join(rootReal, "state");
  const historicalIdCache = new HistoricalEntityCanonicalIdCache();
  // Write a record with its entityRef resolved AT the write, then repair if
  // the journal moved across the write itself — a parked mapping cannot be
  // fixed after the fact by the reconcile pass (issue #2213). Only memory-tier
  // records canonicalize; entities/ pages carry relationship TARGETS only
  // rewriteRelationshipTargets understands, so they merge byte-faithful with
  // a reconcile marker; everything else merges losslessly. The corpus bump
  // lands AFTER the repair so a warm cache rescan never captures pre-repair
  // bytes.
  const writeCanonicalRecord = async (targetAbs: string, rawContent: string): Promise<void> => {
    const kind = classifyEntityRefWritePath(rootReal, targetAbs);
    if (kind !== "memory") {
      await writeFile(targetAbs, rawContent, "utf-8");
      if (kind === "entity") {
        await requestEntityCanonicalIdReconcile(journalStateDir);
      }
      bumpMemoryCorpusVersionForDir(rootReal); // per-write bump (Cursor Medium, #1902)
      return;
    }
    const idsAtWrite = historicalIdCache.get(journalStateDir);
    const written = canonicalizeEntityRefFrontmatter(rawContent, idsAtWrite);
    await writeFile(targetAbs, written, "utf-8");
    await repairContentAfterJournalMove({
      stateDir: journalStateDir,
      cache: historicalIdCache,
      idsAtWrite,
      rawContent,
      lastWritten: written,
      rewrite: (content) => writeFile(targetAbs, content, "utf-8"),
    });
    bumpMemoryCorpusVersionForDir(rootReal); // per-write bump (Cursor Medium, #1902)
  };

  // Sort by source path for deterministic output (mirrors capsule-import.ts).
  const sortedRecords = [...bundle.records].sort((a, b) =>
    a.path.localeCompare(b.path),
  );

  for (const rec of sortedRecords) {
    const targetAbs = path.join(rootReal, fromPosixRelPath(rec.path));
    const entry = manifestIndex.get(rec.path)!; // validated above

    const localContent = await readLocalFile(targetAbs);

    if (localContent === null) {
      // No local copy — always write regardless of mode. Resolve at the write
      // itself and verify the journal afterwards: a peer migration completing
      // during any of these awaits (or the write) would otherwise strand the
      // reference — capsule writes bump only the corpus version, which the
      // migration fingerprint deliberately ignores.
      await mkdir(path.dirname(targetAbs), { recursive: true });
      await writeCanonicalRecord(targetAbs, rec.content);
      merged.push({ sourcePath: rec.path, targetPath: rec.path, snapshotted: false });
      continue;
    }

    // Local file exists. A local copy already holding the CANONICALIZED form
    // (computed AFTER the local read, so a journal published during that
    // await is reflected) is done. A local copy matching the RAW archive
    // bytes while a mapping applies is UPGRADED in place — skipping would
    // leave the legacy entityRef on disk forever, since corpus bumps no
    // longer trigger migration rewrites (issue #2213).
    const idsAtCompare = historicalIdCache.get(journalStateDir);
    const canonicalContent = classifyEntityRefWritePath(rootReal, targetAbs) === "memory"
      ? canonicalizeEntityRefFrontmatter(rec.content, idsAtCompare)
      : rec.content;
    const { sha256: localSha256 } = sha256String(localContent);
    const canonicalSha256 =
      canonicalContent === rec.content ? entry.sha256 : sha256String(canonicalContent).sha256;

    // The identical verdict is only valid for the snapshot it was computed
    // under (Codex P1): a mapping parked/removed mid-compare can make the
    // local copy's formerly-canonical ref stale with nothing left to repair
    // it. A moved journal falls through to the write path, which resolves at
    // the write and repairs after it.
    if (localSha256 === canonicalSha256 && historicalIdCache.get(journalStateDir) === idsAtCompare) {
      skipped.push({ path: rec.path, reason: "identical" });
      continue;
    }
    if (localSha256 === canonicalSha256 || localSha256 === entry.sha256) {
      await writeCanonicalRecord(targetAbs, rec.content);
      merged.push({ sourcePath: rec.path, targetPath: rec.path, snapshotted: false });
      continue;
    }

    // Content differs → conflict.
    const { sha256: archiveSha256 } = sha256String(rec.content);
    conflicts.push({
      path: rec.path,
      archiveSha256,
      localSha256,
    });

    if (conflictMode === "skip-conflicts" || conflictMode === "prefer-local") {
      // Keep local copy, skip archive entry.
      skipped.push({ path: rec.path, reason: "conflict" });
      continue;
    }

    // conflictMode === "prefer-source": snapshot local then overwrite.
    let snapshotted = false;
    if (opts.versioning && opts.versioning.enabled) {
      // Gotcha #54: snapshot BEFORE overwriting.
      await createVersion(
        targetAbs,
        localContent,
        "manual",
        opts.versioning,
        opts.log,
        `capsule-merge: ${capsule.id}`,
        rootReal,
      );
      snapshotted = true;
    }

    // Same write-time re-resolve + post-write repair as above — the
    // snapshot/read awaits give a peer migration a real window.
    await writeCanonicalRecord(targetAbs, rec.content);
    merged.push({ sourcePath: rec.path, targetPath: rec.path, snapshotted });
  }

  // Sort output lists for determinism.
  merged.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  conflicts.sort((a, b) => a.path.localeCompare(b.path));

  // Per-write corpus bumps happen inside the loop above (Cursor Medium, #1902):
  // a concurrent readAllMemories during the merge rescans and never serves the
  // pre-merge corpus mid-batch.

  return { merged, skipped, conflicts, manifest };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function readLocalFile(absPath: string): Promise<string | null> {
  const st = await stat(absPath).catch(() => null);
  if (!st || !st.isFile()) return null;
  return readFile(absPath, "utf-8");
}

// Re-export CapsuleBlock so callers don't need a deep import from types.ts.
export type { CapsuleBlock };
