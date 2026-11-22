import { lstat, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { bumpMemoryCorpusVersionForDir } from "../memory-corpus-version.js";
import {
  HistoricalEntityCanonicalIdCache,
  canonicalizeEntityRefFrontmatter,
  readEntityRefFromFrontmatter,
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
import { gunzipCapsuleArchive } from "./capsule-gunzip.js";

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
  // ---------------------------------------------------------------------------

  const raw = await readFile(archiveAbs);
  const json = gunzipCapsuleArchive(raw, "mergeCapsule", archiveAbs);

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
  // ---------------------------------------------------------------------------

  const rootReal = await realpath(rootAbs).catch(() => rootAbs);

  const seenTargetPaths = new Map<string, string>();

  for (const rec of bundle.records) {
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

    const targetAbs = path.join(rootReal, fromPosixRelPath(rec.path));
    if (!isPathInsideRoot(rootReal, targetAbs)) {
      throw new Error(
        `mergeCapsule: record path escapes target root: ${rec.path}`,
      );
    }

    await assertRealpathInsideRoot(rootReal, targetAbs, rec.path, "mergeCapsule");

    const targetLstat = await lstat(targetAbs).catch(() => null);
    if (targetLstat !== null && targetLstat.isSymbolicLink()) {
      throw new Error(
        `mergeCapsule: record target is a symlink and cannot be written to safely: ${rec.path}`,
      );
    }

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

  for (const f of manifest.files) {
    if (!recordPaths.has(f.path)) {
      throw new Error(
        `mergeCapsule: archive checksum mismatch (manifest entry without record: ${f.path})`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------

  const merged: MergeCapsuleWrittenRecord[] = [];
  const skipped: MergeCapsuleSkippedRecord[] = [];
  const conflicts: MergeCapsuleConflictRecord[] = [];
  const journalStateDir = path.join(rootReal, "state");
  const historicalIdCache = new HistoricalEntityCanonicalIdCache();
  const capsuleEntityIds = new Set(
    bundle.records
      .filter((record) =>
        classifyEntityRefWritePath(rootReal, path.join(rootReal, fromPosixRelPath(record.path))) === "entity")
      .map((record) => path.basename(record.path, ".md")),
  );
  let reconcileNeeded = false;
  const writeCanonicalRecord = async (targetAbs: string, rawContent: string): Promise<void> => {
    const kind = classifyEntityRefWritePath(rootReal, targetAbs);
    const rawRef = kind === "memory" ? readEntityRefFromFrontmatter(rawContent) : null;
    if (kind === "memory" && rawRef !== null && capsuleEntityIds.has(rawRef)) {
      await writeFile(targetAbs, rawContent, "utf-8");
      reconcileNeeded = true;
      bumpMemoryCorpusVersionForDir(rootReal); // per-write bump (Cursor Medium, #1902)
      return;
    }
    if (kind !== "memory") {
      await writeFile(targetAbs, rawContent, "utf-8");
      if (kind === "entity") {
        reconcileNeeded = true;
      }
      bumpMemoryCorpusVersionForDir(rootReal); // per-write bump (Cursor Medium, #1902)
      return;
    }
    const idsAtWrite = historicalIdCache.get(journalStateDir);
    const written = canonicalizeEntityRefFrontmatter(rawContent, idsAtWrite);
    const originalBytes = await readLocalFile(targetAbs);
    await writeFile(targetAbs, written, "utf-8");
    try {
      await repairContentAfterJournalMove({
        stateDir: journalStateDir,
        cache: historicalIdCache,
        idsAtWrite,
        rawContent,
        lastWritten: written,
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
    bumpMemoryCorpusVersionForDir(rootReal); // per-write bump (Cursor Medium, #1902)
  };

  const sortedRecords = [...bundle.records].sort((a, b) =>
    a.path.localeCompare(b.path),
  );

  const applyRecords = async (): Promise<void> => {
  for (const rec of sortedRecords) {
    const targetAbs = path.join(rootReal, fromPosixRelPath(rec.path));
    const entry = manifestIndex.get(rec.path)!; // validated above

    const localContent = await readLocalFile(targetAbs);

    if (localContent === null) {
      await mkdir(path.dirname(targetAbs), { recursive: true });
      await writeCanonicalRecord(targetAbs, rec.content);
      merged.push({ sourcePath: rec.path, targetPath: rec.path, snapshotted: false });
      continue;
    }

    const idsAtCompare = historicalIdCache.get(journalStateDir);
    const compareRef = readEntityRefFromFrontmatter(rec.content);
    const canonicalContent =
      classifyEntityRefWritePath(rootReal, targetAbs) === "memory"
      && !(compareRef !== null && capsuleEntityIds.has(compareRef))
        ? canonicalizeEntityRefFrontmatter(rec.content, idsAtCompare)
        : rec.content;
    const { sha256: localSha256 } = sha256String(localContent);
    const canonicalSha256 =
      canonicalContent === rec.content ? entry.sha256 : sha256String(canonicalContent).sha256;

    if (localSha256 === canonicalSha256 && historicalIdCache.get(journalStateDir) === idsAtCompare) {
      skipped.push({ path: rec.path, reason: "identical" });
      continue;
    }
    if (localSha256 === canonicalSha256 || localSha256 === entry.sha256) {
      await writeCanonicalRecord(targetAbs, rec.content);
      merged.push({ sourcePath: rec.path, targetPath: rec.path, snapshotted: false });
      continue;
    }

    const { sha256: archiveSha256 } = sha256String(rec.content);
    conflicts.push({
      path: rec.path,
      archiveSha256,
      localSha256,
    });

    if (conflictMode === "skip-conflicts" || conflictMode === "prefer-local") {
      skipped.push({ path: rec.path, reason: "conflict" });
      continue;
    }

    let snapshotted = false;
    if (opts.versioning && opts.versioning.enabled) {
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

    await writeCanonicalRecord(targetAbs, rec.content);
    merged.push({ sourcePath: rec.path, targetPath: rec.path, snapshotted });
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

  merged.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  conflicts.sort((a, b) => a.path.localeCompare(b.path));


  return { merged, skipped, conflicts, manifest };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

async function readLocalFile(absPath: string): Promise<string | null> {
  const st = await stat(absPath).catch(() => null);
  if (!st || !st.isFile()) return null;
  return readFile(absPath, "utf-8");
}

// Re-export CapsuleBlock so callers don't need a deep import from types.ts.
export type { CapsuleBlock };
