/**
 * trust-score-stage.ts — signal adapters + recall pipeline stage (issue #1577 PR 2).
 *
 * This module sits between the pure {@link computeTrustScore} scorer and the
 * recall pipeline. It owns TWO jobs:
 *
 *   1. **Signal adapters** — read each trust signal via existing readers only
 *      (`buildMemoryWorthCounterMap`-style frontmatter scan, faithfulness /
 *      provenance / sources frontmatter from #1575/#1576). No new disk format,
 *      no new write path. Expensive / optional signals (belief-ledger domain
 *      calibration, contradiction review queue) are extension points that
 *      return `undefined` when unwired — the scorer degrades to neutral for
 *      any absent signal (rule 34).
 *
 *   2. **The recall stage** — apply `trustMultiplier(trust.score)` to each
 *      candidate, exclude `quarantine`-band items from injection, and surface
 *      the per-result `{ score, band, components }` so X-ray and the epistemic
 *      renderer can explain the basis.
 *
 * Mutual exclusion with the Memory Worth filter (rule 39 — one multiplier, one
 * application point): when this stage runs, the standalone memory-worth filter
 * MUST NOT also run. The orchestrator enforces that at the wiring site
 * (`if (caps.recallTrustScore) … else if (caps.recallMemoryWorthFilter) …`);
 * the `double-multiplier` test below pins it structurally.
 */

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

/**
 * Frontmatter projection the adapter reads. Kept narrow + structural so it can
 * be fed from a `MemoryFrontmatter`, a bench fixture, or a test stub without
 * pulling the full frontmatter type graph into the stage module.
 */
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

    // Memory worth — reuse the exact Laplace computation the standalone filter
    // uses so the two never disagree on the same counters.
    if (fm.mw_success !== undefined || fm.mw_fail !== undefined) {
      // Pass the half-life through so outcome counters decay at the same
      // rate as the standalone memory-worth filter (review P2: TrustScore
      // subsumes the filter, so decay must not be lost). Convert days → ms.
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
      // `skipped_no_span` (legacy fact lacking a verified source span) carries
      // no entailment signal — collapse it to `unchecked` so the scorer treats
      // it as the neutral "no verdict" case rather than a hard negative.
      signals.faithfulness =
        fm.faithfulness.verdict === "skipped_no_span" ? "unchecked" : fm.faithfulness.verdict;
    }

    // Corroboration = distinct source sessions/turns backing the fact.
    if (Array.isArray(fm.sources) && fm.sources.length > 0) {
      const distinct = new Set(
        fm.sources.map((s) => `${s.sessionKey ?? ""}|${s.turnId ?? ""}`),
      );
      signals.corroborationCount = distinct.size;
    }

    // Recency: prefer an explicit observation timestamp; fall back to
    // lastAccessed. Days-old vs the per-category half-life the caller supplies.
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

    // Only record an entry when at least one signal is present — a fully-empty
    // entry would score neutral anyway, and skipping keeps the map small.
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
}

/** One candidate after the TrustScore stage. */
export interface TrustStageResultItem {
  path: string;
  /** Final score after the trust multiplier is applied. */
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
  /** Multiplier bounds; see {@link trustMultiplier}. */
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

/** Output of {@link applyTrustScoreStage}. */
export interface TrustStageOutput {
  /** Admitted (injectable) candidates, score-multiplied and optionally sorted. */
  admitted: TrustStageResultItem[];
  /**
   * Quarantined candidates — excluded from injection but visible to X-ray with
   * the reason (rule 34 — exclusion must never look like "no result"). Callers
   * that only need the injected list read `admitted`; X-ray reads `all`.
   */
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
    const signals = options.signals.get(c.path);
    const trust = computeTrustScore(signals, options.weights);
    const isQuarantined = quarantine && trust.band === "quarantine";
    // Quarantined items are excluded from injection. Keep their score unchanged
    // so X-ray shows what the pipeline WOULD have injected — never inflate or
    // zero the score of a hidden item (rule 34).
    const multiplier = isQuarantined ? 1 : trustMultiplier(trust.score, minMul, maxMul);
    // Clamp the base score at zero before multiplying, mirroring the
    // memory-worth filter: a negative base would invert the multiplier's
    // intended direction (see memory-worth-filter.ts:145-153).
    const safeBase = c.score < 0 ? 0 : c.score;
    const scored = safeBase * multiplier;
    const item: TrustStageResultItem = {
      path: c.path,
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
    // Stable sort by descending multiplied score, with original input position
    // as the deterministic tiebreaker (CLAUDE.md rule 19 / checklist §12).
    admitted.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Tiebreaker: original insertion order. We don't have the index handy on
      // the item, so derive it from `all` ordering (input order is preserved
      // there). Equal-score items keep first-seen-first order.
      return 0;
    });
    // Node's sort is stable (ES2019+); the explicit `return 0` documents the
    // contract for reviewers.
  }

  return { admitted, quarantined, all };
}

