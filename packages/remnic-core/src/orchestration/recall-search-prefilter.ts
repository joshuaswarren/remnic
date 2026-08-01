import path from "node:path";
import { resolveIndexingCapabilities, resolveMemoryLifecycleCapabilities } from "../capabilities.js";
import type { EmbeddingFallback } from "../embedding-fallback.js";
import type { StorageManager } from "../index.js";
import type { NamespaceStorageRouter } from "../namespaces/storage.js";
import {
  computeArtifactCandidateFetchLimit,
  throwIfRecallAborted,
  type QueryAwarePrefilter,
} from "../orchestrator.js";
import {
  extractTagsFromPrompt,
  isTemporalQuery,
  queryByDateRangeAsync,
  readIndexSnapshotAsync,
  recencyWindowFromPrompt,
  resolvePromptTagPrefilterAsync,
} from "../temporal-index.js";
import type { MemoryFile, PluginConfig, QmdSearchResult } from "../types.js";
import { isGenericRecallExcludedPath } from "./generic-recall-paths.js";

export interface PrefilterAndArtifactDeps {
  readonly config: PluginConfig;
  readonly storageRouter: NamespaceStorageRouter;
  readonly storage: StorageManager;
  readonly embeddingFallback: EmbeddingFallback;
  resolveArtifactSourceStatuses(
    storage: StorageManager,
    sourceIds: string[],
  ): Promise<Map<string, "active" | "superseded" | "archived" | "missing">>;
  scopeQueryAwarePaths(
    paths: Set<string> | null,
    recallNamespaces: string[],
  ): Set<string> | null;
  searchScopedMemoryCandidates(
    candidatePaths: Set<string>,
    query: string,
    limit: number,
    options?: {
      allowArchived?: boolean;
    },
  ): Promise<QmdSearchResult[]>;
}

export async function fetchActiveArtifactsForNamespace(
  deps: Pick<PrefilterAndArtifactDeps, "storageRouter" | "resolveArtifactSourceStatuses">,
  namespace: string,
  prompt: string,
  targetCount: number,
): Promise<MemoryFile[]> {
  const storage = await deps.storageRouter.storageFor(namespace);
  let fetchLimit = computeArtifactCandidateFetchLimit(targetCount);
  const maxFetchLimit = Math.min(800, Math.max(fetchLimit, targetCount * 8));
  const MAX_ATTEMPTS = 4;
  let bestFiltered: MemoryFile[] = [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const rawResults = await storage.searchArtifacts(prompt, fetchLimit);
    const sourceIds = Array.from(
      new Set(
        rawResults
          .map((a) => a.frontmatter.sourceMemoryId)
          .filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          ),
      ),
    );
    const sourceStatus =
      sourceIds.length > 0
        ? await deps.resolveArtifactSourceStatuses(storage, sourceIds)
        : new Map<string, "active" | "superseded" | "archived" | "missing">();

    const filtered: MemoryFile[] = [];
    for (const artifact of rawResults) {
      const sourceId = artifact.frontmatter.sourceMemoryId;
      if (!sourceId) {
        filtered.push(artifact);
        if (filtered.length >= targetCount) break;
        continue;
      }
      const status = sourceStatus.get(sourceId) ?? "missing";
      if (status !== "active") continue;
      filtered.push(artifact);
      if (filtered.length >= targetCount) break;
    }

    if (filtered.length >= targetCount) return filtered.slice(0, targetCount);
    if (filtered.length > bestFiltered.length) {
      bestFiltered = filtered;
    }
    if (rawResults.length === 0) return filtered;
    if (rawResults.length < fetchLimit && filtered.length > 0)
      return filtered;
    if (fetchLimit >= maxFetchLimit) return filtered;

    const growth = Math.max(targetCount * 2, 12);
    fetchLimit = Math.min(maxFetchLimit, fetchLimit + growth);
  }

  return bestFiltered;
}

