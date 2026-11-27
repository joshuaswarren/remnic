
import { createHash } from "node:crypto";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { capabilityAllowsNamespace, type TokenCapabilities } from "./access-token-capabilities.js";
import { listNamespaces } from "./namespaces/migrate.js";
import { corpusScanWorker } from "./corpus-scan-worker-host.js";
import type { PluginConfig } from "./types.js";

export interface CorpusWatermark {
  namespace: string;
  memoryFileCount: number;
  /** Newest `YYYY-MM-DD` day-partition seen in the HOT tier, or null when none is dated. */
  newestPartition: string | null;
  /** ISO max mtime within the newest HOT partition, or null when it has no files. */
  newestWriteAt: string | null;
  /** sha256 hex over the deterministic per-partition census. */
  digest: string;
  computedAt: string;
}

/** Explicit bucket for paths that do not match the `<category>/<day>` shape. */
export const UNPARTITIONED_BUCKET = "unpartitioned";

/** Storage tier a memory file lives in. */
export type CorpusTier = "hot" | "cold";

/** Paths parsed between event-loop yields while building a census. */
const CENSUS_YIELD_EVERY = 4_096;

const DAY_PARTITION_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Cold-tier root segment (relative to a namespace base dir): `<baseDir>/cold/...`. */
const COLD_TIER_DIR = "cold";

function isRealCalendarDay(token: string): boolean {
  if (!DAY_PARTITION_RE.test(token)) return false;
  const [year, month, day] = token.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

interface ParsedPath {
  readonly bucket: string;
  readonly date: string | null;
  readonly tier: CorpusTier;
}

function parsePartition(baseDir: string, filePath: string): ParsedPath {
  const rel = path.relative(baseDir, filePath).split(path.sep).join("/");
  const parts = rel.split("/");
  const tier: CorpusTier = parts[0] === COLD_TIER_DIR ? "cold" : "hot";
  const categoryParts = tier === "cold" ? parts.slice(1) : parts;
  if (categoryParts.length >= 2 && isRealCalendarDay(categoryParts[1])) {
    return { bucket: `${tier}:${categoryParts[0]}/${categoryParts[1]}`, date: categoryParts[1], tier };
  }
  return { bucket: `${tier}:${UNPARTITIONED_BUCKET}`, date: null, tier };
}

/**
 * Build the per-partition census: bucket key -> file count. Bucket keys are
 * tier-aware (`hot:`/`cold:`). Paths not matching a day-partition land in the
 * explicit tier {@link UNPARTITIONED_BUCKET}; they are never silently dropped.
 * Pure — no filesystem access.
 */
export function buildPartitionCensus(paths: readonly string[], baseDir: string): Map<string, number> {
  const census = new Map<string, number>();
  for (const filePath of paths) {
    const { bucket } = parsePartition(baseDir, filePath);
    census.set(bucket, (census.get(bucket) ?? 0) + 1);
  }
  return census;
}

/**
 * Deterministic census -> digest. Bucket keys are SORTED before serialization
 * (AGENTS.md pattern 26: insertion order must not affect a hash), then emitted
 * as `"<bucket>:<count>"` lines joined by `\n` and hashed with sha256. Pure —
 * separately exported so it can be unit-tested without a filesystem.
 */
export function digestPartitionCensus(census: ReadonlyMap<string, number> | Record<string, number>): string {
  const entries = census instanceof Map ? [...census.entries()] : Object.entries(census);
  const serialized = entries
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([bucket, count]) => `${bucket}:${count}`)
    .join("\n");
  return createHash("sha256").update(serialized).digest("hex");
}

/**
 * Compute a watermark for a single namespace from an already-collected path
 * list (both tiers, under `baseDir`) plus its memory base directory. Never
 * throws on an empty list — an empty corpus yields the digest of the empty
 * census and null timestamps. Only the newest HOT partition's files are
 * `stat`-ed, so freshness stays cheap even on a 100k+ corpus.
 */
