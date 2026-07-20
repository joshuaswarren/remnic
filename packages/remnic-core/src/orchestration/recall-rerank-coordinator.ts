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
  trustResultKey,
  type TrustStageResultItem,
} from "../trust-score-stage.js";
import type { TrustSignals } from "../trust-score.js";
import { reorderRecallResultsWithMmr } from "../recall-mmr.js";
import { applyReasoningTraceBoost } from "../reasoning-trace-recall.js";
import { memoryMapKey } from "./recall-memory-map.js";

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
    preferredNamespace?: string,
  ) => Promise<MemoryFile | null>;

  // Per-namespace corpus-fallback caches (issue #1905). Keyed on the shared
  // cross-process memory-corpus version rather than a wall-clock TTL: the old
  // 30s TTL was SHORTER than recall p50 (~30.5s) so every steady-state recall
  // was a guaranteed miss + full-corpus scan. The corpus version bumps on every
  // memory mutation (StorageManager.getMemoryCorpusVersion / patchHotMemoriesCache),
  // including mw_success/mw_fail counter writes, so a version match means the
  // derived map is still current and can be served; a mismatch re-derives.
  private readonly memoryWorthCounterCache = new Map<
    string,
    { version: number; counters: ReadonlyMap<string, MemoryWorthCounters> }
  >();

  private readonly trustSignalCache = new Map<
    string,
    { version: number; cachedAt: number; signals: ReadonlyMap<string, TrustSignals> }
  >();

  /**
   * Cap on distinct namespaces retained in the corpus-fallback caches. Each
   * entry holds a derived per-namespace map; on high-cardinality namespace
   * workloads an unbounded map would grow without limit (#1905, Cursor). Map
   * preserves insertion order, so overflow evicts the oldest namespace.
   */
  private static readonly CORPUS_FALLBACK_CACHE_MAX_NAMESPACES = 64;

  // Trust-signal age bound (TRUST_SIGNAL_CACHE_MAX_AGE_MS) lives in
  // trust-score-stage.ts — that module owns the signal cache's read/write and
  // the TTL check (signals bake `now` into their values). This coordinator only
  // owns the memory-worth counter cache, whose values are raw (no `now`), so it
  // is version-keyed only.


  /** Insert-ordered bounded set: evict the oldest namespace on overflow. */
  private static capCache<K, V>(cache: Map<K, V>, max: number): void {
    while (cache.size > max) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  constructor(options: {
    getConfig: () => PluginConfig;
    getStorage: (namespace: string) => Promise<StorageManager>;
    readQmdResultMemory: (
      resultPath: string,
      fallbackStorage: StorageManager,
      recallNamespaces: readonly string[],
      preferredNamespace?: string,
    ) => Promise<MemoryFile | null>;
  }) {
    this.getConfig = options.getConfig;
    this.getStorage = options.getStorage;
    this.readQmdResultMemory = options.readQmdResultMemory;
  }

  async applyMemoryWorthRerank(
    results: QmdSearchResult[],
    namespaces: string[],
    // Candidate frontmatter already loaded on the hot recall path (issue
    // #1905). Additive + last so the positional call shape stays
    // backward-compatible. When present, counters are seeded from it directly
    // and the O(corpus) `readAllMemories` scan is skipped for warm candidates.
    preloadedFrontmatter?: ReadonlyMap<string, MemoryFile>,
    // Cooperative cancellation (issue #1905, Codex); additive + last.
    abortSignal?: AbortSignal,
  ): Promise<QmdSearchResult[]> {
    const config = this.getConfig();
    const counters = new Map<string, MemoryWorthCounters>();
    // Paths examined via preloaded frontmatter (issue #1905, Codex). A candidate
    // whose frontmatter is present but has no mw_success/mw_fail is a NEUTRAL
    // prior — it must NOT be treated as "missing", otherwise the corpus scan +
    // direct-read fallback fire for every uninstrumented hot-QMD candidate and
    // the O(candidates) fast path is defeated. Track preloaded paths separately
    // from counters and exclude them from every fallback.
    const preloadedPaths = new Set<string>();

    // O(candidates) fast path (issue #1905): seed counters directly from
    // frontmatter already loaded on the hot path. The
    // `mw_success === undefined && mw_fail === undefined` guard matches
    // `buildMemoryWorthCounterMap` exactly so a candidate with no counters is a
    // neutral prior, identical to the corpus scan.
    if (preloadedFrontmatter) {
      for (const r of results) {
        const key = memoryMapKey(r);
        // Composite (namespace, path) key is authoritative — it can never hit a
        // wrong-namespace entry. The bare-path fallback keeps path-keyed callers
        // working and is inert in production (loaded maps are composite-keyed).
        const mem = preloadedFrontmatter.get(key) ?? preloadedFrontmatter.get(r.path);
        if (!mem) continue;
        preloadedPaths.add(key);
        const fm = mem.frontmatter;
        if (fm.mw_success === undefined && fm.mw_fail === undefined) continue;
        counters.set(key, {
          mw_success: fm.mw_success,
          mw_fail: fm.mw_fail,
          lastAccessed: fm.lastAccessed,
        });
      }
    }

    // Corpus-level fallback (config-gated): candidates still missing from the
    // preloaded map probe a per-namespace counter map. The map is cached and
    // invalidated by the shared cross-process corpus version (not a wall-clock
    // TTL), so it actually hits in steady state. Only the candidate rows are
    // copied out — never the whole ~99K-entry map (issue #1905).
    if (config.recallTrustStageCorpusFallbackEnabled) {
      const seenNamespaces = new Set<string>();
      for (const ns of namespaces) {
        // Cooperative cancellation: the recall's assembly deadline may have won
        // the race — stop before another namespace scan (#1905, Codex).
        if (abortSignal?.aborted) break;
        if (seenNamespaces.has(ns)) continue;
        seenNamespaces.add(ns);
        if (results.every((r) => counters.has(memoryMapKey(r)) || preloadedPaths.has(memoryMapKey(r)))) break;
        try {
          const storage = await this.getStorage(ns);
          const version = storage.getMemoryCorpusVersion();
          const cached = this.memoryWorthCounterCache.get(ns);
          let nsMap: ReadonlyMap<string, MemoryWorthCounters>;
          if (cached && cached.version === version) {
            nsMap = cached.counters;
          } else {
            const memories = await storage.readAllMemories();
            nsMap = buildMemoryWorthCounterMap(memories);
            this.memoryWorthCounterCache.set(ns, { version, counters: nsMap });
            RecallRerankCoordinator.capCache(
              this.memoryWorthCounterCache,
              RecallRerankCoordinator.CORPUS_FALLBACK_CACHE_MAX_NAMESPACES,
            );
          }
          for (const r of results) {
            // Skip candidates already satisfied by a counter OR already examined
            // via preloaded frontmatter (neutral prior — no corpus lookup needed).
            const key = memoryMapKey(r);
            if (counters.has(key) || preloadedPaths.has(key)) continue;
            // A namespaced result belongs to exactly one namespace: never seed
            // its counters from a different namespace's corpus map, or two
            // same-path results in different namespaces collapse (#2020).
            if (r.namespace !== undefined && r.namespace !== ns) continue;
            const c = nsMap.get(r.path);
            if (c) counters.set(key, c);
          }
        } catch (err) {
          log.debug("memory-worth: failed to read namespace, skipping", {
            namespace: ns,
            error: (err as Error).message,
          });
        }
      }
    }

    // For candidates still absent (cold-tier / archive, or corpus fallback
    // disabled), try a direct per-path read. Bounded-parallel (≤16) to match
    // loadSearchResultMemoryMap's batch size (issue #1905). Errors are swallowed
    // so a single unreadable archive entry can't break the whole recall.
    const missing = results.filter(
      (r) => !counters.has(memoryMapKey(r)) && !preloadedPaths.has(memoryMapKey(r)),
    );
    if (missing.length > 0) {
      // Use the first-seen namespace's storage as the reader — all
      // StorageManagers share the same on-disk format, and readMemoryByPath
      // takes an absolute path so the baseDir doesn't have to match.
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
        const readerNn = reader;
        const BATCH = 16;
        for (let off = 0; off < missing.length; off += BATCH) {
          // Cooperative cancellation between batches (#1905, Codex).
          if (abortSignal?.aborted) break;
          await Promise.all(
            missing.slice(off, off + BATCH).map(async (r) => {
              try {
                const memory = await this.readQmdResultMemory(
                  r.path,
                  readerNn,
                  namespaces,
                  r.namespace,
                );
                if (!memory) return;
                const fm = memory.frontmatter;
                if (fm.mw_success === undefined && fm.mw_fail === undefined) return;
                counters.set(memoryMapKey(r), {
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
            }),
          );
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
      // Composite (namespace, path) identity so same-path results in different
      // namespaces stay distinct through the filter and reconstruction (#2020).
      path: memoryMapKey(r),
      // Large positive rank score so multiplier math stays well-scaled and
      // we never hit zero; descending so earlier items rank higher.
      score: results.length - i,
    }));
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
    const byPath = new Map(results.map((r) => [memoryMapKey(r), r]));
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
    // Candidate frontmatter already loaded on the hot recall path (issue
    // #1905); additive + last for positional back-compat. Seeds signals
    // directly so warm candidates skip the O(corpus) namespace scan.
    preloadedFrontmatter?: ReadonlyMap<string, MemoryFile>,
    // Cooperative cancellation (issue #1905, Codex): aborted by the host when
    // the recall's assembly deadline wins the race, so orphaned corpus scans
    // stop at the next loop boundary. Additive + last for positional back-compat.
    abortSignal?: AbortSignal,
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
      results.map((r) => ({
        path: r.path,
        // Signals are keyed by the SAME composite key the trust stage looks up
        // (trustResultKey), and preloaded frontmatter by memoryMapKey, so
        // same-path results in different namespaces stay distinct (#2020).
        signalKey: trustResultKey(r),
        lookupKey: memoryMapKey(r),
        namespace: r.namespace,
      })),
      namespaces,
      {
        readNamespaceMemories: async (ns) => (await this.getStorage(ns)).readAllMemories(),
        readMemoryFrontmatter: async (path, preferredNamespace) => {
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
          const memory = await this.readQmdResultMemory(
            path,
            fallbackReader,
            namespaces,
            preferredNamespace,
          );
          return memory ? memory.frontmatter : null;
        },
        // Corpus version bumps on every memory mutation (including mw counter
        // writes) — keys the per-namespace signal cache so it invalidates on
        // the next write instead of a wall-clock TTL (issue #1905).
        getNamespaceVersion: async (ns) => (await this.getStorage(ns)).getMemoryCorpusVersion(),
      },
      { cache: this.trustSignalCache },
      now,
      {
        recencyHalfLifeDays: halfLifeDays,
        logDebug: (message, context) => log.debug(message, context),
        preloadedFrontmatter,
        corpusFallbackEnabled: config.recallTrustStageCorpusFallbackEnabled,
        abortSignal,
      },
    );
    if (signals.size === 0) {
      return { results, trustByPath: null };
    }
    // Synthetic monotone-decreasing rank so the multiplier rebias is applied
    const rankedInputs = results.map((r, i) => ({
      path: r.path,
      key: trustResultKey(r),
      score: results.length - i,
    }));
    const stage = applyTrustScoreStage(rankedInputs, {
      signals,
      weights: config.trustScoreWeights,
      minMultiplier: config.trustScoreMinMultiplier,
      maxMultiplier: config.trustScoreMaxMultiplier,
      quarantine: config.trustScoreQuarantine,
    });
    const trustByPath = new Map(
      stage.all.map((item) => [item.key ?? item.path, item] as const),
    );
    const byKey = new Map<string, QmdSearchResult[]>();
    for (const result of results) {
      const key = trustResultKey(result);
      const bucket = byKey.get(key);
      if (bucket) bucket.push(result);
      else byKey.set(key, [result]);
    }
    const admitted = stage.admitted
      .map((item) => {
        const key = item.key ?? item.path;
        if (item.key !== undefined) return byKey.get(key)?.shift();
        return results.find((result) => result.path === item.path);
      })
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
    // Candidate frontmatter already loaded on this branch's hot path (issue
    // #1905); additive + last. Threaded to the active stage so it does
    // O(candidates) work instead of a full-corpus scan. `undefined` on
    // branches without a safety-filter map → falls back to corpus/direct-read
    // (identical lookup result, rule 41 parity).
    preloadedFrontmatter?: ReadonlyMap<string, MemoryFile>,
    // Cooperative cancellation (issue #1905, Codex); additive + last.
    abortSignal?: AbortSignal,
  ): Promise<{
    results: QmdSearchResult[];
    trustByPath: Map<string, TrustStageResultItem> | null;
  }> {
    if (caps.recallTrustScore && results.length > 0) {
      try {
        return await this.applyTrustScoreRerank(results, namespaces, preloadedFrontmatter, abortSignal);
      } catch (err) {
        log.debug(`trust-score stage (${label}) failed open`, {
          error: (err as Error).message,
        });
      }
    } else if (caps.recallMemoryWorthFilter && results.length > 0) {
      try {
        const filtered = await this.applyMemoryWorthRerank(
          results,
          namespaces,
          preloadedFrontmatter,
          abortSignal,
        );
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
