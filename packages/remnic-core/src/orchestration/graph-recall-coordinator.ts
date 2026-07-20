/**
 * Graph-recall coordinator — extracted from the orchestrator (issue #1526).
 *
 * Owns the graph-expansion subsystem in recall: spreading-activation
 * traversal from seed memories, seed-path resolution relative to
 * per-namespace storage, and the last-graph-recall snapshot persistence.
 * Behavior-preserving move from orchestrator.ts — no logic changes; the
 * orchestrator constructs one instance and keeps thin delegating methods so
 * existing call sites (recallInternal, cold-fallback pipeline) continue to
 * work.
 *
 * Config, storage, graph index, namespace resolution, and QMD result
 * resolution are accessed through getter callbacks (not captured at
 * construction) so that post-construction reassignment of the orchestrator's
 * live fields is honored. This mirrors the RecallRerankCoordinator /
 * ContradictionLinkingCoordinator accessor pattern.
 */

import type {
  MemoryFile,
  MemoryIntent,
  PluginConfig,
  QmdSearchResult,
  RecallPlanMode,
} from "../types.js";
import type { StorageManager } from "../index.js";
import type { GraphIndex } from "../graph.js";
import type { GraphRecallExpandedEntry } from "../recall-state.js";
import { clampGraphRecallExpandedEntries } from "../recall-state.js";
import { qmdCollectionPathParts } from "./qmd-result-resolver.js";
import { log } from "../logger.js";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types (moved from orchestrator.ts; re-exported by the orchestrator barrel)
// ---------------------------------------------------------------------------

export interface GraphRecallRankedResult {
  path: string;
  score: number;
  docid?: string;
  sourceLabels: string[];
}

export interface GraphRecallShadowComparison {
  baselineCount: number;
  graphCount: number;
  overlapCount: number;
  overlapRatio: number;
  averageOverlapDelta: number;
}

// ---------------------------------------------------------------------------
// Utility functions (moved from orchestrator.ts; re-exported for callers)
// ---------------------------------------------------------------------------

export function mergeGraphExpandedResults(
  primary: QmdSearchResult[],
  expanded: QmdSearchResult[],
): QmdSearchResult[] {
  const mergedByNamespaceAndPath = new Map<string, QmdSearchResult>();
  for (const item of [...primary, ...expanded]) {
    const key = `${item.namespace ?? ""}\0${item.path}`;
    const prev = mergedByNamespaceAndPath.get(key);
    if (!prev) {
      mergedByNamespaceAndPath.set(key, item);
      continue;
    }
    const better = item.score > prev.score ? item : prev;
    const snippet = prev.snippet || item.snippet;
    mergedByNamespaceAndPath.set(key, { ...better, snippet });
  }
  return Array.from(mergedByNamespaceAndPath.values());
}

export function graphPathRelativeToStorage(
  storageDir: string,
  candidatePath: string,
): string | null {
  const absolutePath = path.isAbsolute(candidatePath)
    ? candidatePath
    : path.resolve(storageDir, candidatePath);
  const rel = path.relative(storageDir, absolutePath);
  if (!rel || rel === ".") return null;
  if (rel.startsWith("..")) return null;
  return rel.split(path.sep).join("/");
}

function normalizeGraphActivationScore(score: number): number {
  const bounded = Number.isFinite(score) && score > 0 ? score : 0;
  return bounded / (1 + bounded);
}

