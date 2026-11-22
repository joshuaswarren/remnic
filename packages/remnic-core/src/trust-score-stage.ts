import type { QmdSearchResult } from "./types.js";

/** Stable key for a recall result whose path may repeat across namespaces. */
export function trustResultKey(result: Pick<QmdSearchResult, "path" | "namespace">): string {
  return JSON.stringify([result.namespace ?? "", result.path]);
}

/** Read trust metadata while accepting pre-namespace path-only maps. */
export function trustResultFor(
  trustByPath: ReadonlyMap<string, TrustStageResultItem>,
  result: Pick<QmdSearchResult, "path" | "namespace">,
): TrustStageResultItem | undefined {
  return trustByPath.get(trustResultKey(result)) ?? trustByPath.get(result.path);
}


import { computeMemoryWorth } from "./memory-worth.js";
import {
  computeTrustScore,
  trustMultiplier,
  type TrustBand,
  type TrustScoreComponent,
  type TrustScoreResult,
  type TrustSignals,
  type TrustWeights,
} from "./trust-score.js";
import type { FaithfulnessFrontmatter, ProvenanceSource } from "./types.js";

export interface TrustFrontmatterProjection {
  mw_success?: number;
  mw_fail?: number;
  lastAccessed?: string | null;
  provenance?: "verified" | "unverified" | "none";
  faithfulness?: FaithfulnessFrontmatter;
  sources?: ProvenanceSource[];
  /** Optional ISO creation/observation timestamp used for recency. */
  observedAt?: string;
}

/**
 * Build a `path → TrustSignals` map from an in-memory frontmatter scan. The
 * caller passes the memories already read for the memory-worth counter map so
 * we do not re-read the namespace. Pure: no I/O, takes `now` explicitly.
 */
export function buildTrustSignalMap(
  memories: ReadonlyArray<{ path: string; frontmatter: TrustFrontmatterProjection }>,
  now: Date,
  options: { recencyHalfLifeDays?: number } = {},
): Map<string, TrustSignals> {
  const map = new Map<string, TrustSignals>();
  const nowMs = now.getTime();
  const nowUsable = Number.isFinite(nowMs);
  for (const m of memories) {
    const fm = m.frontmatter;
    const signals: TrustSignals = {};

    if (fm.mw_success !== undefined || fm.mw_fail !== undefined) {
      const halfLifeMs =
        options.recencyHalfLifeDays !== undefined
          ? options.recencyHalfLifeDays * 86_400_000
          : undefined;
      const worth = computeMemoryWorth({
        mw_success: fm.mw_success,
        mw_fail: fm.mw_fail,
        lastAccessed: fm.lastAccessed,
        now,
        halfLifeMs,
      });
      signals.memoryWorth = { score: worth.score, confidence: worth.confidence };
    }

    if (fm.provenance !== undefined) signals.provenance = fm.provenance;
    if (fm.faithfulness !== undefined) {
      signals.faithfulness =
        fm.faithfulness.verdict === "skipped_no_span" ? "unchecked" : fm.faithfulness.verdict;
    }

    if (Array.isArray(fm.sources) && fm.sources.length > 0) {
      const distinct = new Set(
        fm.sources.map((s) => `${s.sessionKey ?? ""}|${s.turnId ?? ""}`),
      );
      signals.corroborationCount = distinct.size;
    }

    const ts = fm.observedAt ?? fm.lastAccessed;
    if (nowUsable && typeof ts === "string" && ts.length > 0) {
      const parsed = Date.parse(ts);
      if (Number.isFinite(parsed)) {
        const ageDays = Math.max(0, (nowMs - parsed) / (24 * 60 * 60 * 1000));
        signals.ageDays = ageDays;
        if (options.recencyHalfLifeDays !== undefined) {
          signals.recencyHalfLifeDays = options.recencyHalfLifeDays;
        }
      }
    }

    if (Object.keys(signals).length > 0) {
      map.set(m.path, signals);
    }
  }
  return map;
}