/**
 * Compact X-ray projection of one stage item. Kept separate from the full
 * `TrustScoreResult` so the X-ray snapshot type stays narrow and serializable,
 * and so the renderer never depends on the scorer's internal component map
 * shape beyond `{ value, weight }`.
 */
export interface TrustXrayProjection {
  score: number;
  band: TrustBand;
  components: Record<string, TrustScoreComponent>;
  multiplier: number;
  quarantined: boolean;
  /** Human-readable exclusion reason, present only when quarantined. */
  quarantineReason?: string;
}

/** Build the X-ray projection for one stage result item. */
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


// ─── Recall-stage signal builder (I/O orchestration) ──────────────────────

/**
 * Narrow callbacks the signal builder needs from its host (the orchestrator).
 * Kept as interfaces so the module stays pure-testable: the host binds
 * `getStorage` / `readQmdResultMemory` into these and the builder owns cache
 * management, namespace iteration, and the cold-tier direct fallback.
 */
export interface TrustScoreRerankDeps {
  /** Read every memory in a namespace for the hot-tier signal scan. */
  readNamespaceMemories(
    namespace: string,
  ): Promise<ReadonlyArray<{ path: string; frontmatter: TrustFrontmatterProjection }>>;
  /** Read one memory's frontmatter by path (cold-tier direct fallback). */
  readMemoryFrontmatter(path: string): Promise<TrustFrontmatterProjection | null>;
  /**
   * Current cross-process corpus version for a namespace (issue #1905). Used
   * to key the per-namespace corpus-fallback cache so it invalidates on the
   * next memory mutation instead of on a wall-clock timer that is shorter than
   * recall latency (which produced a permanent steady-state miss).
   */
  getNamespaceVersion(namespace: string): Promise<number>;
}

/**
 * Per-namespace signal cache the host owns and the builder mutates. Keyed on
 * the shared corpus version (issue #1905): an entry is valid iff its `version`
 * still equals the namespace's current corpus version AND it is younger than
 * TRUST_SIGNAL_CACHE_MAX_AGE_MS. The age bound is required because trust
 * signals bake wall-clock time into their values (ageDays,
 * computeMemoryWorth(..., now) with recency half-life) — pure version
 * invalidation would serve stale decay on a read-only corpus (#1905, Codex).
 */
export interface TrustScoreSignalCache {
  cache: Map<string, { version: number; cachedAt: number; signals: ReadonlyMap<string, TrustSignals> }>;
}

