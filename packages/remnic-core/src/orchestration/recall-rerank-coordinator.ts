/**
 * Recall rerank coordinator — extracted from the orchestrator (issue #1526).
 *
 * Owns the post-retrieval result-ranking subsystem: Memory-Worth reranking,
 * TrustScore scoring + quarantine, reasoning-trace boost, and MMR
 * diversification/limiting. Behavior-preserving move from orchestrator.ts —
 * no logic changes; the orchestrator constructs one instance and keeps thin
 * delegating methods so existing call sites (recallInternal,
 * applyColdFallbackPipeline) continue to work.
 *
 * Config, storage, and the QMD-result memory reader are accessed through
 * getter callbacks (not captured at construction) so that post-construction
 * reassignment of the orchestrator's live fields is honored. This mirrors
 * the ConversationIndexCoordinator / TierMigrationCoordinator accessor
 * pattern.
 */

import { resolveCapabilities, type CapabilitySet } from "../capabilities.js";
import type { PluginConfig, QmdSearchResult, MemoryFile } from "../types.js";
import type { StorageManager } from "../index.js";
import { log } from "../logger.js";
import {
  applyMemoryWorthFilter,
  buildMemoryWorthCounterMap,
  type MemoryWorthCounters,
} from "../memory-worth-filter.js";
import {
  applyTrustScoreStage,
  buildTrustSignalsForRerank,
  type TrustStageResultItem,
} from "../trust-score-stage.js";
import type { TrustSignals } from "../trust-score.js";
import { reorderRecallResultsWithMmr } from "../recall-mmr.js";
import { applyReasoningTraceBoost } from "../reasoning-trace-recall.js";

/**
 * Coordinator for the recall-result reranking subsystem.
 *
 * Holds the per-namespace caches for memory-worth counters and trust signals
 * (previously orchestrator fields) so the reranking stages don't trigger a
 * full `readAllMemories` scan per query.
 */
export class RecallRerankCoordinator {
  private readonly getConfig: () => PluginConfig;
  private readonly getStorage: (namespace: string) => Promise<StorageManager>;
  private readonly readQmdResultMemory: (
    resultPath: string,
    fallbackStorage: StorageManager,
    recallNamespaces: readonly string[],
  ) => Promise<MemoryFile | null>;

  private readonly memoryWorthCounterCache = new Map<
    string,
    { at: number; counters: ReadonlyMap<string, MemoryWorthCounters> }
  >();
  private static readonly MEMORY_WORTH_CACHE_TTL_MS = 30_000;

  private readonly trustSignalCache = new Map<
    string,
    { at: number; signals: ReadonlyMap<string, TrustSignals> }
  >();
  private static readonly TRUST_SIGNAL_CACHE_TTL_MS = 30_000;

  constructor(options: {
    getConfig: () => PluginConfig;
    getStorage: (namespace: string) => Promise<StorageManager>;
    readQmdResultMemory: (
      resultPath: string,
      fallbackStorage: StorageManager,
      recallNamespaces: readonly string[],
    ) => Promise<MemoryFile | null>;
  }) {
    this.getConfig = options.getConfig;
    this.getStorage = options.getStorage;
    this.readQmdResultMemory = options.readQmdResultMemory;
  }