export function blendGraphExpandedRecallScore(options: {
  graphActivationScore: number;
  seedRecallScore: number;
  activationWeight: number;
  blendMin: number;
  blendMax: number;
}): number {
  const graphNorm = normalizeGraphActivationScore(options.graphActivationScore);
  const seedScore = Number.isFinite(options.seedRecallScore)
    ? Math.min(1, Math.max(0, options.seedRecallScore))
    : 0;
  const weight = Math.min(1, Math.max(0, options.activationWeight));
  const rawMin = Math.min(1, Math.max(0, options.blendMin));
  const rawMax = Math.min(1, Math.max(0, options.blendMax));
  const minBound = Math.min(rawMin, rawMax);
  const maxBound = Math.max(rawMin, rawMax);
  const blended = graphNorm * weight + seedScore * (1 - weight);
  return Math.max(minBound, Math.min(maxBound, blended));
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export class GraphRecallCoordinator {
  private readonly getConfig: () => PluginConfig;
  private readonly getStorage: () => StorageManager;
  private readonly storageFor: (namespace: string) => Promise<StorageManager>;
  private readonly graphIndexFor: (storage: StorageManager) => GraphIndex;
  private readonly namespaceFromPath: (p: string) => string;
  private readonly resolveColdQmdResultForRecall: (
    result: QmdSearchResult,
    fallbackStorage: StorageManager,
    recallNamespaces: readonly string[],
  ) => Promise<{ namespace: string; result: QmdSearchResult } | null>;
  private readonly storageForAbsoluteQmdResultPath: (
    resultPath: string,
    fallbackStorage: StorageManager,
    recallNamespaces: readonly string[],
  ) => Promise<{ storage: StorageManager; dir: string; namespace: string } | null>;
  private readonly readQmdResultMemory: (
    resultPath: string,
    fallbackStorage: StorageManager,
    recallNamespaces: readonly string[],
  ) => Promise<MemoryFile | null>;

  constructor(options: {
    getConfig: () => PluginConfig;
    getStorage: () => StorageManager;
    storageFor: (namespace: string) => Promise<StorageManager>;
    graphIndexFor: (storage: StorageManager) => GraphIndex;
    namespaceFromPath: (p: string) => string;
    resolveColdQmdResultForRecall: (
      result: QmdSearchResult,
      fallbackStorage: StorageManager,
      recallNamespaces: readonly string[],
    ) => Promise<{ namespace: string; result: QmdSearchResult } | null>;
    storageForAbsoluteQmdResultPath: (
      resultPath: string,
      fallbackStorage: StorageManager,
      recallNamespaces: readonly string[],
    ) => Promise<{ storage: StorageManager; dir: string; namespace: string } | null>;
    readQmdResultMemory: (
      resultPath: string,
      fallbackStorage: StorageManager,
      recallNamespaces: readonly string[],
    ) => Promise<MemoryFile | null>;
  }) {
    this.getConfig = options.getConfig;
    this.getStorage = options.getStorage;
    this.storageFor = options.storageFor;
    this.graphIndexFor = options.graphIndexFor;
    this.namespaceFromPath = options.namespaceFromPath;
    this.resolveColdQmdResultForRecall = options.resolveColdQmdResultForRecall;
    this.storageForAbsoluteQmdResultPath = options.storageForAbsoluteQmdResultPath;
    this.readQmdResultMemory = options.readQmdResultMemory;
  }

  async expandResultsViaGraph(options: {
    memoryResults: QmdSearchResult[];
    recallNamespaces: string[];
    recallResultLimit: number;
    deadlineAtMs?: number | null;
    /** Issue #681 — when true, bypass graphTraversalConfidenceFloor. */
    includeLowConfidence?: boolean;
  }): Promise<{
    merged: QmdSearchResult[];
    seedPaths: string[];
    expandedPaths: GraphRecallExpandedEntry[];
    seedResults: QmdSearchResult[];
  }> {
    const config = this.getConfig();
    const deadlineExpired = (): boolean =>
      typeof options.deadlineAtMs === "number" &&
      Date.now() >= options.deadlineAtMs;
    const byNamespace = new Map<string, QmdSearchResult[]>();
    const addResultForNamespace = (
      namespace: string,
      result: QmdSearchResult,
    ): void => {
      const existing = byNamespace.get(namespace);
      if (existing) {
        existing.push(result);
      } else {
        byNamespace.set(namespace, [result]);
      }
    };
    const resolvedAmbiguousSeeds = new Map<
      string,
      { namespace: string; result: QmdSearchResult } | null
    >();
    const resolveAmbiguousSeedOwner = async (
      result: QmdSearchResult,
      parts: { collection: string; relativePath: string } | null,
    ): Promise<{ namespace: string; result: QmdSearchResult } | null> => {
      const cached = resolvedAmbiguousSeeds.get(result.path);
      if (cached !== undefined) return cached;
      if (deadlineExpired()) {
        resolvedAmbiguousSeeds.set(result.path, null);
        return null;
      }

      let resolvedPath = result.path;
      let resolvedResult = result;
      if (parts) {
        const resolvedCold = await this.resolveColdQmdResultForRecall(
          result,
          this.getStorage(),
          options.recallNamespaces,
        );
        if (!resolvedCold || deadlineExpired()) {
          resolvedAmbiguousSeeds.set(result.path, null);
          return null;
        }
        resolvedPath = resolvedCold.result.path;
        resolvedResult = resolvedCold.result;
      }

      if (!path.isAbsolute(resolvedPath)) {
        resolvedAmbiguousSeeds.set(result.path, null);
        return null;
      }
      const ownerStorage = await this.storageForAbsoluteQmdResultPath(
        resolvedPath,
        this.getStorage(),
        options.recallNamespaces,
      );
      const ownerNamespace = ownerStorage?.namespace ?? null;
      const resolved =
        ownerNamespace && options.recallNamespaces.includes(ownerNamespace)
          ? { namespace: ownerNamespace, result: resolvedResult }
          : null;
      resolvedAmbiguousSeeds.set(result.path, resolved);
      return resolved;
    };
    const coldCollection = config.qmdColdCollection ?? "openclaw-engram-cold";
    for (const result of options.memoryResults) {
      if (deadlineExpired()) break;
      const parts = qmdCollectionPathParts(result.path);
      if (parts?.collection === coldCollection) {
        const resolved = await resolveAmbiguousSeedOwner(result, parts);
        if (resolved) {
          addResultForNamespace(resolved.namespace, resolved.result);
        }
        continue;
      }
      if (path.isAbsolute(result.path)) {
        const resolved = await resolveAmbiguousSeedOwner(result, null);
        if (resolved) {
          addResultForNamespace(resolved.namespace, resolved.result);
        }
        continue;
      }
      const ns = result.namespace ?? this.namespaceFromPath(result.path);
      if (!options.recallNamespaces.includes(ns)) continue;
      addResultForNamespace(ns, result);
    }

    const perNamespaceSeedCap = Math.max(3, options.recallResultLimit);
    const perNamespaceExpandedCap = Math.max(8, options.recallResultLimit * 2);
    const seedPaths: string[] = [];
    const seedResults: QmdSearchResult[] = [];
    const expandedPaths: GraphRecallExpandedEntry[] = [];
    const expandedResults: QmdSearchResult[] = [];

    for (const [namespace, nsResults] of byNamespace.entries()) {
      if (deadlineExpired()) break;
      const storage = await this.storageFor(namespace);
      const seedCandidates = nsResults.slice(0, perNamespaceSeedCap);
      seedResults.push(...seedCandidates);
      const seedRelativePaths =
        typeof options.deadlineAtMs === "number"
          ? await this.graphSeedPathsWithinDeadline(
              storage,
              seedCandidates,
              options.deadlineAtMs,
              [namespace],
            )
          : (
              await Promise.all(
                seedCandidates.map((result) =>
                  this.graphSeedPathRelativeToStorage(storage, result, [
                    namespace,
                  ]),
                ),
              )
            ).filter(
              (value): value is string =>
                typeof value === "string" && value.length > 0,
            );
      if (deadlineExpired()) break;
      if (seedRelativePaths.length === 0) continue;

      const seedRecallScore = seedCandidates.reduce(
        (max, item) => Math.max(max, item.score),
        0,
      );
      seedPaths.push(
        ...seedRelativePaths.map((rel) => path.join(storage.dir, rel)),
      );
      const seedSet = new Set(seedRelativePaths);
      const expanded = await this.graphIndexFor(storage).spreadingActivation(
        seedRelativePaths,
        config.maxGraphTraversalSteps,
        {
          ...(options.includeLowConfidence === true ? { includeLowConfidence: true } : {}),
          ...(typeof options.deadlineAtMs === "number"
            ? { deadlineAtMs: options.deadlineAtMs }
            : {}),
        },
      );
      if (expanded.length === 0) continue;
      if (deadlineExpired()) break;

      for (const candidate of expanded.slice(0, perNamespaceExpandedCap)) {
        if (deadlineExpired()) break;
        if (seedSet.has(candidate.path)) continue;
        const memoryPath = path.resolve(storage.dir, candidate.path);
        const memory = await storage.readMemoryByPath(memoryPath);
        if (deadlineExpired()) break;
        if (!memory) continue;
        if (/(?:^|[\\/])artifacts(?:[\\/]|$)/i.test(memory.path)) continue;
        if (memory.frontmatter.status && memory.frontmatter.status !== "active")
          continue;

        const snippet = memory.content.slice(0, 400);
        const score = blendGraphExpandedRecallScore({
          graphActivationScore: candidate.score,
          seedRecallScore,
          activationWeight: config.graphExpansionActivationWeight,
          blendMin: config.graphExpansionBlendMin,
          blendMax: config.graphExpansionBlendMax,
        });
        expandedResults.push({
          docid: memory.frontmatter.id,
          path: memory.path,
          namespace,
          snippet,
          score,
        });
        expandedPaths.push({
          path: memory.path,
          score,
          namespace,
          seed: path.resolve(storage.dir, candidate.seed),
          hopDepth: candidate.hopDepth,
          decayedWeight: candidate.decayedWeight,
          graphType: candidate.graphType,
          // Issue #681 PR 3/3 — surface the per-edge confidence used for
          // PageRank weighting / floor pruning so downstream observability
          // (recall_xray, memory_graph_explain) can attribute ranking and
          // pruning decisions to specific edges.
          edgeConfidence: candidate.edgeConfidence,
        });
      }
    }

    const namespacedPrimaryResults = Array.from(byNamespace.entries()).flatMap(
      ([namespace, results]) =>
        results.map((result) => ({ ...result, namespace })),
    );
    return {
      merged: mergeGraphExpandedResults(namespacedPrimaryResults, expandedResults),
      seedPaths,
      expandedPaths,
      seedResults,
    };
  }

  async recordLastGraphRecallSnapshot(options: {
    storage: StorageManager;
    prompt: string;
    recallMode: RecallPlanMode;
    recallNamespaces: string[];
    seedPaths: string[];
    expandedPaths: GraphRecallExpandedEntry[];
    status: "completed" | "skipped" | "aborted";
    reason?: string;
    shadowMode?: boolean;
    queryIntent: MemoryIntent;
    seedResults?: GraphRecallRankedResult[];
    finalResults?: GraphRecallRankedResult[];
    shadowComparison?: GraphRecallShadowComparison;
  }): Promise<void> {
    try {
      const snapshotPath = path.join(
        options.storage.dir,
        "state",
        "last_graph_recall.json",
      );
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      const now = new Date().toISOString();
      const totalSeedCount = options.seedPaths.length;
      const totalExpandedCount = options.expandedPaths.length;
      const seeds = options.seedPaths.slice(0, 64);
      const expanded = clampGraphRecallExpandedEntries(
        options.expandedPaths,
        64,
      );
      const payload = {
        recordedAt: now,
        mode: options.recallMode,
        queryHash: createHash("sha256").update(options.prompt).digest("hex"),
        queryLength: options.prompt.length,
        namespaces: options.recallNamespaces,
        seedCount: totalSeedCount,
        expandedCount: totalExpandedCount,
        seeds,
        expanded,
        status: options.status,
        reason: options.reason,
        shadowMode: options.shadowMode === true,
        queryIntent: options.queryIntent,
        seedResults: (options.seedResults ?? []).slice(0, 64),
        finalResults: (options.finalResults ?? []).slice(0, 64),
        shadowComparison: options.shadowComparison,
      };
      await writeFile(snapshotPath, JSON.stringify(payload, null, 2), "utf-8");
    } catch (err) {
      log.debug(`last graph recall write failed: ${err}`);
    }
  }

  private async graphSeedPathRelativeToStorage(
    storage: StorageManager,
    result: QmdSearchResult,
    recallNamespaces: readonly string[] = [],
  ): Promise<string | null> {
    const parts = qmdCollectionPathParts(result.path);
    if (parts) {
      const memory = await this.readQmdResultMemory(
        result.path,
        storage,
        recallNamespaces,
      );
      return memory
        ? graphPathRelativeToStorage(storage.dir, memory.path)
        : null;
    }
    return graphPathRelativeToStorage(storage.dir, result.path);
  }

  private async graphSeedPathsWithinDeadline(
    storage: StorageManager,
    results: QmdSearchResult[],
    deadlineAtMs: number,
    recallNamespaces: readonly string[] = [],
  ): Promise<string[]> {
    const resolved: string[] = [];
    for (const result of results) {
      if (Date.now() >= deadlineAtMs) break;
      const seedPath = await this.graphSeedPathRelativeToStorage(
        storage,
        result,
        recallNamespaces,
      );
      if (Date.now() >= deadlineAtMs) break;
      if (seedPath) resolved.push(seedPath);
    }
    return resolved;
  }
}