export async function computeCorpusWatermark(input: {
  namespace: string;
  paths: readonly string[];
  baseDir: string;
  now?: Date;
}): Promise<CorpusWatermark> {
  const { namespace, paths, baseDir } = input;

  const census = new Map<string, number>();
  let newestPartition: string | null = null;
  const parsedByPath: ParsedPath[] = [];
  let sinceYield = 0;
  for (const filePath of paths) {
    if (sinceYield >= CENSUS_YIELD_EVERY) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
    sinceYield += 1;
    const parsed = parsePartition(baseDir, filePath);
    parsedByPath.push(parsed);
    census.set(parsed.bucket, (census.get(parsed.bucket) ?? 0) + 1);
    if (parsed.tier === "hot" && parsed.date !== null && (newestPartition === null || parsed.date > newestPartition)) {
      newestPartition = parsed.date;
    }
  }

  const digest = digestPartitionCensus(census);

  let newestWriteAt: string | null = null;
  if (newestPartition !== null) {
    const newestPaths: string[] = [];
    for (let i = 0; i < paths.length; i += 1) {
      if (parsedByPath[i].tier !== "hot" || parsedByPath[i].date !== newestPartition) continue;
      newestPaths.push(paths[i]);
    }
    const mtimes = await corpusScanWorker.request({ kind: "stat-mtimes", paths: newestPaths });
    let maxMtimeMs = Number.NEGATIVE_INFINITY;
    for (const mtimeMs of mtimes) {
      if (mtimeMs !== null && mtimeMs > maxMtimeMs) maxMtimeMs = mtimeMs;
    }
    if (maxMtimeMs > Number.NEGATIVE_INFINITY) {
      newestWriteAt = new Date(maxMtimeMs).toISOString();
    }
  }

  const computedAt = (input.now ?? new Date()).toISOString();

  return {
    namespace,
    memoryFileCount: paths.length,
    newestPartition,
    newestWriteAt,
    digest,
    computedAt,
  };
}

/** Minimal storage surface a watermark needs — satisfied by StorageManager. */
export interface CorpusStorage {
  readonly dir: string;
  /** Hot-tier active memory paths (the recall corpus). */
  collectActiveMemoryPaths(options?: { propagateReadErrors?: boolean }): Promise<string[]>;
  /** Cold-tier (demoted-but-reachable) memory paths (issue #2156 finding D). */
  collectColdMemoryPaths(options?: { propagateReadErrors?: boolean }): Promise<string[]>;
  /**
   * Optional combined hot+cold corpus-mutation sentinel. When present, the
   * census brackets its scan with it and retries on change so a tier migration
   * racing the walkers is not cached as a false divergence. Absent (test fakes)
   * ⇒ single-pass.
   */
  getCorpusScanVersion?(): string | Promise<string>;
}

/** Max census re-scans when a corpus mutation keeps racing the walkers. */
const CENSUS_RACE_MAX_ATTEMPTS = 3;

async function computeNamespaceWatermark(
  namespace: string,
  storage: CorpusStorage,
  now?: Date,
): Promise<CorpusWatermark> {
  const readVersion = storage.getCorpusScanVersion?.bind(storage);
  const maxAttempts = readVersion ? CENSUS_RACE_MAX_ATTEMPTS : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const before = readVersion ? await readVersion() : null;
    const [hotPaths, coldPaths] = await Promise.all([
      storage.collectActiveMemoryPaths({ propagateReadErrors: true }),
      storage.collectColdMemoryPaths({ propagateReadErrors: true }),
    ]);
    const result = await computeCorpusWatermark({ namespace, paths: [...hotPaths, ...coldPaths], baseDir: storage.dir, now });
    const after = readVersion ? await readVersion() : null;
    if (before === after) return result;
    // A tier write (e.g. hot→cold migration) raced the two walkers, so the
    // count/digest may double-count or miss the in-flight memory. Retry for a
    // consistent snapshot.
  }
  throw new Error(`corpus census for namespace "${namespace}" did not stabilize after ${maxAttempts} attempts`);
}