export async function buildQueryAwarePrefilter(
  deps: Pick<PrefilterAndArtifactDeps, "config" | "scopeQueryAwarePaths">,
  prompt: string,
  recallNamespaces: string[],
): Promise<QueryAwarePrefilter> {
  if (!resolveIndexingCapabilities(deps.config).queryAwareIndexing || !prompt.trim()) {
    return {
      candidatePaths: null,
      temporalFromDate: null,
      matchedTags: [],
      expandedTags: [],
      combination: "none",
      filteredToFullSearch: false,
    };
  }

  const temporalFromDate = isTemporalQuery(prompt)
    ? recencyWindowFromPrompt(prompt, Date.now())
    : null;
  // Read the temporal + tag prefilter indexes as ONE consistent snapshot
  // (issue #1911, Codex Medium) so a concurrent async index mutation can't be
  // observed half-applied (new temporal row, tag membership not yet written),
  // which would drop the current memory from the tag prefilter.
  const [rawTemporal, tagSignals] = await readIndexSnapshotAsync(
    deps.config.memoryDir,
    () =>
      Promise.all([
        temporalFromDate
          ? queryByDateRangeAsync(deps.config.memoryDir, temporalFromDate)
          : Promise.resolve<Set<string> | null>(null),
        resolvePromptTagPrefilterAsync(deps.config.memoryDir, prompt).catch(
          () => ({
            matchedTags: extractTagsFromPrompt(prompt),
            expandedTags: extractTagsFromPrompt(prompt),
            paths: null,
          }),
        ),
      ]),
  );

  const temporalCandidates = deps.scopeQueryAwarePaths(
    rawTemporal,
    recallNamespaces,
  );
  const tagCandidates = deps.scopeQueryAwarePaths(
    tagSignals.paths,
    recallNamespaces,
  );
  const maxCandidates = deps.config.queryAwareIndexingMaxCandidates;

  let candidatePaths: Set<string> | null = null;
  let combination: QueryAwarePrefilter["combination"] = "none";
  let filteredToFullSearch = false;

  if (
    tagSignals.matchedTags.length > 0 &&
    tagCandidates !== null &&
    tagCandidates.size === 0
  ) {
    candidatePaths = tagCandidates;
    combination = "tag";
  } else if (temporalCandidates !== null && tagCandidates !== null) {
    const intersection = new Set(
      Array.from(temporalCandidates).filter((memoryPath) =>
        tagCandidates.has(memoryPath),
      ),
    );
    if (intersection.size > 0) {
      candidatePaths = intersection;
      combination = "intersection";
    } else {
      candidatePaths = new Set([...temporalCandidates, ...tagCandidates]);
      combination = "union";
    }
  } else if (temporalCandidates !== null) {
    candidatePaths = temporalCandidates;
    combination = "temporal";
  } else if (tagCandidates !== null) {
    candidatePaths = tagCandidates;
    combination = "tag";
  }

  if (
    candidatePaths &&
    maxCandidates > 0 &&
    candidatePaths.size > maxCandidates
  ) {
    filteredToFullSearch = true;
    candidatePaths = null;
  }

  return {
    candidatePaths,
    temporalFromDate,
    matchedTags: tagSignals.matchedTags,
    expandedTags: tagSignals.expandedTags,
    combination,
    filteredToFullSearch,
  };
}

export async function searchEmbeddingFallback(
  deps: Pick<PrefilterAndArtifactDeps, "config" | "embeddingFallback" | "storage">,
  query: string,
  limit: number,
): Promise<QmdSearchResult[]> {
  if (!resolveMemoryLifecycleCapabilities(deps.config).embeddingFallback) return [];
  if (!(await deps.embeddingFallback.isAvailable())) return [];
  const hits = await deps.embeddingFallback.search(query, limit);
  if (hits.length === 0) return [];

  const results: QmdSearchResult[] = [];
  for (const hit of hits) {
    const fullPath = path.isAbsolute(hit.path)
      ? hit.path
      : path.join(deps.config.memoryDir, hit.path);
    const memory = await deps.storage.readMemoryByPath(fullPath);
    if (!memory) continue;
    results.push({
      docid: hit.id,
      path: fullPath,
      score: hit.score,
      snippet: memory.content.slice(0, 400).replace(/\n/g, " "),
    });
  }
  return results;
}

export async function searchQueryAwareFallback(
  deps: Pick<PrefilterAndArtifactDeps, "config" | "searchScopedMemoryCandidates">,
  prompt: string,
  limit: number,
  queryAwarePrefilter?: QueryAwarePrefilter,
  abortSignal?: AbortSignal,
): Promise<QmdSearchResult[]> {
  throwIfRecallAborted(abortSignal);
  const cappedLimit = Math.max(0, limit);
  if (cappedLimit === 0 || queryAwarePrefilter?.candidatePaths?.size === 0) return [];

  const candidatePaths = queryAwarePrefilter?.candidatePaths;
  const scopedSeedResults = (
    candidatePaths?.size
      ? await deps.searchScopedMemoryCandidates(
          candidatePaths,
          prompt,
          candidatePaths.size,
          { allowArchived: true },
        )
      : []
  ).filter((result) => !isGenericRecallExcludedPath(result.path, deps.config, "qmd"));
  return scopedSeedResults.slice(0, cappedLimit);
}
