import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { normalizeConvergePeerUrl } from "@remnic/core/reconcile/cursor.js";
import {
  CONTENT_HASH_NORMALIZER_VERSION,
  IDENTITY_RESOLUTION_VERSION,
  RECONCILE_MANIFEST_SCHEMA_VERSION,
  type ReconcileManifestFile,
} from "@remnic/core/reconcile/manifest.js";
import { type MemoryStatus } from "@remnic/core/types.js";

/**
 * Resumable converge planning cache (issue #2803).
 *
 * The FIRST plan against a boot-scale pair spends most of its wall time in
 * the manifest phase (local corpus sha256 + per-namespace peer manifest
 * fetches), and one transient failure near the end used to discard all of
 * it. This module persists per-namespace manifest work under the EXISTING
 * converge cursor directory so a retry reuses everything that already
 * completed and recomputes only what changed.
 *
 * Entries are content-addressed by filename — `<side>-<nsHash16>-
 * <watermark16>.json` — where the address covers peer identity (normalized
 * URL, credentials stripped), config (citation template), schema/normalizer
 * versions, the namespace, and the corpus watermark (a digest over the
 * sorted `path\0sha256` census). A changed watermark or scope writes a NEW
 * file; superseded files for the same side+namespace are pruned.
 *
 * Privacy: entries carry only file metadata (path, sha256, mtimeMs, bytes)
 * and memory IDENTITY (id/category/contentHash/status) — never file bodies,
 * never the peer token, never the peer URL (only its one-way scope hash).
 * The peer URL and namespace names already live in the cursor files beside
 * this cache, so the namespace label inside an entry adds no new exposure.
 *
 * Failure policy: every read and prune fails OPEN (corrupt/stale data means
 * recompute, never a failed plan); every write failure is swallowed (the
 * cache is an optimization, not a source of truth).
 */

export const CONVERGE_PLAN_CACHE_FORMAT_VERSION = 1;
/** Upper bound on entries kept per scope; oldest-mtime entries are pruned. */
export const CONVERGE_PLAN_CACHE_MAX_ENTRIES = 128;
/** Entries untouched for this long are pruned on the next open. */
export const CONVERGE_PLAN_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Upper bound on scope directories (one per peer/config/schema identity). */
const CONVERGE_PLAN_CACHE_MAX_SCOPE_DIRS = 8;

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/**
 * Fail-open guard (#2965): a cached row whose memory status is not a real
 * MemoryStatus must reject the whole entry (recompute) instead of feeding
 * an unknown string into duplicate collapsing. Satisfies the union so a
 * misspelled literal fails to compile; a NEW status added upstream merely
 * makes warm entries miss once and recompute — the safe direction.
 */
const MEMORY_STATUSES: readonly MemoryStatus[] = [
  "active",
  "pending_review",
  "rejected",
  "quarantined",
  "superseded",
  "archived",
  "forgotten",
];

export type ConvergePlanCacheSide = "local" | "peer";

/**
 * Per-namespace planning progress (issue #2803): which namespace of how
 * many is being processed on which side, and how many of its manifest rows
 * were reused from the resumable cache vs computed fresh.
 */
export interface ConvergePlanProgressEvent {
  side: "local" | "peer";
  namespace: string;
  /** 1-based position within this side's namespace sequence. */
  index: number;
  total: number;
  reused: number;
  computed: number;
}

export interface ConvergePlanCacheEntry {
  version: 1;
  scope: string;
  side: ConvergePlanCacheSide;
  namespace: string;
  /** Digest over the sorted `path\0sha256` census this entry was built from. */
  watermark: string;
  fileCount: number;
  /**
   * Wall-clock ms when the underlying file stats were captured. Local-side
   * fast-base reuse treats files created AFTER this instant as unverified.
   */
  capturedAtMs: number;
  savedAt: string;
  /**
   * Peer-advertised manifest revision for streamed identity rows.
   * Absent on local-side entries and on client-built unversioned rows.
   */
  peerManifestRevision?: string;
  /**
   * True when this client's parser built the identity rows (legacy
   * per-file fallback). Those rows are safe to reuse without a peer
   * revision; streamed rows are not.
   */
  clientBuilt?: boolean;
  files: ReconcileManifestFile[];
}

/** Raised when another live process holds the plan-cache lock. */
export class ConvergePlanCacheBusyError extends Error {
  constructor(readonly holderPid: number) {
    super(
      `another converge plan is already running against this memory dir (pid ${holderPid}); its checkpoint state would be corrupted by a second writer`
    );
    this.name = "ConvergePlanCacheBusyError";
  }
}