/**
 * Compute watermarks for a set of namespaces. A namespace whose storage is
 * unavailable (or unreadable) is skipped rather than failing the whole read, so
 * a single bad namespace never blanks the health/doctor payload.
 */
export async function computeCorpusWatermarks(
  namespaces: readonly string[],
  storageFor: (namespace: string) => CorpusStorage | Promise<CorpusStorage>,
  now?: Date,
): Promise<CorpusWatermark[]> {
  const watermarks: CorpusWatermark[] = [];
  for (const namespace of namespaces) {
    try {
      watermarks.push(await computeNamespaceWatermark(namespace, await storageFor(namespace), now));
    } catch {
      // Storage unavailable/unreadable for this namespace — degrade gracefully.
    }
  }
  return watermarks;
}

/** A namespace and the memory root its corpus lives under. */
export interface CorpusNamespaceRoot {
  /** Representative namespace label for this root (default wins on collapse). */
  readonly namespace: string;
  readonly rootDir: string;
  /**
   * Every configured namespace name that resolves to `rootDir` (aliases that
   * collapsed onto one physical root, e.g. `global` + `shared` when namespaces
   * are disabled). `/health` filters visibility against ALL of these so a token
   * scoped to a non-representative alias still sees the shared corpus (issue
   * #2156 round-10). Always includes `namespace`.
   */
  readonly namespaces: readonly string[];
}

/**
 * Resolve the namespace set the corpus census covers, shared by the `/health`
 * builder AND the `remnic doctor` corpus check (issue #2156 finding C) so the
 * two surfaces enumerate the SAME tenants — and, critically, resolve each
 * namespace's ROOT the SAME way — and cannot drift. Enumeration is purely
 * config-driven (`listNamespaces({ config })`): it discovers the default,
 * shared, policy, and on-disk `namespaces/<ns>` tenants and resolves every root
 * through the namespace storage router, exactly as the live daemon's
 * `getStorage(namespace)` does. It still works when the namespace catalog is
 * opted out. The catalog is deliberately NOT unioned in: a catalog-registered
 * tenant with no directory has an empty corpus (nothing to fingerprint), and
 * trusting `catalog.storageDir` here could make the doctor scan a different root
 * than `/health` for the same namespace (issue #2156 round-8). Deduped by
 * resolved root so a namespaces-disabled / flat-root deployment reports its
 * single shared corpus once, under the default-namespace label.
 */
export async function resolveCorpusNamespaceRoots(options: {
  config: PluginConfig;
  propagateDiscoveryErrors?: boolean;
}): Promise<CorpusNamespaceRoot[]> {
  const { config } = options;
  const configDriven = await listNamespaces({
    config,
    propagateDiscoveryErrors: options.propagateDiscoveryErrors,
  });
  const ordered = [
    ...configDriven.filter((entry) => entry.namespace === config.defaultNamespace),
    ...configDriven.filter((entry) => entry.namespace !== config.defaultNamespace),
  ];
  const seenNamespaces = new Set<string>();
  const byRoot = new Map<string, { namespace: string; rootDir: string; namespaces: string[] }>();
  for (const entry of ordered) {
    if (seenNamespaces.has(entry.namespace)) continue;
    seenNamespaces.add(entry.namespace);
    const existing = byRoot.get(entry.rootDir);
    if (existing) {
      existing.namespaces.push(entry.namespace); // an alias collapsing onto a seen root
    } else {
      byRoot.set(entry.rootDir, { namespace: entry.namespace, rootDir: entry.rootDir, namespaces: [entry.namespace] });
    }
  }
  const roots: CorpusNamespaceRoot[] = [...byRoot.values()];
  if (roots.length === 0) {
    roots.push({ namespace: config.defaultNamespace, rootDir: config.memoryDir, namespaces: [config.defaultNamespace] });
  }
  return roots;
}

export const WATERMARK_CACHE_TTL_MS = 60_000;

