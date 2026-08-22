/**
 * Page-level versioning with history and revert (issue #371).
 *
 * Provides snapshot-based versioning for memory files using a sidecar
 * directory layout.  Each memory page gets a `.versions/<pageName>/`
 * subdirectory containing numbered snapshots and a `manifest.json` that
 * records the version history.
 *
 * Storage layout:
 *   memoryDir/
 *     facts/preferences.md              <- current file
 *     .versions/
 *       facts__preferences/
 *         manifest.json                  <- VersionHistory
 *         1.md                           <- version 1 snapshot
 *         2.md                           <- version 2 snapshot
 */

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
} from "node:fs/promises";
import { ALL_CATEGORY_DIRS, RECALL_FALLBACK_DIRS } from "./utils/category-dir.js";
import { bumpMemoryCorpusVersionForDir } from "./memory-corpus-version.js";
import {
  pathMayCarryEntityRefs,
  requestEntityCanonicalIdReconcile,
} from "./storage/entity-canonical-id-references.js";
import { withRawEntityPageMutation } from "./storage/entity-canonical-id-lock.js";
import { withHeldFileLock, type HeldFileLockController } from "./utils/serialize-mutations.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface PageVersion {
  versionId: string;
  timestamp: string;
  contentHash: string;
  sizeBytes: number;
  trigger: VersionTrigger;
  note?: string;
  /**
   * True while the snapshot is STAGED by a guarded write that has not yet
   * committed (issue #2330 round N+15 B). Pruning counts — and removes —
   * only committed snapshots: a pending entry belongs to a writer whose
   * compare-and-swap may still fail, so trading it for an older rollback
   * point would leave history short of the cap once that writer aborts
   * (removeVersion). The staging writer clears the flag when its write
   * commits (pruneVersions `committedVersionId`) or drops the entry; a
   * finalization that FAILS after the commit records the id via
   * recordStrandedCommit, and the next pruneVersions clears it (round
   * N+22).
   */
  pending?: boolean;
}

/**
 * Snapshot triggers. The runtime allow-list in `readManifest` is derived from
 * this array, so adding a trigger cannot leave a written manifest unreadable.
 */
export const VERSION_TRIGGERS = Object.freeze([
  "write",
  "consolidation",
  "revert",
  "manual",
  "semantic-merge",
] as const);
export type VersionTrigger = (typeof VERSION_TRIGGERS)[number];

export interface VersionHistory {
  pagePath: string;
  versions: PageVersion[];
  currentVersion: string;
}

export interface VersioningConfig {
  enabled: boolean;
  maxVersionsPerPage: number;
  sidecarDir: string;
}

// ---------------------------------------------------------------------------
// Logger interface (minimal, avoids coupling to the host logger)
// ---------------------------------------------------------------------------

export interface VersioningLogger {
  debug(msg: string): void;
  warn(msg: string): void;
}

const NOOP_LOGGER: VersioningLogger = {
  debug: () => {},
  warn: () => {},
};

// ---------------------------------------------------------------------------
// Per-page write lock (promise-chain pattern, see gotcha #40)
// ---------------------------------------------------------------------------

const writeLocks = new Map<string, Promise<void>>();

function withPageLock<T>(pageKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(pageKey) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn after previous completes, even if previous failed
  writeLocks.set(pageKey, next.then(() => {}, () => {})); // recover chain per gotcha #40
  return next;
}

// ---------------------------------------------------------------------------
// Cross-process manifest lock (issue #2330 round N+16 B)
// ---------------------------------------------------------------------------

// withPageLock serializes manifest mutations only within ONE Remnic process.
// Two processes sharing a memory directory could both read a manifest,
// compute the SAME next version id, and stage colliding snapshots — and a
// merge whose content CAS then lost called removeVersion on that shared id,
// deleting the WINNER's committed rollback point (and concurrent
// non-atomic manifest writes tore the JSON outright). The mutation now also
// holds a cross-process advisory lock — the established withHeldFileLock
// primitive, as a sibling `<manifest>.lock` file (the same `<data>.lock`
// placement tombstones.jsonl and fact-hashes.txt use). A lock that cannot be
// taken within the bounded wait FAILS the mutation: staging falls back to
// the create path, and removal/prune callers already treat a throw as
// non-fatal — no caller ever proceeds unsynchronized into the collision the
// lock exists to prevent.
const MANIFEST_LOCK_STALE_MS = 30_000;
const MANIFEST_LOCK_MAX_WAIT_MS = 10_000;