/** See TrustScoreSignalCache — bounds time-based staleness of cached signals. */
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
  candidatePaths: readonly string[],
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
    /**
     * Cooperative cancellation (issue #1905, Codex): when the recall's shared
     * enrichment-assembly deadline wins the race, the host aborts this signal
     * so an orphaned corpus scan / direct-read loop stops at the next loop
     * boundary instead of continuing to burn I/O after recall already returned.
     */
    abortSignal?: AbortSignal;
  } = {},
): Promise<Map<string, TrustSignals>> {
  const logDebug = options.logDebug ?? (() => {});
  const signals = new Map<string, TrustSignals>();
  const corpusFallbackEnabled = options.corpusFallbackEnabled ?? true;
  const halfLife = { recencyHalfLifeDays: options.recencyHalfLifeDays };

  // Paths examined via preloaded frontmatter (issue #1905, Cursor/Codex).
  // buildTrustSignalMap deliberately OMITS neutral memories (no trust fields),
  // so a preloaded candidate can be examined yet absent from `signals` — it
  // must NOT be treated as missing, or the corpus fallback + direct read fire
  // for every uninstrumented hot candidate, defeating the O(candidates) path.
  // Absent-from-signals still means multiplier 1.0 downstream, exactly what a
  // corpus scan would have produced for the same neutral memory.
  const preloadedPaths = new Set<string>();

  // O(candidates) fast path: seed signals from candidate frontmatter already
  // loaded on the hot recall path. Reuses the exact `buildTrustSignalMap`
  // computation so a candidate's signals equal what a corpus scan produced.
  if (options.preloadedFrontmatter) {
    const preloaded: Array<{ path: string; frontmatter: TrustFrontmatterProjection }> = [];
    for (const path of candidatePaths) {
      const mem = options.preloadedFrontmatter.get(path);
      if (!mem) continue;
      preloadedPaths.add(path);
      preloaded.push({ path, frontmatter: mem.frontmatter });
    }
    if (preloaded.length > 0) {
      const seeded = buildTrustSignalMap(preloaded, now, halfLife);
      for (const [path, s] of seeded) signals.set(path, s);
    }
  }

  // Corpus-level fallback (config-gated): candidates still missing probe a
  // per-namespace signal map, cached and invalidated by the shared
  // cross-process corpus version. Only candidate rows are copied out — never
  // the whole map (issue #1905, no per-recall full-map union).
  if (corpusFallbackEnabled) {
    const seenNamespaces = new Set<string>();
    for (const ns of namespaces) {
      // Cooperative cancellation: the recall's assembly deadline may have won
      // the race — stop before starting another namespace scan (#1905, Codex).
      if (options.abortSignal?.aborted) break;
      if (seenNamespaces.has(ns)) continue;
      seenNamespaces.add(ns);
      if (candidatePaths.every((p) => signals.has(p) || preloadedPaths.has(p))) break;
      try {
        const version = await deps.getNamespaceVersion(ns);
        const cached = signalCache.cache.get(ns);
        const nowMs = now.getTime();
        let nsMap: ReadonlyMap<string, TrustSignals>;
        // Valid iff the corpus version still matches AND the entry is younger
        // than the max age: trust signals bake `now` into their values, so an
        // unchanged corpus still goes stale as wall-clock advances (#1905, Codex).
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
        for (const p of candidatePaths) {
          // Preloaded paths were already examined — absent-from-signals means
          // neutral (multiplier 1.0), identical to what the corpus map holds.
          if (signals.has(p) || preloadedPaths.has(p)) continue;
          const s = nsMap.get(p);
          if (s) signals.set(p, s);
        }
      } catch (err) {
        logDebug("trust-score: failed to read namespace, skipping", {
          namespace: ns,
          error: (err as Error).message,
        });
      }
    }
  }

  // Direct per-path fallback for candidates still absent (cold-tier / archive).
  // Preloaded paths are excluded — they were examined and are neutral priors.
  // Bounded-parallel (≤16) to match loadSearchResultMemoryMap's batch size.
  const missing = candidatePaths.filter((p) => !signals.has(p) && !preloadedPaths.has(p));
  if (missing.length > 0) {
    const fallbackMemories: Array<{ path: string; frontmatter: TrustFrontmatterProjection }> = [];
    const BATCH = 16;
    for (let off = 0; off < missing.length; off += BATCH) {
      // Cooperative cancellation between batches (#1905, Codex).
      if (options.abortSignal?.aborted) break;
      const batch = await Promise.all(
        missing.slice(off, off + BATCH).map(async (path) => {
          try {
            const frontmatter = await deps.readMemoryFrontmatter(path);
            return frontmatter ? { path, frontmatter } : null;
          } catch (err) {
            logDebug("trust-score: direct path lookup failed", {
              path,
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
      for (const [path, s] of fallbackSignals) signals.set(path, s);
    }
  }

  return signals;
}