const MAX_CONCURRENT_WATERMARK_REFRESHES = 4;

/**
 * Instance-scoped (AGENTS.md pattern 5 — never a bare module global)
 * stale-while-revalidate cache in front of the per-namespace corpus scan.
 * {@link get} NEVER awaits the scan: it returns the freshest already-computed
 * watermark (stale allowed, or undefined for a cold namespace) and triggers a
 * single-flight background refresh when the entry is missing or expired. So a
 * `/health` probe is always O(1) — it never blocks on a recursive corpus walk,
 * even on the first request after startup or after a TTL expiry. Owned by the
 * long-lived access service instance.
 */
export class CorpusWatermarkCache {
  private readonly entries = new Map<string, { value: CorpusWatermark; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private rootsEntry: { value: CorpusNamespaceRoot[]; expiresAt: number } | undefined;
  private rootsInFlight: Promise<void> | undefined;
  private rootsRefreshError: unknown;
  private readonly queued = new Map<string, () => void>();
  private activeRefreshes = 0;
  private readonly maxConcurrentRefreshes: number;

  constructor(options: { ttlMs?: number; clock?: () => number; maxConcurrentRefreshes?: number } = {}) {
    this.ttlMs = options.ttlMs ?? WATERMARK_CACHE_TTL_MS;
    this.clock = options.clock ?? Date.now;
    this.maxConcurrentRefreshes = Math.max(1, options.maxConcurrentRefreshes ?? MAX_CONCURRENT_WATERMARK_REFRESHES);
  }

  get(namespace: string, compute: () => Promise<CorpusWatermark>): CorpusWatermark | undefined {
    const cached = this.entries.get(namespace);
    const fresh = cached !== undefined && this.clock() < cached.expiresAt;
    if (!fresh) this.refresh(namespace, compute);
    return cached?.value;
  }

  private refresh(namespace: string, compute: () => Promise<CorpusWatermark>): void {
    if (this.inFlight.has(namespace) || this.queued.has(namespace)) return;
    const run = (): void => {
      this.activeRefreshes += 1;
      const pending = compute()
        .then((value) => {
          this.entries.set(namespace, { value, expiresAt: this.clock() + this.ttlMs });
        })
        .catch(() => {
          // Failed/unreadable scan: never cache it; keep serving any stale value.
        })
        .finally(() => {
          this.inFlight.delete(namespace);
          this.activeRefreshes -= 1;
          this.drainQueue();
        });
      this.inFlight.set(namespace, pending);
    };
    if (this.activeRefreshes < this.maxConcurrentRefreshes) {
      run();
    } else {
      this.queued.set(namespace, run);
    }
  }

  private drainQueue(): void {
    while (this.activeRefreshes < this.maxConcurrentRefreshes && this.queued.size > 0) {
      const next = this.queued.entries().next().value;
      if (!next) break;
      const [namespace, run] = next;
      this.queued.delete(namespace);
      run();
    }
  }


  getResolvedRoots(compute: () => Promise<CorpusNamespaceRoot[]>): CorpusNamespaceRoot[] | undefined {
    const fresh = this.rootsEntry !== undefined && this.clock() < this.rootsEntry.expiresAt;
    if (!fresh && this.rootsInFlight === undefined) {
      this.rootsInFlight = compute()
        .then((value) => {
          this.rootsEntry = { value, expiresAt: this.clock() + this.ttlMs };
          this.rootsRefreshError = undefined;
        })
        .catch((error: unknown) => {
          this.rootsRefreshError = error;
          // Keep serving any stale roots; callers that require completeness
          // inspect the refresh status before trusting them.
        })
        .finally(() => {
          this.rootsInFlight = undefined;
        });
    }
    return this.rootsEntry?.value;
  }

  getResolvedRootsStatus(compute: () => Promise<CorpusNamespaceRoot[]>): {
    roots: CorpusNamespaceRoot[] | undefined;
    refreshError: unknown;
  } {
    const roots = this.getResolvedRoots(compute);
    return { roots, refreshError: this.rootsRefreshError };
  }
  /** Await every background refresh — in-flight AND queued (issue #2156 round-9) —
   *  plus any roots refresh (shutdown / deterministic tests). */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0 || this.rootsInFlight !== undefined || this.queued.size > 0) {
      const pending: Promise<unknown>[] = [...this.inFlight.values()];
      if (this.rootsInFlight) pending.push(this.rootsInFlight);
      if (pending.length === 0) {
        this.drainQueue(); // queued work with no running peer — start it
        await Promise.resolve();
        continue;
      }
      await Promise.all(pending);
    }
  }
}