/**
 * A manifest mutation lost its advisory lock mid-section — a peer stale-broke
 * and replaced it, and the section must abort rather than publish over the
 * peer's committed mutation.
 */
class ManifestLockLostError extends Error {
  constructor(mPath: string) {
    super(
      `page-versioning: manifest lock for ${mPath} was lost mid-section — a peer stale-broke it; aborting so the peer's mutation survives`,
    );
    this.name = "ManifestLockLostError";
  }
}

/**
 * Revalidate lock ownership immediately before a destructive write (final
 * round B). The lock's mtime heartbeat is a TIMER — it cannot fire while the
 * process is paused past the stale window (CPU-bound section, suspended
 * machine), so a peer can break the lock and commit its own newer mutation
 * while THIS section still believes it holds it. Every mutation calls this
 * immediately before each destructive write (snapshot writeFile, manifest
 * rename, snapshot unlink) and aborts on loss — the same pattern the graph
 * JSONL lock adopted (GraphWriteLockSection / assertGraphLockHeld). A held
 * result also re-stamps the mtime, so the bounded write that follows cannot
 * itself be judged stale mid-write.
 */
async function assertManifestLockHeld(
  mPath: string,
  lock: HeldFileLockController,
): Promise<void> {
  if (!(await lock.refresh())) throw new ManifestLockLostError(mPath);
}

