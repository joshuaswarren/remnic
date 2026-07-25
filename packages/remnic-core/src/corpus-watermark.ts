/**
 * Corpus watermark (issue #2149) — a cheap, comparable fingerprint of a
 * daemon's active-memory corpus.
 *
 * Deployment shape this addresses: two daemons behind an active/backup VIP,
 * each owning its own memory directory. Nothing compared the two corpora, so a
 * pair could diverge for months (e.g. one holding ~190k files, its backup
 * ~340k with different histories) with no signal until a manual audit. This
 * module ships the WATERMARK primitive and the read surfaces that expose it;
 * peer polling and divergence alerting are a follow-up.
 *
 * The digest is a CENSUS fingerprint (per day-partition file counts), NOT a
 * content hash — two daemons that agree on how many memory FILES live in
 * each `<tier>:<category>/<day>` partition produce the same digest, so a
 * differing digest is a cheap divergence signal without reading or hashing file
 * bodies. Buckets are tier-aware (`hot:` / `cold:`): demoted memories stay
 * reachable via cold recall, so the census counts BOTH tiers and a hot/cold
 * split shows in the digest rather than being silently folded together (issue
 * #2156 finding D). `newestWriteAt` stays scoped to the newest HOT partition
 * only, so the freshness probe stays O(one day's active files) even on a 100k+
 * corpus.
 *
 * Robustness (issue #2156 review rounds):
 * - `/health` and `remnic doctor` resolve their namespace set through the ONE
 *   {@link resolveCorpusNamespaceRoots} helper — config-driven enumeration
 *   unioned with the PERSISTED namespace catalog read from config — so both
 *   surfaces enumerate the same tenants and cannot drift.
 * - The `/health` builder serves through a stale-while-revalidate
 *   {@link CorpusWatermarkCache}, so a probe NEVER awaits the recursive corpus
 *   scan (it returns the cached/stale value and refreshes in the background).
 * - Each namespace's census brackets its hot+cold walk with a corpus-mutation
 *   sentinel and retries when a tier migration races it, so a transient
 *   double-count/miss is never cached as a false divergence.
 * - An unreadable corpus root (EACCES) is OMITTED, not published as a false
 *   empty; a missing root (ENOENT — a not-yet-created namespace) is a genuine
 *   empty corpus.
 */

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { capabilityAllowsNamespace, type TokenCapabilities } from "./access-token-capabilities.js";
import { NamespaceCatalog } from "./namespaces/catalog.js";
import { listNamespaces } from "./namespaces/migrate.js";
import type { PluginConfig } from "./types.js";