function hash16(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Scope key: everything that changes manifest MEANING without showing up in
 * a file's sha256 — the peer identity, the citation template baked into
 * memory identity recovery, and the manifest/normalizer/identity schema
 * versions. A change in any of them addresses a different cache scope.
 */
export function convergePlanScopeKey(input: { peerUrl?: string; citationTemplate?: string }): string {
  return hash16(
    [
      "remnic-converge-plan-cache",
      String(CONVERGE_PLAN_CACHE_FORMAT_VERSION),
      String(RECONCILE_MANIFEST_SCHEMA_VERSION),
      String(CONTENT_HASH_NORMALIZER_VERSION),
      String(IDENTITY_RESOLUTION_VERSION),
      normalizeConvergePeerUrl(input.peerUrl ?? ""),
      input.citationTemplate ?? "",
    ].join("\0")
  );
}

/** Cache root lives under the EXISTING converge cursor directory. */
export function convergePlanCacheRoot(memoryDir: string): string {
  return path.join(path.resolve(memoryDir), ".remnic", "state", "converge-cursors", "plan-cache");
}

/**
 * Deterministic census digest over sorted `path\0sha256` rows. Equality
 * means the two file sets have identical (path, sha256) pairs — the exact
 * condition under which a cached manifest is still valid.
 */
export function censusWatermark(files: readonly { path: string; sha256: string }[]): string {
  const rows = files.map((file) => `${file.path}\0${file.sha256.toLowerCase()}`);
  rows.sort();
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

/** On-disk entry filename: `<side>-<nsHash16>-<watermark16>.json`. */
function entryFileName(side: ConvergePlanCacheSide, namespace: string, watermark: string): string {
  return `${side}-${hash16(namespace.trim())}-${watermark.slice(0, 16)}.json`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeEntryFile(raw: unknown): ReconcileManifestFile | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.path !== "string" || raw.path.length === 0) return null;
  if (typeof raw.sha256 !== "string" || !SHA256_HEX.test(raw.sha256)) return null;
  const mtimeMs = optionalNonNegativeNumber(raw.mtimeMs);
  const bytes = optionalNonNegativeNumber(raw.bytes);
  let memory: ReconcileManifestFile["memory"];
  if (raw.memory !== undefined) {
    const candidate = raw.memory;
    if (!isPlainObject(candidate)) return null;
    if (typeof candidate.id !== "string" || candidate.id.length === 0) return null;
    if (typeof candidate.contentHash !== "string" || !SHA256_HEX.test(candidate.contentHash)) return null;
    if (typeof candidate.category !== "string") return null;
    if (!MEMORY_STATUSES.includes(candidate.status as MemoryStatus)) return null;
    // normalizerVersion/identityResolutionVersion are OPTIONAL — streamed
    // peer manifest rows legitimately omit them. Version drift is caught by
    // the scope key (it folds the current constants in), never here.
    const normalizerVersion = typeof candidate.normalizerVersion === "number" ? candidate.normalizerVersion : undefined;
    const identityResolutionVersion =
      typeof candidate.identityResolutionVersion === "number" ? candidate.identityResolutionVersion : undefined;
    const contentHashAliases =
      Array.isArray(candidate.contentHashAliases) &&
      candidate.contentHashAliases.every((alias) => typeof alias === "string")
        ? (candidate.contentHashAliases as string[])
        : undefined;
    memory = {
      id: candidate.id,
      category: candidate.category,
      contentHash: candidate.contentHash,
      status: candidate.status as MemoryStatus,
      ...(normalizerVersion !== undefined ? { normalizerVersion } : {}),
      ...(identityResolutionVersion !== undefined ? { identityResolutionVersion } : {}),
      ...(contentHashAliases !== undefined ? { contentHashAliases } : {}),
    };
  }
  // Negative rows (no `memory`) carry their invalidation stamps at the top
  // level (#2927): dropping them made every warm run treat the cached "no
  // identity" verdict as a miss and reread the file indefinitely. Never
  // fabricate a `memory` here — a stampless negative row stays negative and
  // simply misses, forcing a safe cold reparse.
  const negativeNormalizerVersion =
    memory === undefined && typeof raw.normalizerVersion === "number" ? raw.normalizerVersion : undefined;
  const negativeIdentityResolutionVersion =
    memory === undefined && typeof raw.identityResolutionVersion === "number"
      ? raw.identityResolutionVersion
      : undefined;
  return {
    path: raw.path,
    sha256: raw.sha256,
    ...(mtimeMs !== undefined ? { mtimeMs } : {}),
    ...(bytes !== undefined ? { bytes } : {}),
    ...(memory ? { memory } : {}),
    ...(negativeNormalizerVersion !== undefined ? { normalizerVersion: negativeNormalizerVersion } : {}),
    ...(negativeIdentityResolutionVersion !== undefined
      ? { identityResolutionVersion: negativeIdentityResolutionVersion }
      : {}),
  };
}

function normalizeEntry(
  raw: unknown,
  scope: string,
  side: ConvergePlanCacheSide,
  namespace: string
): ConvergePlanCacheEntry | null {
  if (!isPlainObject(raw)) return null;
  if (raw.version !== 1 || raw.scope !== scope || raw.side !== side || raw.namespace !== namespace) return null;
  if (typeof raw.watermark !== "string" || !SHA256_HEX.test(raw.watermark)) return null;
  if (typeof raw.capturedAtMs !== "number" || !Number.isFinite(raw.capturedAtMs) || raw.capturedAtMs < 0) return null;
  if (typeof raw.savedAt !== "string") return null;
  if (!Array.isArray(raw.files) || raw.files.length !== raw.fileCount) return null;
  const files: ReconcileManifestFile[] = [];
  for (const row of raw.files) {
    const file = normalizeEntryFile(row);
    if (!file) return null;
    files.push(file);
  }
  return {
    version: 1,
    scope,
    side,
    namespace,
    watermark: raw.watermark,
    fileCount: files.length,
    capturedAtMs: raw.capturedAtMs,
    savedAt: raw.savedAt,
    ...(typeof raw.peerManifestRevision === "string" ? { peerManifestRevision: raw.peerManifestRevision } : {}),
    ...(raw.clientBuilt === true ? { clientBuilt: true } : {}),
    files,
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readProcessStartTicks(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen === -1) return null;
    const ticks = Number(stat.slice(closeParen + 2).split(" ")[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

const PROCESS_START_TICKS = readProcessStartTicks(process.pid);
/** When /proc start ticks are unavailable, steal a lock older than this. */
const LOCK_LEASE_MS = 24 * 60 * 60 * 1000;

function lockOwnerLive(held: {
  pid?: unknown;
  startTicks?: unknown;
  savedAt?: unknown;
}): { live: boolean; pid: number } {
  const pid = typeof held.pid === "number" && Number.isInteger(held.pid) ? held.pid : -1;
  if (pid <= 0 || !processAlive(pid)) return { live: false, pid };
  if (typeof held.startTicks === "number" && Number.isFinite(held.startTicks)) {
    const liveTicks = readProcessStartTicks(pid);
    if (liveTicks != null && liveTicks !== held.startTicks) return { live: false, pid };
    if (liveTicks != null) return { live: true, pid };
  }
  const savedAtMs = Date.parse(typeof held.savedAt === "string" ? held.savedAt : "");
  if (Number.isFinite(savedAtMs) && Date.now() - savedAtMs > LOCK_LEASE_MS) {
    return { live: false, pid };
  }
  return { live: true, pid };
}

async function assertSafePlanCacheDir(memoryDir: string, target: string): Promise<void> {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`plan-cache path must be a real directory, not a symlink: ${target}`);
  }
  const relative = path.relative(await fs.realpath(memoryDir), await fs.realpath(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`plan-cache path escapes memory dir: ${target}`);
  }
}

async function ensureSafePlanCacheTree(memoryDir: string, target: string): Promise<void> {
  const resolvedMemory = path.resolve(memoryDir);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedMemory, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`plan-cache path escapes memory dir: ${target}`);
  }
  await assertSafePlanCacheDir(memoryDir, resolvedMemory);
  let current = resolvedMemory;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      await assertSafePlanCacheDir(memoryDir, current);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await fs.mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await assertSafePlanCacheDir(memoryDir, current);
  }
}
async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function unlinkQuiet(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // Pruning and lock release are best-effort.
  }
}