function withManifestLock<T>(
  mPath: string,
  fn: (lock: HeldFileLockController) => Promise<T>,
): Promise<T> {
  return withPageLock(mPath, () =>
    withHeldFileLock(
      `${mPath}.lock`,
      { staleMs: MANIFEST_LOCK_STALE_MS, maxWaitMs: MANIFEST_LOCK_MAX_WAIT_MS },
      async (acquired, lock) => {
        if (!acquired) {
          throw new Error(
            `page-versioning: could not acquire the manifest lock for ${mPath} within ${MANIFEST_LOCK_MAX_WAIT_MS}ms — another process holds it`,
          );
        }
        return fn(lock);
      },
    ),
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Derive a filesystem-safe sidecar key from a page path relative to memoryDir.
 *
 * `facts/2026-01-15/pref-001.md` -> `facts__2026-01-15__pref-001`
 *
 * Exported so the `remnic doctor` consolidation-provenance check (issue
 * #561 PR 4) resolves snapshot locations using the canonical algorithm
 * without re-implementing it — preventing silent drift if the key
 * format ever changes.
 */
export function sidecarKey(pagePath: string): string {
  const withoutExt = pagePath.replace(/\.md$/i, "");
  return withoutExt.replace(/[\\/]/g, "__");
}

function sidecarDir(memoryDir: string, sidecar: string, pagePath: string): string {
  return path.join(memoryDir, sidecar, sidecarKey(pagePath));
}

function manifestPath(memoryDir: string, sidecar: string, pagePath: string): string {
  return path.join(sidecarDir(memoryDir, sidecar, pagePath), "manifest.json");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(
  memoryDir: string,
  sidecar: string,
  pagePath: string,
): Promise<VersionHistory> {
  const mp = manifestPath(memoryDir, sidecar, pagePath);
  if (!(await fileExists(mp))) {
    return { pagePath, versions: [], currentVersion: "0" };
  }
  try {
    const raw = await readFile(mp, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("manifest root must be an object");
    }
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.versions)) {
      throw new Error("manifest versions must be an array");
    }
    const versions = obj.versions.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`manifest version ${index} must be an object`);
      }
      const version = entry as Record<string, unknown>;
      if (
        typeof version.versionId !== "string" ||
        !/^\d+$/.test(version.versionId) ||
        typeof version.timestamp !== "string" ||
        typeof version.contentHash !== "string" ||
        typeof version.sizeBytes !== "number" ||
        !Number.isFinite(version.sizeBytes) ||
        !(VERSION_TRIGGERS as readonly string[]).includes(String(version.trigger)) ||
        (version.pending !== undefined && typeof version.pending !== "boolean")
      ) {
        throw new Error(`manifest version ${index} has invalid shape`);
      }
      return version as unknown as PageVersion;
    });
    if (typeof obj.currentVersion !== "string" || !/^\d+$/.test(obj.currentVersion)) {
      throw new Error("manifest currentVersion must be a numeric string");
    }
    const currentVersion = obj.currentVersion;
    return { pagePath: typeof obj.pagePath === "string" ? obj.pagePath : pagePath, versions, currentVersion };
  } catch (error) {
    throw new Error(`page-versioning: invalid manifest ${mp}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeManifest(
  memoryDir: string,
  sidecar: string,
  pagePath: string,
  history: VersionHistory,
): Promise<void> {
  const dir = sidecarDir(memoryDir, sidecar, pagePath);
  await mkdir(dir, { recursive: true });
  const mp = manifestPath(memoryDir, sidecar, pagePath);
  // Final round (A): publish atomically — write the temp file, then rename
  // it over the manifest. A crash or transient failure can no longer leave a
  // torn or truncated manifest behind, and the publish-before-cleanup
  // ordering in every mutation guarantees a failed publication never strands
  // a manifest entry whose snapshot file is already gone.
  const tmp = `${mp}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(history, null, 2) + "\n", "utf8");
    await rename(tmp, mp);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

// Round N+22: stranded-commit marker. A finalization whose merge had
// ALREADY committed can still fail (manifest lock timeout, transient I/O),
// leaving its staged entry `pending` forever — pruneExcessVersions excludes
// pending entries, so every such failure stranded one unprunable snapshot
// and repeated failures grew history past maxVersionsPerPage. The failed
// finalization appends the (known-committed) version id to this marker (a
// sibling `<manifest>.stranded` file, one id per line); the next
// pruneVersions for the page reconciles those ids under the manifest lock.
// Append-only by design: a one-line O_APPEND write is atomic, and a
// clear-side rewrite could clobber an id appended by a finalization that
// just failed against the very lock the clear holds. Ids whose entry is gone
// or already committed are read-side no-ops, so stale lines cost one skipped
// lookup each and the file is bounded by finalization failures (one small
// line each). A writer that CRASHES mid-attempt records nothing — that case
// stays covered by the pending-exclusion itself.
async function readStrandedCommits(markerPath: string): Promise<string[]> {
  try {
    const raw = await readFile(markerPath, "utf-8");
    return raw.split("\n").filter((line) => /^\d+$/.test(line.trim()));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new version snapshot for a page.
 *
 * Call this BEFORE overwriting the current file so the previous content is
 * preserved. If the file does not exist yet (first write), the provided
 * `content` is snapshotted as version 1.
 *
 * Pruning: when the number of versions exceeds `config.maxVersionsPerPage`,
 * the oldest snapshots (and their files) are removed. Pass
 * `options.deferPrune` to stage the snapshot WITHOUT pruning and finalize
 * with {@link pruneVersions} once the guarded write that staged it commits —
 * a failed attempt then leaves the history untouched instead of discarding
 * the oldest rollback point (issue #2330 round N+11 C). A deferred snapshot
 * is recorded `pending` until its writer commits (round N+15 B); pruning
 * counts only committed snapshots, so no prune can trade another writer's
 * staged entry for an older rollback point.
 */
export async function createVersion(
  pagePath: string,
  content: string,
  trigger: VersionTrigger,
  config: VersioningConfig,
  log: VersioningLogger = NOOP_LOGGER,
  note?: string,
  memoryDir?: string,
  options?: { deferPrune?: boolean },
): Promise<PageVersion> {
  const { sidecarDir: sidecar, maxVersionsPerPage } = config;
  const resolvedMemoryDir = memoryDir ?? resolveMemoryDir(pagePath);
  const mPath = manifestPath(resolvedMemoryDir, sidecar, relPath(pagePath, resolvedMemoryDir));

  return withManifestLock(mPath, async (lock) => {
    const history = await readManifest(resolvedMemoryDir, sidecar, relPath(pagePath, resolvedMemoryDir));
    const nextId = String(history.versions.length > 0
      ? Math.max(...history.versions.map((v) => Number(v.versionId))) + 1
      : 1);

    const hash = contentHash(content);
    const version: PageVersion = {
      versionId: nextId,
      timestamp: new Date().toISOString(),
      contentHash: hash,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      trigger,
      ...(note !== undefined ? { note } : {}),
      ...(options?.deferPrune === true ? { pending: true } : {}),
    };

    const dir = sidecarDir(resolvedMemoryDir, sidecar, relPath(pagePath, resolvedMemoryDir));
    await mkdir(dir, { recursive: true });
    const ext = path.extname(pagePath) || ".md";
    const snapshotPath = path.join(dir, `${nextId}${ext}`);
    // Final round (B): revalidate ownership immediately before the staged
    // snapshot write — a peer that stale-broke the lock may have committed a
    // mutation reusing this id, and overwriting its file would corrupt the
    // peer's published rollback point.
    await assertManifestLockHeld(mPath, lock);
    await writeFile(snapshotPath, content, "utf8");

    history.versions.push(version);
    history.currentVersion = nextId;

    // Final round (A): the prune only COMPUTES the removal here; the
    // manifest publishes it (atomic rename), and only then are the pruned
    // snapshot files unlinked — a publication failure leaves the manifest
    // and the files exactly as they were, never a dangling reference.
    // The prune is skipped when the caller deferred it until its guarded
    // write commits (issue #2330 round N+11 C).
    const pruned = options?.deferPrune === true
      ? []
      : pruneExcessVersions(history, maxVersionsPerPage);
    await assertManifestLockHeld(mPath, lock);
    await writeManifest(resolvedMemoryDir, sidecar, relPath(pagePath, resolvedMemoryDir), history);
    await unlinkPublishedSnapshots(mPath, lock, dir, ext, pruned, log);
    log.debug(`page-versioning: created version ${nextId} for ${pagePath} (trigger=${trigger})`);

    return version;
  });
}

/**
 * Compute the excess COMMITTED snapshots and drop them from `history`,
 * returning the pruned entries WITHOUT touching any file — the caller
 * publishes the manifest first and unlinks the files only afterwards
 * ({@link unlinkPublishedSnapshots}, final round A). The caller holds the
 * manifest lock.
 */
function pruneExcessVersions(
  history: VersionHistory,
  maxVersionsPerPage: number,
): PageVersion[] {
  if (!(maxVersionsPerPage > 0)) return [];
  // Round N+15 (B): count only COMMITTED snapshots. Two concurrent merges
  // can both stage (deferPrune) before either commits; a prune that counted
  // the other writer's pending entry would drop one more rollback point
  // than the cap requires, and that writer's abort (removeVersion) then
  // leaves history SHORT of the cap. Pending entries are skipped entirely —
  // never counted, never removed. (ponytail: a writer that dies mid-attempt
  // leaves its entry pending forever — bounded by one entry per crash;
  // age-based expiry if crash loops ever make that matter. A finalization
  // that fails AFTER its merge committed no longer strands its entry —
  // pruneVersions reconciles those from the stranded-commit marker, round
  // N+22.)
  const excess =
    history.versions.filter((version) => version.pending !== true).length -
    maxVersionsPerPage;
  if (excess <= 0) return [];
  const toRemove = new Set<PageVersion>();
  for (const version of history.versions) {
    if (toRemove.size >= excess) break;
    if (version.pending === true) continue;
    toRemove.add(version);
  }
  history.versions = history.versions.filter((version) => !toRemove.has(version));
  return [...toRemove];
}

/**
 * Best-effort removal of snapshot files whose removal the manifest has
 * ALREADY published (final round A). Ownership is revalidated first: after a
 * lock loss, a peer's fresh mutation may have reused a removed id, and
 * unlinking its file would leave the PEER's manifest with a dangling
 * reference — so a lost lock aborts the cleanup (the caller surfaces the
 * error; the already-published manifest stays consistent, and the skipped
 * files are unreferenced orphans, never dangling references).
 */
async function unlinkPublishedSnapshots(
  mPath: string,
  lock: HeldFileLockController,
  dir: string,
  ext: string,
  pruned: PageVersion[],
  log: VersioningLogger,
): Promise<void> {
  if (pruned.length === 0) return;
  await assertManifestLockHeld(mPath, lock);
  for (const old of pruned) {
    const oldPath = path.join(dir, `${old.versionId}${ext}`);
    try {
      await unlink(oldPath);
    } catch {
      log.debug(`page-versioning: could not remove old snapshot ${oldPath}`);
    }
  }
}

/**
 * Finalize a deferred prune: drop the oldest COMMITTED snapshots (and their
 * files) until the history is back at `config.maxVersionsPerPage`. Call only
 * after the guarded write that staged the snapshot has committed — a failed
 * attempt never calls this, so it cannot discard rollback points. Pass
 * `options.committedVersionId` to clear the staging writer's `pending` flag
 * under the SAME page lock as the prune (round N+15 B): the entry becomes
 * countable exactly when — and only when — its writer's write has committed,
 * so a concurrent still-pending writer's entry is never counted or removed.
 *
 * Round N+22: each call also reconciles entries stranded by an EARLIER
 * finalization that failed after its merge committed (see
 * {@link recordStrandedCommit}) — their `pending` flags clear here, under
 * the same lock, so a transient finalization failure cannot permanently
 * exclude a committed snapshot from the prune bound.
 */
export async function pruneVersions(
  pagePath: string,
  config: VersioningConfig,
  log: VersioningLogger = NOOP_LOGGER,
  memoryDir?: string,
  options?: { committedVersionId?: string },
): Promise<void> {
  const resolvedMemoryDir = memoryDir ?? resolveMemoryDir(pagePath);
  const rel = relPath(pagePath, resolvedMemoryDir);
  const mPath = manifestPath(resolvedMemoryDir, config.sidecarDir, rel);
  await withManifestLock(mPath, async (lock) => {
    const history = await readManifest(resolvedMemoryDir, config.sidecarDir, rel);
    const before = history.versions.length;
    let committedCleared = false;
    if (options?.committedVersionId !== undefined) {
      const staged = history.versions.find(
        (version) =>
          version.versionId === options.committedVersionId && version.pending === true,
      );
      if (staged) {
        delete staged.pending;
        committedCleared = true;
      }
    }
    // Marker ids are known-COMMITTED by construction: only a finalization
    // failure for an already-committed merge records one, so clearing them
    // here can never trade away a concurrent still-pending writer's entry.
    let strandedCleared = 0;
    for (const id of await readStrandedCommits(`${mPath}.stranded`)) {
      const stranded = history.versions.find(
        (version) => version.versionId === id && version.pending === true,
      );
      if (stranded) {
        delete stranded.pending;
        strandedCleared += 1;
      }
    }
    // Final round (A): compute the prune, PUBLISH the manifest (atomic
    // rename), and only then unlink the pruned snapshot files best-effort —
    // a publication failure leaves manifest and files mutually consistent.
    const pruned = pruneExcessVersions(history, config.maxVersionsPerPage);
    if (history.versions.length !== before || committedCleared || strandedCleared > 0) {
      await assertManifestLockHeld(mPath, lock);
      await writeManifest(resolvedMemoryDir, config.sidecarDir, rel, history);
    }
    await unlinkPublishedSnapshots(
      mPath,
      lock,
      sidecarDir(resolvedMemoryDir, config.sidecarDir, rel),
      path.extname(pagePath) || ".md",
      pruned,
      log,
    );
    if (strandedCleared > 0) {
      log.debug(
        `page-versioning: reconciled ${strandedCleared} stranded committed snapshot(s) for ${pagePath}`,
      );
    }
  });
}

/**
 * Record that the guarded write behind `versionId` COMMITTED but its
 * finalizing prune failed (round N+22) — the entry's `pending` flag could
 * not be cleared, so without this record the snapshot stayed excluded from
 * pruning forever. The next {@link pruneVersions} for the page reconciles
 * the id from the marker. Best-effort: a marker-write failure is logged and
 * never thrown (the caller is already on an error path).
 */
export async function recordStrandedCommit(
  pagePath: string,
  config: VersioningConfig,
  versionId: string,
  log: VersioningLogger = NOOP_LOGGER,
  memoryDir?: string,
): Promise<void> {
  const resolvedMemoryDir = memoryDir ?? resolveMemoryDir(pagePath);
  const rel = relPath(pagePath, resolvedMemoryDir);
  try {
    await appendFile(
      `${manifestPath(resolvedMemoryDir, config.sidecarDir, rel)}.stranded`,
      `${versionId}\n`,
      "utf-8",
    );
  } catch (err) {
    log.warn(
      `page-versioning: could not record stranded commit ${versionId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Remove ONE version from the manifest and delete its snapshot file.
 * Idempotent: a version already gone (or never present) is a no-op.
 *
 * Used by guarded-write callers whose staged snapshot must not survive an
 * aborted attempt (issue #2330 round N+13 B): staging itself mutates
 * history, and without this rollback repeated failed attempts grow history
 * past `maxVersionsPerPage`, so a later successful commit's prune trades
 * real rollback states for duplicate failed-attempt snapshots of a body that
 * never changed. Never call this for a version a committed write relies on.
 * `currentVersion` returns to the newest remaining snapshot (or `"0"` when
 * history emptied) — never to a removed id.
 */
export async function removeVersion(
  pagePath: string,
  versionId: string,
  config: VersioningConfig,
  log: VersioningLogger = NOOP_LOGGER,
  memoryDir?: string,
): Promise<void> {
  const resolvedMemoryDir = memoryDir ?? resolveMemoryDir(pagePath);
  const rel = relPath(pagePath, resolvedMemoryDir);
  const mPath = manifestPath(resolvedMemoryDir, config.sidecarDir, rel);
  await withManifestLock(mPath, async (lock) => {
    const history = await readManifest(resolvedMemoryDir, config.sidecarDir, rel);
    const index = history.versions.findIndex((version) => version.versionId === versionId);
    if (index === -1) return;
    const removed = history.versions[index];
    history.versions.splice(index, 1);
    history.currentVersion = history.versions.length > 0
      ? String(Math.max(...history.versions.map((version) => Number(version.versionId))))
      : "0";
    // Final round (A): PUBLISH the manifest (atomic rename) BEFORE touching
    // the snapshot file. The old order unlinked first — a publication
    // failure (transient I/O, full disk) then left the on-disk manifest
    // referencing a now-missing snapshot: an unusable rollback entry that
    // getVersion/revert fail on and prune never cleans. Publish-first means
    // a failed publication leaves manifest AND file untouched; the unlink
    // only runs once the removal is durably published.
    await assertManifestLockHeld(mPath, lock);
    await writeManifest(resolvedMemoryDir, config.sidecarDir, rel, history);
    await unlinkPublishedSnapshots(
      mPath,
      lock,
      sidecarDir(resolvedMemoryDir, config.sidecarDir, rel),
      path.extname(pagePath) || ".md",
      [removed],
      log,
    );
    log.debug(`page-versioning: removed version ${versionId} for ${pagePath}`);
  });
}

/**
 * List all versions for a page.
 */
export async function listVersions(
  pagePath: string,
  config: VersioningConfig,
  memoryDir?: string,
): Promise<VersionHistory> {
  const resolvedMemoryDir = memoryDir ?? resolveMemoryDir(pagePath);
  const rel = relPath(pagePath, resolvedMemoryDir);
  const history = await readManifest(resolvedMemoryDir, config.sidecarDir, rel);
  // Sort ascending by versionId (numeric)
  history.versions.sort((a, b) => Number(a.versionId) - Number(b.versionId));
  return history;
}

/**
 * Read the content of a specific version.
 */
export async function getVersion(
  pagePath: string,
  versionId: string,
  config: VersioningConfig,
  memoryDir?: string,
): Promise<string> {
  const resolvedMemoryDir = memoryDir ?? resolveMemoryDir(pagePath);
  const rel = relPath(pagePath, resolvedMemoryDir);
  const ext = path.extname(pagePath) || ".md";
  const dir = sidecarDir(resolvedMemoryDir, config.sidecarDir, rel);
  const snapshotPath = path.join(dir, `${versionId}${ext}`);

  if (!(await fileExists(snapshotPath))) {
    throw new Error(`Version ${versionId} not found for ${pagePath}`);
  }

  return readFile(snapshotPath, "utf-8");
}

/**
 * Revert a page to a previous version.
 *
 * 1. Reads the target version's content.
 * 2. Snapshots the CURRENT content as a new version (trigger: "revert").
 * 3. Writes the reverted content to the page file.
 *
 * Returns the newly created version entry for the revert snapshot.
 */
export async function revertToVersion(
  pagePath: string,
  versionId: string,
  config: VersioningConfig,
  log: VersioningLogger = NOOP_LOGGER,
  memoryDir?: string,
): Promise<PageVersion> {
  const resolvedMemoryDir = memoryDir ?? resolveMemoryDir(pagePath);

  // Read target version content
  const targetContent = await getVersion(pagePath, versionId, config, resolvedMemoryDir);

  // Snapshot current content before overwriting
  let currentContent = "";
  try {
    currentContent = await readFile(pagePath, "utf-8");
  } catch {
    // File may not exist; that's okay
  }

  const version = await createVersion(
    pagePath,
    currentContent,
    "revert",
    config,
    log,
    `reverted to version ${versionId}`,
    resolvedMemoryDir,
  );

  await withRawEntityPageMutation(resolvedMemoryDir, pagePath, async () => {
    await writeFile(pagePath, targetContent, "utf-8");
  });
  const revertedTop = relPath(pagePath, resolvedMemoryDir).split(path.sep)[0];
  if ((RECALL_FALLBACK_DIRS as readonly string[]).includes(revertedTop)) {
    bumpMemoryCorpusVersionForDir(resolvedMemoryDir);
  }
  if (pathMayCarryEntityRefs(resolvedMemoryDir, pagePath)) {
    await requestEntityCanonicalIdReconcile(path.join(resolvedMemoryDir, "state"));
  }
  log.debug(`page-versioning: reverted ${pagePath} to version ${versionId}`);

  return version;
}

/**
 * Simple line-based diff between two versions.
 *
 * Returns a unified-style diff string showing added (+) and removed (-) lines.
 */
export async function diffVersions(
  pagePath: string,
  v1: string,
  v2: string,
  config: VersioningConfig,
  memoryDir?: string,
): Promise<string> {
  const resolvedMemoryDir = memoryDir ?? resolveMemoryDir(pagePath);
  const content1 = await getVersion(pagePath, v1, config, resolvedMemoryDir);
  const content2 = await getVersion(pagePath, v2, config, resolvedMemoryDir);

  const lines1 = content1.split("\n");
  const lines2 = content2.split("\n");

  const result: string[] = [];
  result.push(`--- version ${v1}`);
  result.push(`+++ version ${v2}`);

  // Simple LCS-based diff
  const lcs = computeLCS(lines1, lines2);
  let i = 0;
  let j = 0;
  let k = 0;

  while (k < lcs.length) {
    // Emit removed lines before the next common line
    while (i < lines1.length && lines1[i] !== lcs[k]) {
      result.push(`-${lines1[i]}`);
      i++;
    }
    // Emit added lines before the next common line
    while (j < lines2.length && lines2[j] !== lcs[k]) {
      result.push(`+${lines2[j]}`);
      j++;
    }
    // Common line
    result.push(` ${lcs[k]}`);
    i++;
    j++;
    k++;
  }
  // Remaining removed lines
  while (i < lines1.length) {
    result.push(`-${lines1[i]}`);
    i++;
  }
  // Remaining added lines
  while (j < lines2.length) {
    result.push(`+${lines2[j]}`);
    j++;
  }

  return result.join("\n");
}

// ---------------------------------------------------------------------------
// LCS helper for diffVersions
// ---------------------------------------------------------------------------

function computeLCS(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  // Build DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  // Backtrack to build LCS
  const result: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Legacy fallback: given an absolute page path, heuristically resolve the
 * memory directory by walking up past known subdirectory names.
 *
 * Callers should always pass an explicit `memoryDir` instead of relying on
 * this heuristic.  It is retained only for backward compatibility when the
 * optional `memoryDir` parameter is omitted.
 */
function resolveMemoryDir(pagePath: string): string {
  // Derive the recall category dirs from ALL_CATEGORY_DIRS (single source of
  // truth) so newly-routed categories (decisions/, preferences/, ...) are
  // recognized when walking up to the memory root (#1546); the non-category
  // subdirs are listed explicitly.
  const knownSubdirs = new Set<string>([
    ...ALL_CATEGORY_DIRS,
    "entities",
    "state",
    "artifacts",
    "profiles",
  ]);

  let dir = path.dirname(pagePath);
  // Walk up past date directories (YYYY-MM-DD) and known subdirs
  for (let depth = 0; depth < 5; depth++) {
    const base = path.basename(dir);
    if (knownSubdirs.has(base) || /^\d{4}-\d{2}-\d{2}$/.test(base)) {
      dir = path.dirname(dir);
    } else {
      break;
    }
  }
  return dir;
}

/**
 * Compute relative path of a page within its memory directory.
 */
function relPath(pagePath: string, memoryDir: string): string {
  return path.relative(memoryDir, pagePath);
}