  async applyMemoryWorthRerank(
    results: QmdSearchResult[],
    namespaces: string[],
  ): Promise<QmdSearchResult[]> {
    // Build the counter lookup. We union frontmatter counters across every
    // namespace the recall spans — the recall path itself already
    // aggregates candidates from multiple namespaces, so we must do the
    // same when looking up counters. Per-namespace results are cached with
    // a short TTL so interactive recall doesn't trigger a full
    // `readAllMemories` scan per query (addresses codex P2 on PR 4).
    const counters = new Map<string, MemoryWorthCounters>();
    const seenNamespaces = new Set<string>();
    const nowMs = Date.now();

    // Evict all expired entries on every call so long-running processes
    // touching a high-cardinality namespace set (coding/project overlays,
    // per-branch) don't grow the cache unboundedly. Without this, an entry
    // for a namespace that's never looked up again would pin its full
    // counter map forever.
    for (const [key, entry] of this.memoryWorthCounterCache) {
      if (nowMs - entry.at >= RecallRerankCoordinator.MEMORY_WORTH_CACHE_TTL_MS) {
        this.memoryWorthCounterCache.delete(key);
      }
    }

    for (const ns of namespaces) {
      if (seenNamespaces.has(ns)) continue;
      seenNamespaces.add(ns);
      try {
        const cached = this.memoryWorthCounterCache.get(ns);
        let nsMap: ReadonlyMap<string, MemoryWorthCounters> | undefined;
        if (
          cached &&
          nowMs - cached.at < RecallRerankCoordinator.MEMORY_WORTH_CACHE_TTL_MS
        ) {
          nsMap = cached.counters;
        } else {
          const storage = await this.getStorage(ns);
          const memories = await storage.readAllMemories();
          nsMap = buildMemoryWorthCounterMap(memories);
          this.memoryWorthCounterCache.set(ns, { at: nowMs, counters: nsMap });
        }
        for (const [path, c] of nsMap) counters.set(path, c);
      } catch (err) {
        log.debug("memory-worth: failed to read namespace, skipping", {
          namespace: ns,
          error: (err as Error).message,
        });
      }
    }

    // For candidates whose path didn't show up in any hot-tier namespace
    // scan (typical of cold-tier / archive fallback), try a direct
    // per-path read. Without this, cold-tier candidates always stay at
    // multiplier 1.0 even when they have outcome history. Errors are
    // swallowed so a single unreadable archive entry can't break the
    // whole recall.
    const missing = results.filter((r) => !counters.has(r.path));
    if (missing.length > 0) {
      // Use the first-seen namespace's storage as the reader — all
      // StorageManagers share the same on-disk format, and
      // `readMemoryByPath` takes an absolute path so the baseDir doesn't
      // have to match.
      let reader: StorageManager | null = null;
      for (const ns of namespaces) {
        try {
          reader = await this.getStorage(ns);
          break;
        } catch {
          // try next namespace
        }
      }
      if (reader) {
        for (const r of missing) {
          try {
            const memory = await this.readQmdResultMemory(r.path, reader, namespaces);
            if (!memory) continue;
            const fm = memory.frontmatter;
            if (fm.mw_success === undefined && fm.mw_fail === undefined) continue;
            counters.set(r.path, {
              mw_success: fm.mw_success,
              mw_fail: fm.mw_fail,
              lastAccessed: fm.lastAccessed,
            });
          } catch (err) {
            log.debug("memory-worth: direct path lookup failed", {
              path: r.path,
              error: (err as Error).message,
            });
          }
        }
      }
    }

    // If no memory in the candidate set has any counter data, the filter
    // would be a no-op — skip the reorder to avoid spurious log spam.
    if (counters.size === 0) return results;

    // Preserve upstream ordering (reranker, specialized tiers, etc.) for
    // neutral candidates. The upstream stages set `memoryResults` in their
    // intended order but often leave `r.score` as the raw QMD score. If we
    // sorted by `r.score * multiplier` directly, neutral candidates
    // (multiplier 1.0) would snap back to raw-QMD order and silently undo
    // the reranker. Feed the filter a synthetic monotone-decreasing rank
    // score so it uses input position as the baseline, then applies the
    // multiplier on top. Ties fall back to the stable secondary key in
    // `applyMemoryWorthFilter`.
    const rankedInputs = results.map((r, i) => ({
      path: r.path,
      // Large positive rank score so multiplier math stays well-scaled and
      // we never hit zero; descending so earlier items rank higher.
      score: results.length - i,
    }));
    const config = this.getConfig();
    const filtered = applyMemoryWorthFilter(rankedInputs, {
      counters,
      now: new Date(),
      halfLifeMs:
        config.recallMemoryWorthHalfLifeMs > 0
          ? config.recallMemoryWorthHalfLifeMs
          : undefined,
    });

    // Reconstruct the QmdSearchResult list in the new order. `.score` is
    // preserved from the upstream pipeline (rerank, tier scoring, etc.) —
    // we only reorder. Writing the synthetic rank-weighted score back
    // would contaminate downstream logic (telemetry, confidence gates)
    // that expects the original QMD/rerank score semantics.
    const byPath = new Map(results.map((r) => [r.path, r]));
    const reordered: QmdSearchResult[] = [];
    for (const item of filtered) {
      const original = byPath.get(item.path);
      if (original) reordered.push(original);
    }
    return reordered;
  }