export interface CorpusWatermark {
  namespace: string;
  /**
   * Count of memory files under the census scan roots (hot + cold). This is a
   * FILE census, not a status-filtered active count: reading each file's
   * frontmatter status would defeat the cheap-probe design, so an in-place
   * status change (e.g. archived-in-place) is not reflected here.
   */
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

const DAY_PARTITION_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Cold-tier root segment (relative to a namespace base dir): `<baseDir>/cold/...`. */
const COLD_TIER_DIR = "cold";

interface ParsedPath {
  readonly bucket: string;
  readonly date: string | null;
  readonly tier: CorpusTier;
}

function parsePartition(baseDir: string, filePath: string): ParsedPath {
  const rel = path.relative(baseDir, filePath).split(path.sep).join("/");
  const parts = rel.split("/");
  // Cold-tier files live under `<baseDir>/cold/<category>/<day>/...`; hot files
  // sit directly under `<baseDir>/<category>/<day>/...`. Strip the leading
  // `cold/` segment so the category/day parse is tier-agnostic, then prefix the
  // bucket with the tier so a hot and cold partition of the same day never
  // collide (they must diverge the digest, not fold together).
  const tier: CorpusTier = parts[0] === COLD_TIER_DIR ? "cold" : "hot";
  const categoryParts = tier === "cold" ? parts.slice(1) : parts;
  if (categoryParts.length >= 2 && DAY_PARTITION_RE.test(categoryParts[1])) {
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
  for (const filePath of paths) {
    const parsed = parsePartition(baseDir, filePath);
    parsedByPath.push(parsed);
    census.set(parsed.bucket, (census.get(parsed.bucket) ?? 0) + 1);
    // Freshness is the newest ACTIVE (hot) write. Cold memories are demoted and
    // keep their original (older) partition date, so they never advance the
    // freshness probe and their files are never stat-ed below.
    if (parsed.tier === "hot" && parsed.date !== null && (newestPartition === null || parsed.date > newestPartition)) {
      newestPartition = parsed.date;
    }
  }

  const digest = digestPartitionCensus(census);

  let newestWriteAt: string | null = null;
  if (newestPartition !== null) {
    let maxMtimeMs = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < paths.length; i += 1) {
      if (parsedByPath[i].tier !== "hot" || parsedByPath[i].date !== newestPartition) continue;
      try {
        const st = await stat(paths[i]);
        if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
      } catch {
        // File vanished between scan and stat — skip it, never fail the probe.
      }
    }
    if (maxMtimeMs > Number.NEGATIVE_INFINITY) {
      newestWriteAt = new Date(maxMtimeMs).toISOString();
    }
  }

  // Stamp AFTER the (possibly slow) stat loop so an age-based HA consumer never
  // sees a timestamp earlier than when the scan actually finished (finding
  // round-4). An explicit `now` (tests / determinism) still wins.
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

/**
 * Compute one namespace's watermark from its storage, spanning BOTH tiers so a
 * cold-tier divergence is caught. Reads are STRICT: the collectors propagate a
 * backend read failure (EACCES on the root OR any nested category dir, ENOTDIR,
 * …) so an unreadable corpus is OMITTED by the caller rather than published as a
 * false empty census; a missing root (ENOENT — a not-yet-created namespace)
 * stays a genuine empty corpus. The hot+cold walk is bracketed by the
 * corpus-mutation sentinel (when the storage exposes one) and retried on change;
 * if it never stabilizes (sustained tier churn) this THROWS rather than caching
 * a transient double-count/miss as a false divergence.
 */
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
  readonly namespace: string;
  readonly rootDir: string;
}

/**
 * Resolve the namespace set the corpus census covers, shared by the `/health`
 * builder AND the `remnic doctor` corpus check (issue #2156 finding C) so the
 * two surfaces enumerate the SAME tenants and cannot drift. Config-driven
 * enumeration is authoritative because it still works when the namespace
 * catalog is opted out or not yet populated. The PERSISTED namespace catalog
 * (read from config, so both surfaces see it identically — not just the process
 * holding a live catalog) is unioned in, covering a catalog-registered tenant
 * whose directory does not exist yet. Deduped by resolved root so a
 * namespaces-disabled / flat-root deployment reports its single shared corpus
 * once, under the default-namespace label.
 */
export async function resolveCorpusNamespaceRoots(options: {
  config: PluginConfig;
}): Promise<CorpusNamespaceRoot[]> {
  const { config } = options;
  const configDriven = await listNamespaces({ config });
  let catalogRecords: ReadonlyArray<{ namespace: string; storageDir: string }> = [];
  try {
    // Returns [] when the catalog is opted out, leaving config-driven authoritative.
    catalogRecords = await new NamespaceCatalog(config).listNamespaces();
  } catch {
    // Catalog unreadable — config-driven enumeration stands alone.
  }

  // Default namespace first so it wins the representative label when several
  // configured names collapse onto one root (namespaces disabled → memoryDir).
  const ordered = [
    ...configDriven.filter((entry) => entry.namespace === config.defaultNamespace),
    ...configDriven.filter((entry) => entry.namespace !== config.defaultNamespace),
  ];
  const seenNamespaces = new Set<string>();
  const seenRoots = new Set<string>();
  const roots: CorpusNamespaceRoot[] = [];
  const add = (namespace: string, rootDir: string): void => {
    if (seenNamespaces.has(namespace) || seenRoots.has(rootDir)) return;
    seenNamespaces.add(namespace);
    seenRoots.add(rootDir);
    roots.push({ namespace, rootDir });
  };
  for (const entry of ordered) add(entry.namespace, entry.rootDir);
  for (const record of catalogRecords) {
    if (typeof record.namespace === "string" && record.namespace.length > 0 && typeof record.storageDir === "string") {
      add(record.namespace, record.storageDir);
    }
  }
  if (roots.length === 0) {
    roots.push({ namespace: config.defaultNamespace, rootDir: config.memoryDir });
  }
  return roots;
}

/**
 * Divergence detection tolerates a watermark that is stale by up to a minute
 * (peers are compared on a slow cadence); a health/readiness probe does NOT
 * tolerate a full corpus scan (a recursive realpath-per-Markdown-file walk) on
 * every request. This TTL is that trade-off: recompute a namespace's watermark
 * at most once per window; probes in between serve the cached census (whose
 * `computedAt` shows its staleness).
 */
export const WATERMARK_CACHE_TTL_MS = 60_000;

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

  constructor(options: { ttlMs?: number; clock?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? WATERMARK_CACHE_TTL_MS;
    this.clock = options.clock ?? Date.now;
  }

  get(namespace: string, compute: () => Promise<CorpusWatermark>): CorpusWatermark | undefined {
    const cached = this.entries.get(namespace);
    const fresh = cached !== undefined && this.clock() < cached.expiresAt;
    if (!fresh) this.refresh(namespace, compute);
    return cached?.value;
  }

  private refresh(namespace: string, compute: () => Promise<CorpusWatermark>): void {
    if (this.inFlight.has(namespace)) return; // single-flight: one background scan per namespace
    const pending = compute()
      .then((value) => {
        this.entries.set(namespace, { value, expiresAt: this.clock() + this.ttlMs });
      })
      .catch(() => {
        // Failed/unreadable scan: never cache it; keep serving any stale value.
      })
      .finally(() => {
        this.inFlight.delete(namespace);
      });
    this.inFlight.set(namespace, pending);
  }

  /** Await all in-flight background refreshes (shutdown / deterministic tests). */
  async whenIdle(): Promise<void> {
    await Promise.all([...this.inFlight.values()]);
  }
}

/** Orchestrator surface the service watermark builder reads — satisfied by Orchestrator. */
export interface CorpusWatermarkHost {
  config: PluginConfig;
  getStorage(namespace: string): CorpusStorage | Promise<CorpusStorage>;
}

export interface ServiceCorpusWatermarkOptions {
  /** Stale-while-revalidate cache so probes never await the corpus scan. */
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
  let roots: CorpusNamespaceRoot[];
  try {
    roots = await resolveCorpusNamespaceRoots({ config: host.config });
  } catch {
    return [];
  }
  const visible = roots.filter((root) => capabilityAllowsNamespace(options.caps, root.namespace));
  const watermarks: CorpusWatermark[] = [];
  for (const { namespace } of visible) {
    const compute = async (): Promise<CorpusWatermark> =>
      computeNamespaceWatermark(namespace, await host.getStorage(namespace), options.now);
    if (options.cache) {
      const cached = options.cache.get(namespace, compute);
      if (cached) watermarks.push(cached);
    } else {
      try {
        watermarks.push(await compute());
      } catch {
        // One tenant's storage/scan failed — omit just that namespace.
      }
    }
  }
  return watermarks;
}