/** A scored recall candidate (mirrors `MemoryWorthFilterCandidate`). */
export interface TrustStageCandidate {
  path: string;
  score: number;
  /** Namespace-aware result key used to preserve result identity through rerank. */
  key?: string;
}

export interface TrustStageResultItem {
  path: string;
  /** Namespace-aware result key used to preserve result identity through rerank. */
  key?: string;
  score: number;
  /** The untouched input score — for telemetry / X-ray. */
  originalScore: number;
  /** The multiplier applied (exactly `1.0` for neutral / quarantined-kept). */
  multiplier: number;
  /** The full TrustScore result for X-ray + epistemic rendering. */
  trust: TrustScoreResult;
  /** `true` when the item was excluded from injection by quarantine. */
  quarantined: boolean;
}

export interface TrustStageOptions {
  /** `path → TrustSignals`. Candidates absent from the map score neutral. */
  signals: ReadonlyMap<string, TrustSignals>;
  weights?: TrustWeights;
  minMultiplier?: number;
  maxMultiplier?: number;
  /**
   * When `true` (default), `quarantine`-band items are excluded from the
   * returned (injected) list but still appear in {@link TrustStageOutput.all}
   * with `quarantined: true` so X-ray can surface them with a reason.
   * Only effective when the stage is active at all.
   */
  quarantine?: boolean;
  /**
   * Re-sort admitted candidates by descending multiplied score. Default `true`.
   * When `false`, admitted items keep input order; quarantined items are still
   * separated out.
   */
  reorder?: boolean;
}

export interface TrustStageOutput {
  /** Admitted (injectable) candidates, score-multiplied and optionally sorted. */
  admitted: TrustStageResultItem[];
  quarantined: TrustStageResultItem[];
  /** Every candidate (admitted + quarantined) in input order, for X-ray. */
  all: TrustStageResultItem[];
}

/**
 * Apply the unified TrustScore stage: score each candidate, multiply its base
 * score by `trustMultiplier(trust.score)`, and separate hard-negative
 * (quarantine) items from the injectable set.
 *
 * Neutral candidates (no signals → multiplier `1.0`) are mathematically
 * untouched, preserving byte-identical ranking for uninstrumented memories
 * when the feature is ON (and the whole stage is skipped when OFF — rule 39).
 */
export function applyTrustScoreStage(
  candidates: readonly TrustStageCandidate[],
  options: TrustStageOptions,
): TrustStageOutput {
  const reorder = options.reorder !== false;
  const quarantine = options.quarantine !== false;
  const minMul = options.minMultiplier;
  const maxMul = options.maxMultiplier;

  const all: TrustStageResultItem[] = [];
  const admitted: TrustStageResultItem[] = [];
  const quarantined: TrustStageResultItem[] = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i]!;
    const signals = options.signals.get(c.key ?? c.path) ?? options.signals.get(c.path);
    const trust = computeTrustScore(signals, options.weights);
    const isQuarantined = quarantine && trust.band === "quarantine";
    const multiplier = isQuarantined ? 1 : trustMultiplier(trust.score, minMul, maxMul);
    const safeBase = c.score < 0 ? 0 : c.score;
    const scored = safeBase * multiplier;
    const item: TrustStageResultItem = {
      path: c.path,
      ...(c.key === undefined ? {} : { key: c.key }),
      score: scored,
      originalScore: c.score,
      multiplier,
      trust,
      quarantined: isQuarantined,
    };
    all.push(item);
    if (isQuarantined) quarantined.push(item);
    else admitted.push(item);
  }

  if (reorder) {
    admitted.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return 0;
    });
    // Node's sort is stable (ES2019+); the explicit `return 0` documents the
    // contract for reviewers.
  }

  return { admitted, quarantined, all };
}

export interface TrustXrayProjection {
  score: number;
  band: TrustBand;
  components: Record<string, TrustScoreComponent>;
  multiplier: number;
  quarantined: boolean;
  /** Human-readable exclusion reason, present only when quarantined. */
  quarantineReason?: string;
}