async function statMtimeEntries(
  dir: string,
  names: readonly string[],
  keep: (name: string) => boolean
): Promise<Array<{ name: string; mtimeMs: number }>> {
  const entries: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!keep(name)) continue;
    try {
      entries.push({ name, mtimeMs: (await fs.stat(path.join(dir, name))).mtimeMs });
    } catch {
      // Unreadable — skip it.
    }
  }
  return entries;
}

async function pruneScopeDir(scopeDir: string, keepFileName?: string): Promise<void> {
  const names = await listDir(scopeDir);
  const entries = await statMtimeEntries(scopeDir, names, (name) => name.endsWith(".json") && name !== keepFileName);
  const now = Date.now();
  for (const entry of entries) {
    if (now - entry.mtimeMs > CONVERGE_PLAN_CACHE_MAX_AGE_MS) await unlinkQuiet(path.join(scopeDir, entry.name));
  }
  const fresh = entries.filter((entry) => now - entry.mtimeMs <= CONVERGE_PLAN_CACHE_MAX_AGE_MS);
  if (fresh.length > CONVERGE_PLAN_CACHE_MAX_ENTRIES) {
    fresh.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const entry of fresh.slice(0, fresh.length - CONVERGE_PLAN_CACHE_MAX_ENTRIES)) {
      await unlinkQuiet(path.join(scopeDir, entry.name));
    }
  }
}