export interface CorpusWatermarkHost {
  config: PluginConfig;
  getStorage(namespace: string): CorpusStorage | Promise<CorpusStorage>;
}

export interface ServiceCorpusWatermarkOptions {
  cache?: CorpusWatermarkCache;
  /**
   * Presenting token capabilities. When the token is namespace-restricted the
   * fleet view is filtered to the namespaces it may access (issue #2156 finding
   * B); an unrestricted/legacy token keeps the full fleet view.
   */
  caps?: TokenCapabilities | null;
  now?: Date;
}

/**
 * Build the per-namespace watermark array served on `/health`. Namespaces are
 * resolved through {@link resolveCorpusNamespaceRoots} (shared with the doctor),
 * filtered to the caller's capabilities, then served through the (optional)
 * stale-while-revalidate cache so a probe never blocks on a scan. Degrades to an
 * empty array — never throws — if enumeration is unavailable; an individual
 * namespace whose scan fails is omitted, not allowed to blank the payload.
 */
export async function computeServiceCorpusWatermarks(
  host: CorpusWatermarkHost,
  options: ServiceCorpusWatermarkOptions = {},
): Promise<CorpusWatermark[]> {
  return (await computeServiceCorpusCensus(host, options)).watermarks;
}

/**
 * Watermarks PLUS whether every configured namespace made it into the set.
 *
 * Completeness is returned ATOMICALLY with the data rather than stashed in a
 * side channel: every early exit here (enumeration threw, roots still warming,
 * a per-namespace scan failed, a cache entry not yet populated) yields an
 * incomplete set, and a caller that certifies convergence against a partial
 * census would hide the divergence of whatever was dropped (issue #2149).
 */
export async function computeServiceCorpusCensus(
  host: CorpusWatermarkHost,
  options: ServiceCorpusWatermarkOptions = {},
): Promise<{ watermarks: CorpusWatermark[]; complete: boolean }> {
  let roots: CorpusNamespaceRoot[] | undefined;
  if (options.cache) {
    const { roots: cachedRoots, refreshError } = options.cache.getResolvedRootsStatus(() =>
      resolveCorpusNamespaceRoots({ config: host.config, propagateDiscoveryErrors: true }),
    );
    if (refreshError !== undefined) return { watermarks: [], complete: false };
    roots = cachedRoots;
  } else {
    try {
      roots = await resolveCorpusNamespaceRoots({
        config: host.config,
        propagateDiscoveryErrors: true,
      });
    } catch {
      return { watermarks: [], complete: false }; // never enumerated — not an empty corpus
    }
  }
  if (!roots) return { watermarks: [], complete: false };
  const visible = roots.filter((root) => root.namespaces.some((ns) => capabilityAllowsNamespace(options.caps, ns)));
  const watermarks: CorpusWatermark[] = [];
  let complete = true;
  for (const { namespace } of visible) {
    const compute = async (): Promise<CorpusWatermark> =>
      computeNamespaceWatermark(namespace, await host.getStorage(namespace), options.now);
    if (options.cache) {
      const cached = options.cache.get(namespace, compute);
      if (cached) watermarks.push(cached);
      else complete = false; // still warming — the set is not the full census yet
    } else {
      try {
        watermarks.push(await compute());
      } catch {
        complete = false;
      }
    }
  }
  return { watermarks, complete };
}


