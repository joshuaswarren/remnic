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
 * content hash — two daemons that agree on how many active memories live in
 * each `<tier>:<category>/<day>` partition produce the same digest, so a
 * differing digest is a cheap divergence signal without reading or hashing file
 * bodies. Buckets are tier-aware (`hot:` / `cold:`): demoted memories stay
 * active and reachable via cold recall, so the census counts BOTH tiers and a
 * hot/cold split shows in the digest rather than being silently folded together
 * (issue #2156 finding D). `newestWriteAt` stays scoped to the newest HOT
 * partition only, so the freshness probe stays O(one day's active files) even
 * on a 100k+ corpus.
 *
 * Two consumers share this module: the authenticated `/health` route (behind a
 * bounded TTL + single-flight {@link CorpusWatermarkCache}, filtered to the
 * caller's namespaces) and the `remnic doctor` corpus check. Both resolve their
 * namespace set through the ONE {@link resolveCorpusNamespaceRoots} helper so
 * they cannot drift and silently omit a tenant (issue #2156 finding C).
 */

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { capabilityAllowsNamespace, type TokenCapabilities } from "./access-token-capabilities.js";
import { listNamespaces } from "./namespaces/migrate.js";
import type { PluginConfig } from "./types.js";

export interface CorpusWatermark {
  namespace: string;
  activeMemoryCount: number;
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
  const computedAt = (input.now ?? new Date()).toISOString();

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

  return {
    namespace,
    activeMemoryCount: paths.length,
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
  collectActiveMemoryPaths(): Promise<string[]>;
  /** Cold-tier (demoted-but-reachable) memory paths (issue #2156 finding D). */
  collectColdMemoryPaths(): Promise<string[]>;
}

/**
 * Compute one namespace's watermark from its storage, spanning BOTH tiers so a
 * cold-tier divergence is caught. The two collectors run concurrently; each
 * returns paths only (no frontmatter parse), and neither throws on a missing
 * tier, so the probe stays cheap and never fails on an empty cold tree.
 */
async function computeNamespaceWatermark(
  namespace: string,
  storage: CorpusStorage,
  now?: Date,
): Promise<CorpusWatermark> {
  const [hotPaths, coldPaths] = await Promise.all([
    storage.collectActiveMemoryPaths(),
    storage.collectColdMemoryPaths(),
  ]);
  return computeCorpusWatermark({ namespace, paths: [...hotPaths, ...coldPaths], baseDir: storage.dir, now });
}

/**
 * Compute watermarks for a set of namespaces. A namespace whose storage is
 * unavailable is skipped rather than failing the whole read, so a single bad
 * namespace never blanks the health/doctor payload.
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
      // Storage unavailable for this namespace — degrade gracefully.
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
 * two surfaces cannot drift and silently omit a tenant from the divergence
 * signal. Config-driven enumeration is authoritative because it still works
 * when the namespace catalog is opted out (`namespaceCatalogEnabled: false`) or
 * not yet populated — a live-catalog scan returns nothing in that state. Live
 * catalog names are unioned in when supplied (health) so a freshly-registered
 * namespace not yet on disk is still covered. Deduped by resolved root so a
 * namespaces-disabled / flat-root deployment reports its single shared corpus
 * once, under the default-namespace label.
 */
export async function resolveCorpusNamespaceRoots(options: {
  config: PluginConfig;
  catalogNamespaces?: readonly string[];
  rootDirFor?: (namespace: string) => string | Promise<string>;
}): Promise<CorpusNamespaceRoot[]> {
  const { config } = options;
  const configDriven = await listNamespaces({ config });
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
  for (const namespace of options.catalogNamespaces ?? []) {
    if (typeof namespace !== "string" || namespace.length === 0 || seenNamespaces.has(namespace)) continue;
    if (!options.rootDirFor) continue;
    try {
      add(namespace, await options.rootDirFor(namespace));
    } catch {
      // Storage unresolvable for a catalog-only namespace — skip it, never fail
      // the whole enumeration.
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
 * at most once per window and serve the cached census — which carries its own
 * `computedAt` so a consumer can see the staleness — to every probe in between.
 */
export const WATERMARK_CACHE_TTL_MS = 60_000;

/**
 * Instance-scoped (AGENTS.md pattern 5 — never a bare module global) TTL +
 * single-flight cache in front of the per-namespace corpus scan. Back-to-back
 * probes reuse the cached watermark; N concurrent probes for one namespace
 * collapse to ONE scan via the in-flight promise map instead of N recursive
 * realpath-per-file walks. Owned by the long-lived access service instance.
 */
export class CorpusWatermarkCache {
  private readonly entries = new Map<string, { value: CorpusWatermark; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<CorpusWatermark>>();
  private readonly ttlMs: number;
  private readonly clock: () => number;

  constructor(options: { ttlMs?: number; clock?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? WATERMARK_CACHE_TTL_MS;
    this.clock = options.clock ?? Date.now;
  }

  async get(namespace: string, compute: () => Promise<CorpusWatermark>): Promise<CorpusWatermark> {
    const cached = this.entries.get(namespace);
    if (cached && this.clock() < cached.expiresAt) return cached.value;

    const pending = this.inFlight.get(namespace);
    if (pending) return pending;

    const promise = (async () => {
      const value = await compute();
      this.entries.set(namespace, { value, expiresAt: this.clock() + this.ttlMs });
      return value;
    })();
    this.inFlight.set(namespace, promise);
    try {
      return await promise;
    } finally {
      // Clear the in-flight marker whether it resolved or rejected; a failed
      // scan is never cached, so the next probe retries a clean computation.
      this.inFlight.delete(namespace);
    }
  }
}

/** Orchestrator surface the service watermark builder reads — satisfied by Orchestrator. */
export interface CorpusWatermarkHost {
  config: PluginConfig;
  namespaceCatalog?: { listNamespaces?(): Promise<ReadonlyArray<{ namespace: string }>> };
  getStorage(namespace: string): CorpusStorage | Promise<CorpusStorage>;
}

export interface ServiceCorpusWatermarkOptions {
  /** Bounded cache so routine probes do not re-scan the corpus every request. */
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
 * resolved through {@link resolveCorpusNamespaceRoots} (config-driven, catalog
 * unioned in), filtered to the caller's capabilities, then each is computed
 * through the (optional) TTL + single-flight cache. Degrades to an empty array
 * — never throws — if enumeration or storage is unavailable.
 */
export async function computeServiceCorpusWatermarks(
  host: CorpusWatermarkHost,
  options: ServiceCorpusWatermarkOptions = {},
): Promise<CorpusWatermark[]> {
  try {
    const catalogRecords = (await host.namespaceCatalog?.listNamespaces?.()) ?? [];
    const catalogNamespaces = catalogRecords
      .map((record) => record?.namespace)
      .filter((namespace): namespace is string => typeof namespace === "string" && namespace.length > 0);
    const roots = await resolveCorpusNamespaceRoots({
      config: host.config,
      catalogNamespaces,
      rootDirFor: async (namespace) => (await host.getStorage(namespace)).dir,
    });
    const visible = roots.filter((root) => capabilityAllowsNamespace(options.caps, root.namespace));
    const watermarks: CorpusWatermark[] = [];
    for (const { namespace } of visible) {
      const compute = async (): Promise<CorpusWatermark> =>
        computeNamespaceWatermark(namespace, await host.getStorage(namespace), options.now);
      watermarks.push(options.cache ? await options.cache.get(namespace, compute) : await compute());
    }
    return watermarks;
  } catch {
    return [];
  }
}