async function pruneSiblingScopes(root: string, activeScope: string): Promise<void> {
  const names = await listDir(root);
  // rm(force) removes plain files too, so no isDirectory filter is needed.
  const stats = await statMtimeEntries(root, names, (name) => /^[0-9a-f]{16}$/.test(name) && name !== activeScope);
  const now = Date.now();
  const stale = stats.filter((dir) => now - dir.mtimeMs > CONVERGE_PLAN_CACHE_MAX_AGE_MS);
  const fresh = stats.filter((dir) => now - dir.mtimeMs <= CONVERGE_PLAN_CACHE_MAX_AGE_MS);
  const overflow = fresh
    .sort((left, right) => left.mtimeMs - right.mtimeMs)
    .slice(0, Math.max(0, fresh.length - (CONVERGE_PLAN_CACHE_MAX_SCOPE_DIRS - 1)));
  for (const dir of [...stale, ...overflow]) {
    await fs.rm(path.join(root, dir.name), { recursive: true, force: true }).catch(() => {});
  }
}

/** Lock paths this process currently holds (#2965): a nested open in the
 * same process must fail closed before any lock-file liveness reasoning. */
const heldLockPaths = new Set<string>();
/** Nonces of locks this process acquired but could not delete (#2965): a
 * later open in the same process reclaims exactly these. */
const failedReleaseNonces = new Map<string, string>();

export class ConvergePlanCache {
  readonly scope: string;
  private readonly scopeDir: string;
  private readonly lockPath: string;
  private readonly nonce = randomUUID();
  private closed = false;

  private constructor(root: string, scope: string) {
    this.scope = scope;
    this.scopeDir = path.join(root, scope);
    this.lockPath = path.join(root, "lock.json");
  }

  private lockPayload(): string {
    return `${JSON.stringify({
      pid: process.pid,
      startTicks: PROCESS_START_TICKS,
      savedAt: new Date().toISOString(),
      nonce: this.nonce,
    })}\n`;
  }

  /**
   * Open (and lock) the cache for one planning run. The lock is
   * cross-process: a second live planner fails fast with
   * {@link ConvergePlanCacheBusyError} instead of racing checkpoint writes.
   * A lock left by a dead process — or by this process's own failed
   * release — is stolen; a lock file is only ever replaced atomically, so
   * a steal racing the true owner at worst causes redundant recompute —
   * entries themselves are content-addressed and written via rename, so
   * concurrent identical writes cannot interleave.
   */
  static async open(memoryDir: string, scope: string): Promise<ConvergePlanCache> {
    const root = convergePlanCacheRoot(memoryDir);
    const scopeDir = path.join(root, scope);
    await ensureSafePlanCacheTree(memoryDir, scopeDir);
    const lockPath = path.join(root, "lock.json");
    if (heldLockPaths.has(lockPath)) throw new ConvergePlanCacheBusyError(process.pid);
    heldLockPaths.add(lockPath);
    const cache = new ConvergePlanCache(root, scope);
    try {
      const payload = cache.lockPayload();
      try {
        await fs.writeFile(lockPath, payload, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let held: { pid?: unknown; startTicks?: unknown; savedAt?: unknown; nonce?: unknown } = {};
        try {
          held = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
            pid?: unknown;
            startTicks?: unknown;
            savedAt?: unknown;
            nonce?: unknown;
          };
        } catch {
          held = {};
        }
        // Same-owner reclaim (#2965): a lock this process acquired but
        // could not delete, or one carrying our exact process identity
        // while we hold no open cache, has no live foreign owner — steal
        // it instead of busy-failing on our own leftover.
        const sameOwner =
          held.pid === process.pid &&
          ((typeof held.nonce === "string" && failedReleaseNonces.get(lockPath) === held.nonce) ||
            (PROCESS_START_TICKS !== null && held.startTicks === PROCESS_START_TICKS));
        if (!sameOwner) {
          const owner = lockOwnerLive(held);
          if (owner.live) throw new ConvergePlanCacheBusyError(owner.pid);
        }
        // Stale (dead owner, reused PID, our own leftover, or unreadable)
        // — steal atomically.
        // ponytail: two processes can both steal in a narrow race; worst
        // case is duplicated work plus benign identical entry writes, not
        // corruption.
        const tmp = `${lockPath}.${process.pid}.tmp`;
        await fs.writeFile(tmp, payload);
        await fs.rename(tmp, lockPath);
      }
      failedReleaseNonces.delete(lockPath);
      try {
        await pruneSiblingScopes(root, scope);
        await pruneScopeDir(cache.scopeDir);
      } catch {
        // Pruning must never fail the plan.
      }
    } catch (error) {
      heldLockPaths.delete(lockPath);
      throw error;
    }
    return cache;
  }

