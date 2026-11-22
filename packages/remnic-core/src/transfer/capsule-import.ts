import { lstat, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { bumpMemoryCorpusVersionForDir } from "../memory-corpus-version.js";
import {
  HistoricalEntityCanonicalIdCache,
  readEntityRefFromFrontmatter,
  canonicalizeEntityRefFrontmatter,
  classifyEntityRefWritePath,
  repairContentAfterJournalMove,
  requestEntityCanonicalIdReconcile,
} from "../storage/entity-canonical-id-references.js";
import { withRawEntityPageMutation } from "../storage/entity-canonical-id-lock.js";
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
import { gunzipCapsuleArchive } from "./capsule-gunzip.js";

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
  if (mode !== "skip" && mode !== "overwrite" && mode !== "fork") {
    throw new Error(
      `importCapsule: unknown mode ${JSON.stringify(mode)}; expected "skip", "overwrite", or "fork"`,
    );
  }

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
  const json = gunzipCapsuleArchive(raw, "importCapsule", archiveAbs);
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
    throw new Error(
      "importCapsule: archive is V1; only V2 capsule archives are supported",
    );
  }
  const bundle = parsed.bundle as { manifest: ExportManifestV2; records: ExportMemoryRecordV1[] };
  const manifest = bundle.manifest;
  const capsule = manifest.capsule;

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

  const rootReal = await realpath(rootAbs).catch(() => rootAbs);

  const seenTargetPaths = new Map<string, string>();

  for (const rec of bundle.records) {
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

    //
    const targetRel = computeTargetPath(rec.path, mode, capsule.id);
    const targetAbs = path.join(rootReal, fromPosixRelPath(targetRel));
    if (!isPathInsideRoot(rootReal, targetAbs)) {
      throw new Error(
        `importCapsule: record path escapes target root: ${rec.path}`,
      );
    }

    await assertRealpathInsideRoot(rootReal, targetAbs, rec.path, "importCapsule");

    const targetLstat = await lstat(targetAbs).catch(() => null);
    if (targetLstat !== null && targetLstat.isSymbolicLink()) {
      throw new Error(
        `importCapsule: record target is a symlink and cannot be written to safely: ${rec.path}`,
      );
    }

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
  for (const f of manifest.files) {
    if (!recordPaths.has(f.path)) {
      throw new Error(
        `importCapsule: archive checksum mismatch (manifest entry without record: ${f.path})`,
      );
    }
  }

  const imported: ImportCapsuleImportedRecord[] = [];
  const skipped: ImportCapsuleSkippedRecord[] = [];
  const journalStateDir = path.join(rootReal, "state");
  const historicalIdCache = new HistoricalEntityCanonicalIdCache();
  const capsuleEntityIds = new Set(
    bundle.records
      .map((record) => computeTargetPath(record.path, mode, capsule.id))
      .filter((rel) => classifyEntityRefWritePath(rootReal, path.join(rootReal, fromPosixRelPath(rel))) === "entity")
      .map((rel) => path.basename(rel, ".md")),
  );

  const sortedRecords = [...bundle.records].sort((a, b) =>
    a.path.localeCompare(b.path),
  );

  let reconcileNeeded = false;
  const applyRecords = async (): Promise<void> => {
  for (const rec of sortedRecords) {
    const targetRel = computeTargetPath(rec.path, mode, capsule.id);
    const targetAbs = path.join(rootReal, fromPosixRelPath(targetRel));

    const exists = await fileExistsAt(targetAbs);

    if ((mode === "skip" || mode === "fork") && exists) {
      skipped.push({ path: rec.path, reason: "exists" });
      continue;
    }

    let snapshotted = false;
    if (mode === "overwrite" && exists) {
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
      const forked = rewriteFrontmatterIdForFork(contentToWrite, capsule.id, opts.now);
      contentToWrite = forked.content;
      rewroteId = forked.rewrote;
    }

    await mkdir(path.dirname(targetAbs), { recursive: true });
    const targetKind = classifyEntityRefWritePath(rootReal, targetAbs);
    const rawRef = targetKind === "memory" ? readEntityRefFromFrontmatter(contentToWrite) : null;
    if (targetKind === "memory" && rawRef !== null && capsuleEntityIds.has(rawRef)) {
      await writeFile(targetAbs, contentToWrite, "utf-8");
      reconcileNeeded = true;
    } else if (targetKind === "memory") {
      const idsAtWrite = historicalIdCache.get(journalStateDir);
      const rawRecord = contentToWrite;
      contentToWrite = canonicalizeEntityRefFrontmatter(rawRecord, idsAtWrite);
      const originalBytes = await readFile(targetAbs, "utf-8").catch(() => null);
      await writeFile(targetAbs, contentToWrite, "utf-8");
      try {
        await repairContentAfterJournalMove({
          stateDir: journalStateDir,
          cache: historicalIdCache,
          idsAtWrite,
          rawContent: rawRecord,
          lastWritten: contentToWrite,
          rewrite: (content) => writeFile(targetAbs, content, "utf-8"),
        });
      } catch (err) {
        if (originalBytes === null) {
          await unlink(targetAbs).catch(() => undefined);
        } else {
          await writeFile(targetAbs, originalBytes, "utf-8").catch(() => undefined);
        }
        throw err;
      }
    } else {
      await writeFile(targetAbs, contentToWrite, "utf-8");
      if (targetKind === "entity") {
        reconcileNeeded = true;
      }
    }
    bumpMemoryCorpusVersionForDir(rootReal);
    imported.push({
      sourcePath: rec.path,
      targetPath: targetRel,
      snapshotted,
      rewroteId,
    });
  }

  if (reconcileNeeded) {
    await requestEntityCanonicalIdReconcile(journalStateDir);
  }
  };
  const firstEntityId = capsuleEntityIds.values().next().value;
  if (firstEntityId === undefined) {
    await applyRecords();
  } else {
    await withRawEntityPageMutation(
      rootReal,
      path.join(rootReal, "entities", `${firstEntityId}.md`),
      applyRecords,
    );
  }

  skipped.sort((a, b) => a.path.localeCompare(b.path));


  return { imported, skipped, manifest };
}

// ---------------------------------------------------------------------------
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
// ---------------------------------------------------------------------------

function rewriteFrontmatterIdForFork(
  content: string,
  capsuleId: string,
  now: number | undefined,
): { content: string; rewrote: boolean } {
  const crlfMatch = /^---(\r\n|\r|\n)/.exec(content);
  const eol = crlfMatch ? crlfMatch[1] : "\n";

  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(content);
  if (!fmMatch) return { content, rewrote: false };
  const fmBody = fmMatch[1];
  const fmTrailer = fmMatch[2];
  const fmStart = fmMatch.index;
  const fmEnd = fmStart + fmMatch[0].length;

  const idLineRe = /^id:[ \t]*([^\r\n]*)$/m;
  const idMatch = idLineRe.exec(fmBody);
  if (!idMatch) return { content, rewrote: false };

  const newId = mintForkId(capsuleId, idMatch[1]?.trim() ?? "", now);
  const replacedBody = fmBody.replace(idLineRe, `id: ${newId}`);
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
  const payload = JSON.stringify({ c: capsuleId, i: originalId, n: now });
  const suffix = createHash("sha256").update(payload, "utf-8").digest("hex").slice(0, 8);
  return `${base}-fork-${capsuleId}-${suffix}`;
}

// Note: `CapsuleBlock` is re-exported here purely so callers that want to
// inspect the manifest block don't have to deep-import from `./types.js`.
export type { CapsuleBlock };