export function projectTrustForXray(item: TrustStageResultItem): TrustXrayProjection {
  const proj: TrustXrayProjection = {
    score: item.trust.score,
    band: item.trust.band,
    components: item.trust.components,
    multiplier: item.multiplier,
    quarantined: item.quarantined,
  };
  if (item.quarantined) {
    proj.quarantineReason = explainQuarantine(item.trust);
  }
  return proj;
}

/** Deterministic, component-derived reason a memory was quarantined. */
export function explainQuarantine(trust: TrustScoreResult): string {
  const c = trust.components;
  if (c.faithfulness && c.faithfulness.value === 0) return "faithfulness: contradicted";
  if (c.contradiction && c.contradiction.value <= 0.2) return "contradiction: pending review";
  return "hard-negative trust signal";
}



export interface TrustScoreRerankDeps {
  readNamespaceMemories(
    namespace: string,
  ): Promise<ReadonlyArray<{ path: string; frontmatter: TrustFrontmatterProjection }>>;
  readMemoryFrontmatter(
    path: string,
    preferredNamespace?: string,
  ): Promise<TrustFrontmatterProjection | null>;
  getNamespaceVersion(namespace: string): Promise<number>;
}

export interface TrustScoreSignalCache {
  cache: Map<string, { version: number; cachedAt: number; signals: ReadonlyMap<string, TrustSignals> }>;
}

export const TRUST_SIGNAL_CACHE_MAX_AGE_MS = 300_000;

/** Bound on distinct namespaces retained; overflow evicts the oldest. */
export const TRUST_SIGNAL_CACHE_MAX_NAMESPACES = 64;