  /**
   * Newest valid entry for this side+namespace regardless of watermark (an
   * older-watermark entry is still a useful fast-base). Any corrupt entry is
   * skipped — fail-open recompute.
   */
  async readEntry(side: ConvergePlanCacheSide, namespace: string): Promise<ConvergePlanCacheEntry | null> {
    if (this.closed) return null;
    const prefix = `${side}-${hash16(namespace.trim())}-`;
    let names: string[];
    try {
      names = (await fs.readdir(this.scopeDir)).filter((name) => name.startsWith(prefix) && name.endsWith(".json"));
    } catch {
      return null;
    }
    const byMtime = await statMtimeEntries(this.scopeDir, names, () => true);
    byMtime.sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const candidate of byMtime) {
      try {
        const raw = JSON.parse(await fs.readFile(path.join(this.scopeDir, candidate.name), "utf8"));
        const entry = normalizeEntry(raw, this.scope, side, namespace);
        if (entry) return entry;
      } catch {
        // Corrupt — try the next candidate.
      }
    }
    return null;
  }

  /**
   * Atomically persist a completed namespace's work. Never throws: a cache
   * write failure degrades to a slower retry, never a failed plan.
   */
  async writeEntry(entry: ConvergePlanCacheEntry): Promise<void> {
    if (this.closed) return;
    await this.renewLease();
    const fileName = entryFileName(entry.side, entry.namespace, entry.watermark);
    const finalPath = path.join(this.scopeDir, fileName);
    const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tmpPath, `${JSON.stringify(entry)}\n`);
      await fs.rename(tmpPath, finalPath);
    } catch {
      await unlinkQuiet(tmpPath);
      return;
    }
    try {
      // Supersede older-watermark entries for this side+namespace, then
      // enforce the bounded-entry cap.
      const prefix = `${entry.side}-${hash16(entry.namespace.trim())}-`;
      for (const name of await listDir(this.scopeDir)) {
        if (name.startsWith(prefix) && name.endsWith(".json") && name !== fileName) {
          await unlinkQuiet(path.join(this.scopeDir, name));
        }
      }
      await pruneScopeDir(this.scopeDir, fileName);
    } catch {
      // Pruning is best-effort.
    }
  }

  /**
   * Refresh savedAt while the cache stays open (#2965): on hosts without
   * readable /proc start ticks the 24h lease is the only steal guard, and a
   * plan legitimately longer than that must not have its lock stolen
   * mid-run. Renewal rides the per-namespace checkpoint cadence; it skips
   * a lock that was stolen from us (nonce mismatch).
   */
  private async renewLease(): Promise<void> {
    if (this.closed) return;
    try {
      const held = JSON.parse(await fs.readFile(this.lockPath, "utf8")) as { nonce?: unknown };
      if (typeof held.nonce !== "string" || held.nonce !== this.nonce) return;
      const tmp = `${this.lockPath}.${process.pid}.renew.tmp`;
      await fs.writeFile(tmp, this.lockPayload());
      await fs.rename(tmp, this.lockPath);
    } catch {
      // Best-effort: a failed renewal never fails the plan.
    }
  }

  /**
   * Release the cross-process lock. Safe to call more than once. Only the
   * lock instance this cache owns is unlinked (#2965): a lock stolen from
   * us carries another owner's nonce and must survive this close. When our
   * own unlink fails, the nonce is retained so a later open in this
   * process reclaims the orphan instead of busy-failing on it.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    heldLockPaths.delete(this.lockPath);
    let owned = false;
    try {
      const held = JSON.parse(await fs.readFile(this.lockPath, "utf8")) as { nonce?: unknown };
      owned = typeof held.nonce === "string" && held.nonce === this.nonce;
    } catch {
      // Unreadable lock: leave it for the lease and reclaim paths.
    }
    if (!owned) return;
    try {
      await fs.unlink(this.lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        failedReleaseNonces.set(this.lockPath, this.nonce);
      }
    }
  }
}