  /**
   * Issue #1577 — unified TrustScore recall stage. Thin wiring over the pure
   * {@link applyTrustScoreStage} scorer + the {@link buildTrustSignalsForRerank}
   * signal builder. The stage subsumes the Memory Worth multiplier — the
   * orchestrator runs exactly one of the two (mutual exclusion, rule 39; the
   * double-multiplier test in trust-score-stage.test.ts pins it structurally).
   *
   * Returns the admitted results AND the per-path trust map (including
   * quarantined items) so the caller can: (a) render epistemic hedges, (b)
   * surface quarantined items in X-ray with a reason (rule 34), and (c) filter
   * quarantined paths from fallback recall branches. The trust map is a
   * per-recall local — never instance state — so concurrent recalls cannot
   * race on it (review: shared-trust-map concurrency).
   */
  async applyTrustScoreRerank(
    results: QmdSearchResult[],
    namespaces: string[],
  ): Promise<{
    results: QmdSearchResult[];
    trustByPath: Map<string, TrustStageResultItem> | null;
  }> {
    if (results.length === 0) return { results, trustByPath: null };
    const config = this.getConfig();
    const now = new Date();
    const halfLifeDays =
      config.recallMemoryWorthHalfLifeMs > 0
        ? config.recallMemoryWorthHalfLifeMs / (24 * 60 * 60 * 1000)
        : undefined;
    // Cold-tier direct-fallback reader: resolve once, reuse for every missing
    // candidate (mirrors the memory-worth filter's reader selection).
    let fallbackReader: StorageManager | null = null;
    const signals = await buildTrustSignalsForRerank(
      results.map((r) => r.path),
      namespaces,
      {
        readNamespaceMemories: async (ns) => (await this.getStorage(ns)).readAllMemories(),
        readMemoryFrontmatter: async (path) => {
          if (!fallbackReader) {
            for (const ns of namespaces) {
              try {
                fallbackReader = await this.getStorage(ns);
                break;
              } catch {
                // try next namespace
              }
            }
          }
          if (!fallbackReader) return null;
          const memory = await this.readQmdResultMemory(path, fallbackReader, namespaces);
          return memory ? memory.frontmatter : null;
        },
      },
      { cache: this.trustSignalCache, ttlMs: RecallRerankCoordinator.TRUST_SIGNAL_CACHE_TTL_MS },
      now,
      {
        recencyHalfLifeDays: halfLifeDays,
        logDebug: (message, context) => log.debug(message, context),
      },
    );
    if (signals.size === 0) {
      return { results, trustByPath: null };
    }
    // Synthetic monotone-decreasing rank so the multiplier rebias is applied
    // on top of upstream ordering, not raw QMD scores (see applyMemoryWorthRerank).
    const rankedInputs = results.map((r, i) => ({ path: r.path, score: results.length - i }));
    const stage = applyTrustScoreStage(rankedInputs, {
      signals,
      weights: config.trustScoreWeights,
      minMultiplier: config.trustScoreMinMultiplier,
      maxMultiplier: config.trustScoreMaxMultiplier,
      quarantine: config.trustScoreQuarantine,
    });
    const trustByPath = new Map(stage.all.map((item) => [item.path, item]));
    const byPath = new Map(results.map((r) => [r.path, r]));
    const admitted = stage.admitted
      .map((item) => byPath.get(item.path))
      .filter((r): r is QmdSearchResult => r !== undefined);
    return { results: admitted, trustByPath };
  }

  /**
   * Issue #1577 — apply the TrustScore stage (or, when trust is off, the Memory
   * Worth multiplier fallback) to ONE recall branch's results, returning the
   * scored results + the per-path trust map. Thin wiring over
   * {@link applyTrustScoreRerank} so every recall path — hot QMD, embedding
   * fallback, recent scan — applies the SAME multiplier gate (rule 41: a
   * feature gate must apply across ALL parallel recall paths). TrustScore
   * subsumes Memory Worth; exactly one runs (rule 39). Fail-open on lookup
   * errors so a storage hiccup never breaks a fallback path.
   */
  async applyTrustScoreToBranch(
    results: QmdSearchResult[],
    namespaces: string[],
    caps: CapabilitySet,
    label: string,
  ): Promise<{
    results: QmdSearchResult[];
    trustByPath: Map<string, TrustStageResultItem> | null;
  }> {
    if (caps.recallTrustScore && results.length > 0) {
      try {
        return await this.applyTrustScoreRerank(results, namespaces);
      } catch (err) {
        log.debug(`trust-score stage (${label}) failed open`, {
          error: (err as Error).message,
        });
      }
    } else if (caps.recallMemoryWorthFilter && results.length > 0) {
      try {
        const filtered = await this.applyMemoryWorthRerank(results, namespaces);
        return { results: filtered, trustByPath: null };
      } catch (err) {
        log.debug(`memory-worth filter (${label}) failed open`, {
          error: (err as Error).message,
        });
      }
    }
    return { results, trustByPath: null };
  }