/** Insert-ordered bounded set: evict the oldest namespace on overflow. */
function capTrustSignalCache(cache: TrustScoreSignalCache["cache"], max: number): void {
  while (cache.size > max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Build the `path → TrustSignals` map for recall candidates.
 *
 * O(candidates) inversion (issue #1905): when the host passes
 * `preloadedFrontmatter` (frontmatter already loaded on the hot recall path),
 * candidate signals are seeded directly from it — no corpus scan. Only
 * candidates still missing fall back to the corpus-level per-namespace map
 * (config-gated, version-keyed so it actually hits in steady state) and then
 * to a bounded-parallel direct per-path read.
 *
 * Fail-open: a single unreadable namespace or memory is logged and skipped so
 * a storage hiccup never breaks recall (mirrors `memory-worth-filter.ts`).
 */
export async function buildTrustSignalsForRerank(
  candidates: readonly (
    | string
    | { path: string; signalKey?: string; lookupKey?: string; namespace?: string }
  )[],
  namespaces: readonly string[],
  deps: TrustScoreRerankDeps,
  signalCache: TrustScoreSignalCache,
  now: Date,
  options: {
    recencyHalfLifeDays?: number;
    logDebug?: (message: string, context: Record<string, unknown>) => void;
    /**
     * Candidate frontmatter already loaded on the hot recall path (issue
     * #1905). When present, candidate signals are seeded from it before any
     * corpus scan, so the common warm-candidate recall does zero
     * `readNamespaceMemories` calls. Structural — a `MemoryFile` map satisfies
     * `{ frontmatter: TrustFrontmatterProjection }` without importing it.
     */
    preloadedFrontmatter?: ReadonlyMap<string, { frontmatter: TrustFrontmatterProjection }>;
    /**
     * When false, skip the corpus-level `readNamespaceMemories` fallback
     * entirely (candidates-first + direct-read only). Defaults to true so the
     * corpus path stays reachable. See `recallTrustStageCorpusFallbackEnabled`.
     */
    corpusFallbackEnabled?: boolean;
    abortSignal?: AbortSignal;
  } = {},
): Promise<Map<string, TrustSignals>> {
  const logDebug = options.logDebug ?? (() => {});
  const signals = new Map<string, TrustSignals>();
  const corpusFallbackEnabled = options.corpusFallbackEnabled ?? true;
  const halfLife = { recencyHalfLifeDays: options.recencyHalfLifeDays };

  const preloadedKeys = new Set<string>();

  const normalized = candidates.map((c) =>
    typeof c === "string"
      ? { path: c, signalKey: c, lookupKey: c, namespace: undefined as string | undefined }
      : {
          path: c.path,
          signalKey: c.signalKey ?? c.path,
          lookupKey: c.lookupKey ?? c.path,
          namespace: c.namespace,
        },
  );

  if (options.preloadedFrontmatter) {
    const preloaded: Array<{ path: string; frontmatter: TrustFrontmatterProjection }> = [];
    for (const c of normalized) {
      const mem =
        options.preloadedFrontmatter.get(c.lookupKey) ??
        options.preloadedFrontmatter.get(c.path);
      if (!mem) continue;
      preloadedKeys.add(c.signalKey);
      preloaded.push({ path: c.signalKey, frontmatter: mem.frontmatter });
    }
    if (preloaded.length > 0) {
      const seeded = buildTrustSignalMap(preloaded, now, halfLife);
      for (const [key, s] of seeded) signals.set(key, s);
    }
  }

  if (corpusFallbackEnabled) {
    const seenNamespaces = new Set<string>();
    for (const ns of namespaces) {
      if (options.abortSignal?.aborted) break;
      if (seenNamespaces.has(ns)) continue;
      seenNamespaces.add(ns);
      if (normalized.every((c) => signals.has(c.signalKey) || preloadedKeys.has(c.signalKey))) break;
      try {
        const version = await deps.getNamespaceVersion(ns);
        const cached = signalCache.cache.get(ns);
        const nowMs = now.getTime();
        let nsMap: ReadonlyMap<string, TrustSignals>;
        if (
          cached &&
          cached.version === version &&
          nowMs - cached.cachedAt < TRUST_SIGNAL_CACHE_MAX_AGE_MS
        ) {
          nsMap = cached.signals;
        } else {
          const memories = await deps.readNamespaceMemories(ns);
          nsMap = buildTrustSignalMap(memories, now, halfLife);
          signalCache.cache.set(ns, { version, cachedAt: nowMs, signals: nsMap });
          capTrustSignalCache(signalCache.cache, TRUST_SIGNAL_CACHE_MAX_NAMESPACES);
        }
        for (const c of normalized) {
          if (signals.has(c.signalKey) || preloadedKeys.has(c.signalKey)) continue;
          if (c.namespace !== undefined && c.namespace !== ns) continue;
          const s = nsMap.get(c.path);
          if (s) signals.set(c.signalKey, s);
        }
      } catch (err) {
        logDebug("trust-score: failed to read namespace, skipping", {
          namespace: ns,
          error: (err as Error).message,
        });
      }
    }
  }

  const missing = normalized.filter(
    (c) => !signals.has(c.signalKey) && !preloadedKeys.has(c.signalKey),
  );
  if (missing.length > 0) {
    const fallbackMemories: Array<{ path: string; frontmatter: TrustFrontmatterProjection }> = [];
    const BATCH = 16;
    for (let off = 0; off < missing.length; off += BATCH) {
      if (options.abortSignal?.aborted) break;
      const batch = await Promise.all(
        missing.slice(off, off + BATCH).map(async (c) => {
          try {
            const frontmatter = await deps.readMemoryFrontmatter(c.path, c.namespace);
            return frontmatter ? { path: c.signalKey, frontmatter } : null;
          } catch (err) {
            logDebug("trust-score: direct path lookup failed", {
              path: c.path,
              error: (err as Error).message,
            });
            return null;
          }
        }),
      );
      for (const item of batch) if (item) fallbackMemories.push(item);
    }
    if (fallbackMemories.length > 0) {
      const fallbackSignals = buildTrustSignalMap(fallbackMemories, now, halfLife);
      for (const [key, s] of fallbackSignals) signals.set(key, s);
    }
  }

  return signals;
}
