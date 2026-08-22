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

import { createHash } from "node:crypto";
import path from "node:path";
import {
  access,
  mkdir,
  readFile,
  writeFile,
  unlink,
} from "node:fs/promises";
import { ALL_CATEGORY_DIRS, RECALL_FALLBACK_DIRS } from "./utils/category-dir.js";
import { bumpMemoryCorpusVersionForDir } from "./memory-corpus-version.js";
import {
  pathMayCarryEntityRefs,
  requestEntityCanonicalIdReconcile,
} from "./storage/entity-canonical-id-references.js";
import { withRawEntityPageMutation } from "./storage/entity-canonical-id-lock.js";

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
   * commits (pruneVersions `committedVersionId`) or drops the entry.
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
  await writeFile(mp, JSON.stringify(history, null, 2) + "\n", "utf-8");
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

  return withPageLock(mPath, async () => {
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

    // Write snapshot file
    const dir = sidecarDir(resolvedMemoryDir, sidecar, relPath(pagePath, resolvedMemoryDir));
    await mkdir(dir, { recursive: true });
    const ext = path.extname(pagePath) || ".md";
    const snapshotPath = path.join(dir, `${nextId}${ext}`);
    await writeFile(snapshotPath, content, "utf8");

    history.versions.push(version);
    history.currentVersion = nextId;

    // Prune old versions if exceeding max, unless the caller deferred the
    // prune until its guarded write commits (issue #2330 round N+11 C).
    if (options?.deferPrune !== true) {
      await pruneExcessVersions(history, maxVersionsPerPage, dir, ext, log);
    }

    await writeManifest(resolvedMemoryDir, sidecar, relPath(pagePath, resolvedMemoryDir), history);
    log.debug(`page-versioning: created version ${nextId} for ${pagePath} (trigger=${trigger})`);

    return version;
  });
}

/** Prune the oldest snapshots in place. The caller holds the page lock. */
async function pruneExcessVersions(
  history: VersionHistory,
  maxVersionsPerPage: number,
  dir: string,
  ext: string,
  log: VersioningLogger,
): Promise<void> {
  if (!(maxVersionsPerPage > 0)) return;
  // Round N+15 (B): count only COMMITTED snapshots. Two concurrent merges
  // can both stage (deferPrune) before either commits; a prune that counted
  // the other writer's pending entry would drop one more rollback point
  // than the cap requires, and that writer's abort (removeVersion) then
  // leaves history SHORT of the cap. Pending entries are skipped entirely —
  // never counted, never removed. (ponytail: a writer that dies mid-attempt
  // leaves its entry pending forever — bounded by one entry per crash; age-
  // based expiry if crash loops ever make that matter.)
  const excess =
    history.versions.filter((version) => version.pending !== true).length -
    maxVersionsPerPage;
  if (excess <= 0) return;
  const toRemove = new Set<PageVersion>();
  for (const version of history.versions) {
    if (toRemove.size >= excess) break;
    if (version.pending === true) continue;
    toRemove.add(version);
  }
  for (const old of toRemove) {
    const oldPath = path.join(dir, `${old.versionId}${ext}`);
    try {
      await unlink(oldPath);
    } catch {
      log.debug(`page-versioning: could not remove old snapshot ${oldPath}`);
    }
  }
  history.versions = history.versions.filter((version) => !toRemove.has(version));
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
  await withPageLock(manifestPath(resolvedMemoryDir, config.sidecarDir, rel), async () => {
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
    await pruneExcessVersions(
      history,
      config.maxVersionsPerPage,
      sidecarDir(resolvedMemoryDir, config.sidecarDir, rel),
      path.extname(pagePath) || ".md",
      log,
    );
    if (history.versions.length !== before || committedCleared) {
      await writeManifest(resolvedMemoryDir, config.sidecarDir, rel, history);
    }
  });
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
  await withPageLock(manifestPath(resolvedMemoryDir, config.sidecarDir, rel), async () => {
    const history = await readManifest(resolvedMemoryDir, config.sidecarDir, rel);
    const index = history.versions.findIndex((version) => version.versionId === versionId);
    if (index === -1) return;
    history.versions.splice(index, 1);
    const dir = sidecarDir(resolvedMemoryDir, config.sidecarDir, rel);
    const ext = path.extname(pagePath) || ".md";
    try {
      await unlink(path.join(dir, `${versionId}${ext}`));
    } catch {
      log.debug(`page-versioning: could not remove snapshot file for ${pagePath} version ${versionId}`);
    }
    history.currentVersion = history.versions.length > 0
      ? String(Math.max(...history.versions.map((version) => Number(version.versionId))))
      : "0";
    await writeManifest(resolvedMemoryDir, config.sidecarDir, rel, history);
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