  diversifyAndLimitRecallResults(
    sectionId: string,
    results: QmdSearchResult[],
    limit: number,
    retrievalQuery?: string,
    // `caps` is additive AND last (issue #1523) so the positional call shape
    // stays backward-compatible: the recall pipeline threads a resolved set,
    // but callers that omit it (e.g. direct unit-test invocations) get an
    // equivalent set derived from the same config — behavior-preserving.
    caps: CapabilitySet = resolveCapabilities(this.getConfig()),
  ): QmdSearchResult[] {
    const safeLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.max(0, Math.floor(limit))
        : 0;
    if (!Array.isArray(results) || results.length === 0) return [];
    // `recallResultLimit === 0` is a true zero limit (e.g. when
    // `memoriesSectionEnabled` is false) and must return an empty array so
    // the memories section is genuinely skipped. This mirrors the
    // `slice(0, 0)` semantics of every call site this helper replaced.
    if (safeLimit === 0) return [];
    // Issue #564 PR 3: when the feature flag is on, boost reasoning_trace
    // memories for problem-solving asks so they bubble up ahead of ordinary
    // facts/decisions before MMR picks the final section. No-op when the
    // flag is off or the query is not a problem-solving ask.
    const boosted =
      caps.recallReasoningTraceBoost && typeof retrievalQuery === "string"
        ? applyReasoningTraceBoost(results, {
            enabled: true,
            query: retrievalQuery,
          })
        : results;
    const diversified = this.applyMmrToQmdResults(sectionId, boosted, caps);
    return diversified.slice(0, safeLimit);
  }

  /**
   * Apply Maximal Marginal Relevance to a section's ordered candidate list.
   *
   * Operates per-section so one redundant cluster cannot dominate a section,
   * and so one section's MMR pass cannot starve other sections. Returns the
   * input unchanged when disabled, when there are fewer than 2 candidates, or
   * when no budget information is available.
   */
  applyMmrToQmdResults(
    sectionId: string,
    results: QmdSearchResult[],
    // Additive `caps` (issue #1523); defaults to a config-derived set so direct
    // callers that omit it behave identically to the threaded recall path.
    caps: CapabilitySet = resolveCapabilities(this.getConfig()),
  ): QmdSearchResult[] {
    if (!caps.recallMmr) return results;
    if (!Array.isArray(results) || results.length < 2) return results;

    // Config is runtime API (see AGENTS.md §4): preserve `0` as a true zero
    // limit rather than coercing it to a non-zero value. A configured topN of
    // 0 means "apply MMR over an empty window" — i.e. skip the reorder and
    // return the upstream candidates unchanged. This keeps read-time
    // behavior symmetric with the write-time semantics parseConfig exposes.
    const config = this.getConfig();
    const configuredTopN = config.recallMmrTopN;
    const topN =
      typeof configuredTopN === "number" && Number.isFinite(configuredTopN)
        ? Math.max(0, Math.floor(configuredTopN))
        : 40;
    if (topN === 0) return results;
    const lambda = config.recallMmrLambda ?? 0.7;

    // Delegate to the pure helper so candidate keying (path-first, index
    // suffixed for uniqueness) and the head-of-list diversity metric are
    // exercised by the same code path that the unit tests cover.
    const { reordered, diversity } = reorderRecallResultsWithMmr(results, {
      lambda,
      topN,
    });

    try {
      log.info(
        `recall_mmr: section=${sectionId} kept=${diversity.kept}/${diversity.considered} ` +
          `headReorderCount=${diversity.headReorderCount} ` +
          `avgSimBefore=${diversity.avgPairwiseSimBefore.toFixed(3)} ` +
          `avgSimAfter=${diversity.avgPairwiseSimAfter.toFixed(3)} ` +
          `lambda=${lambda.toFixed(2)}`,
      );
    } catch {
      // Metrics must never break recall.
    }

    return reordered;
  }
}
