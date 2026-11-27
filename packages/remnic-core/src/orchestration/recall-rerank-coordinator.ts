
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
  applyPreferenceDriftRanking,
  isPreferenceDriftStageActive,
  type DriftRecallFrontmatter,
} from "../preferences/drift-recall.js";
import {
  applyTrustScoreStage,
  buildTrustSignalsForRerank,
  trustResultKey,
  type TrustStageResultItem,
} from "../trust-score-stage.js";
import type { TrustSignals } from "../trust-score.js";
import { reorderRecallResultsWithMmr } from "../recall-mmr.js";
import { applyReasoningTraceBoost } from "../reasoning-trace-recall.js";
import { memoryMapKey } from "../recall-memory-map.js";
import { capStateViewPackets, reconcileStateViewPairs } from "../recall-state-view.js";

export interface RecallResultPartition {
  appliedResults: QmdSearchResult[];
  headroomResults: QmdSearchResult[];
}
export interface RecallResultPartitionSink {
  partition: RecallResultPartition | null;
}

export function reconcileRecallResultPartition(
  partition: RecallResultPartition | null | undefined,
  appliedResults: QmdSearchResult[],
): RecallResultPartition | null {
  return partition
    ? { appliedResults, headroomResults: partition.headroomResults }
    : null;
}

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

  private readonly memoryWorthCounterCache = new Map<
    string,
    { version: number; counters: ReadonlyMap<string, MemoryWorthCounters> }
  >();

  private readonly trustSignalCache = new Map<
    string,
    { version: number; cachedAt: number; signals: ReadonlyMap<string, TrustSignals> }
  >();

  private static readonly CORPUS_FALLBACK_CACHE_MAX_NAMESPACES = 64;



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
    abortSignal?: AbortSignal,
  ): Promise<QmdSearchResult[]> {
    const config = this.getConfig();
    const counters = new Map<string, MemoryWorthCounters>();
    const preloadedPaths = new Set<string>();

    if (preloadedFrontmatter) {
      for (const r of results) {
        const key = memoryMapKey(r);
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
            const key = memoryMapKey(r);
            if (counters.has(key) || preloadedPaths.has(key)) continue;
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

    const missing = results.filter(
      (r) => !counters.has(memoryMapKey(r)) && !preloadedPaths.has(memoryMapKey(r)),
    );
    if (missing.length > 0) {
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

    if (counters.size === 0) return results;

    const rankedInputs = results.map((r, i) => ({
      path: memoryMapKey(r),
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

    const adjusted = filtered.some((item) => item.multiplier !== 1);
    const byPath = new Map(results.map((r) => [memoryMapKey(r), r]));
    const reordered: QmdSearchResult[] = [];
    for (const item of filtered) {
      const original = byPath.get(item.path);
      if (!original) continue;
      reordered.push(adjusted ? { ...original, effectiveScore: item.score / results.length } : original);
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
    let fallbackReader: StorageManager | null = null;
    const signals = await buildTrustSignalsForRerank(
      results.map((r) => ({
        path: r.path,
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
    if (stage.quarantined.length > 0) {
      const survivors = stage.all.filter((item) => !item.quarantined);
      for (const [index, item] of survivors.entries()) {
        item.score = (survivors.length - index) * item.multiplier;
      }
      stage.admitted = survivors.sort((a, b) => b.score - a.score);
    }
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
    const adjusted = stage.admitted.some((item) => item.multiplier !== 1);
    const relevanceScale = stage.admitted.reduce((max, item) => Math.max(max, item.score), 0) || 1;
    const admitted: QmdSearchResult[] = [];
    for (const item of stage.admitted) {
      const key = item.key ?? item.path;
      const original =
        item.key !== undefined
          ? byKey.get(key)?.shift()
          : results.find((result) => result.path === item.path);
      if (!original) continue;
      admitted.push(adjusted ? { ...original, effectiveScore: item.score / relevanceScale } : original);
    }
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
    abortSignal?: AbortSignal,
  ): Promise<{
    results: QmdSearchResult[];
    trustByPath: Map<string, TrustStageResultItem> | null;
  }> {
    let staged = results;
    let trustByPath: Map<string, TrustStageResultItem> | null = null;
    if (caps.recallTrustScore && results.length > 0) {
      try {
        const outcome = await this.applyTrustScoreRerank(results, namespaces, preloadedFrontmatter, abortSignal);
        staged = outcome.results;
        trustByPath = outcome.trustByPath;
      } catch (err) {
        log.debug(`trust-score stage (${label}) failed open`, {
          error: (err as Error).message,
        });
      }
    } else if (caps.recallMemoryWorthFilter && results.length > 0) {
      try {
        staged = await this.applyMemoryWorthRerank(
          results,
          namespaces,
          preloadedFrontmatter,
          abortSignal,
        );
      } catch (err) {
        log.debug(`memory-worth filter (${label}) failed open`, {
          error: (err as Error).message,
        });
      }
    }
    const damped = await this.applyPreferenceDriftStage(
      staged,
      namespaces,
      preloadedFrontmatter,
      abortSignal,
    );
    return { results: damped, trustByPath };
  }

  /**
   * Issue #2371 — stale-preference damping + injection annotation.
   *
   * Runs immediately after the trust/Memory-Worth stage on EVERY recall branch
   * (hot QMD, embedding fallback, recent scan, cold fallback), so the feature
   * gate applies uniformly and fallback parity holds (§27, AGENTS.md retrieval
   * guardrails). Fully inert on the default config: when neither damping nor
   * annotation is active the input array is returned untouched and NO
   * frontmatter is read, so recall ordering and injected text stay
   * byte-identical to pre-#2371.
   *
   * Fail-open: any lookup error leaves the branch's results unchanged.
   */
  async applyPreferenceDriftStage(
    results: QmdSearchResult[],
    namespaces: string[],
    preloadedFrontmatter?: ReadonlyMap<string, MemoryFile>,
    abortSignal?: AbortSignal,
  ): Promise<QmdSearchResult[]> {
    const config = this.getConfig();
    if (!isPreferenceDriftStageActive(config.driftDetection)) return results;
    if (results.length === 0) return results;

    try {
      const frontmatterByKey = new Map<string, DriftRecallFrontmatter>();
      const missing: QmdSearchResult[] = [];
      for (const r of results) {
        const key = memoryMapKey(r);
        const preloaded = preloadedFrontmatter?.get(key) ?? preloadedFrontmatter?.get(r.path);
        if (preloaded) {
          frontmatterByKey.set(key, preloaded.frontmatter);
        } else {
          missing.push(r);
        }
      }

      if (missing.length > 0) {
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
            if (abortSignal?.aborted) break;
            await Promise.all(
              missing.slice(off, off + BATCH).map(async (r) => {
                try {
                  const memory = await this.readQmdResultMemory(r.path, readerNn, namespaces, r.namespace);
                  if (memory) frontmatterByKey.set(memoryMapKey(r), memory.frontmatter);
                } catch (err) {
                  log.debug("preference-drift: direct path lookup failed", {
                    path: r.path,
                    error: (err as Error).message,
                  });
                }
              }),
            );
          }
        }
      }

      const ranked = results.map((r, i) => ({
        key: memoryMapKey(r),
        rank: typeof r.effectiveScore === "number" && Number.isFinite(r.effectiveScore)
          ? r.effectiveScore : (results.length - i) / results.length,
        frontmatter: frontmatterByKey.get(memoryMapKey(r)),
      }));
      const ordered = applyPreferenceDriftRanking(ranked, {
        config: config.driftDetection,
        now: new Date(),
      });

      const adjusted = ordered.some((item) => item.multiplier !== 1);
      const byKey = new Map(results.map((r) => [memoryMapKey(r), r]));
      const rankByKey = new Map(ranked.map((r) => [r.key, r.rank]));
      const reordered: QmdSearchResult[] = [];
      for (const item of ordered) {
        const original = byKey.get(item.key);
        if (!original) continue;
        const annotated: QmdSearchResult = item.note
          ? { ...original, driftNote: item.note }
          : original;
        const rank = rankByKey.get(item.key);
        reordered.push(
          adjusted && rank !== undefined
            ? { ...annotated, effectiveScore: rank * item.multiplier }
            : annotated,
        );
      }
      return reordered;
    } catch (err) {
      log.debug("preference-drift stage failed open", { error: (err as Error).message });
      return results;
    }
  }

  diversifyRecallResultsWithHeadroom(
    sectionId: string,
    results: QmdSearchResult[],
    limit: number,
    retrievalQuery?: string,
    caps: CapabilitySet = resolveCapabilities(this.getConfig()),
    /**
     * #2859 — state-view packet semantics. When true, superseded rows are
     * reconciled against their successors BEFORE MMR (orphan removal can
     * never underfill), and the cap counts complete evidence packets: a
     * predecessor admitted alongside its successor consumes ONE slot and
     * the slice never splits the pair at the boundary. Absent/false keeps
     * the legacy slice byte-identical.
     */
    stateViewActive?: boolean,
  ): RecallResultPartition {
    const safeLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.max(0, Math.floor(limit))
        : 0;
    const candidates =
      stateViewActive === true && Array.isArray(results)
        ? reconcileStateViewPairs(results)
        : Array.isArray(results)
          ? results
          : [];
    let orderedPool: QmdSearchResult[] | undefined;
    const resolveOrderedPool = (): QmdSearchResult[] => {
      if (orderedPool) return orderedPool;
      const boosted =
        caps.recallReasoningTraceBoost && typeof retrievalQuery === "string"
          ? applyReasoningTraceBoost(candidates, {
              enabled: true,
              query: retrievalQuery,
            })
          : candidates;
      orderedPool = this.applyMmrToQmdResults(sectionId, boosted, caps);
      return orderedPool;
    };
    let appliedCache: QmdSearchResult[] | undefined;
    const resolveApplied = (): QmdSearchResult[] => {
      if (appliedCache) return appliedCache;
      if (safeLimit === 0 || candidates.length === 0) {
        appliedCache = [];
        return appliedCache;
      }
      const ordered = resolveOrderedPool();
      appliedCache =
        stateViewActive === true ? capStateViewPackets(ordered, safeLimit) : ordered.slice(0, safeLimit);
      return appliedCache;
    };

    return {
      get appliedResults(): QmdSearchResult[] {
        return resolveApplied().slice();
      },
      get headroomResults(): QmdSearchResult[] {
        if (candidates.length === 0) return [];
        const ordered = resolveOrderedPool();
        if (stateViewActive === true) {
          const applied = new Set(resolveApplied());
          return ordered.filter((row) => !applied.has(row));
        }
        return ordered.slice(safeLimit);
      },
    };
  }

  diversifyAndLimitRecallResults(
    sectionId: string,
    results: QmdSearchResult[],
    limit: number,
    retrievalQuery?: string,
    caps: CapabilitySet = resolveCapabilities(this.getConfig()),
    /** #2859 — see diversifyRecallResultsWithHeadroom. */
    stateViewActive?: boolean,
  ): QmdSearchResult[] {
    return this.diversifyRecallResultsWithHeadroom(
      sectionId,
      results,
      limit,
      retrievalQuery,
      caps,
      stateViewActive,
    ).appliedResults;
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

    const config = this.getConfig();
    const configuredTopN = config.recallMmrTopN;
    const topN =
      typeof configuredTopN === "number" && Number.isFinite(configuredTopN)
        ? Math.max(0, Math.floor(configuredTopN))
        : 40;
    if (topN === 0) return results;
    const lambda = config.recallMmrLambda ?? 0.7;

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
