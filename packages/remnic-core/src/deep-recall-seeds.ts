/**
 * Deep-recall seed retrieval (issue #2332 review).
 *
 * Seeds route through the SAME namespace search router the rest of the read
 * path uses, so a non-default caller searches its own suffixed collection
 * instead of the base (default-namespace) collection — read and write resolve
 * through one resolver, never two (§30).
 *
 * Each hit is resolved to a real memory id through the shared QMD result
 * resolver, per hit and bounded by the requested limit, instead of pre-scanning
 * the whole namespace corpus to build a path index. A hit with no path is
 * dropped: its namespace membership cannot be verified, and a bare docid from
 * a foreign collection must never enter the working set.
 */

import { qmdResultPathCandidates } from "./orchestration/qmd-result-resolver.js";
import type { DeepRecallSeedHit } from "./deep-recall.js";

/** Namespace-scoped search entrypoint (satisfied by `Orchestrator.searchAcrossNamespaces`). */
export interface DeepRecallSeedRouter {
  searchAcrossNamespaces(options: {
    query: string;
    namespaces: string[];
    maxResults?: number;
  }): Promise<ReadonlyArray<{ path?: string; docid?: string; score?: number }>>;
}

/** Namespace-scoped storage read (satisfied by `StorageManager`). */
export interface DeepRecallSeedStorage {
  readonly dir: string;
  readMemoryByPath(filePath: string): Promise<{ frontmatter: { id?: string } } | null>;
}

async function resolveSeedMemoryId(
  storage: DeepRecallSeedStorage,
  resultPath: string | undefined,
): Promise<string | null> {
  if (typeof resultPath !== "string" || resultPath.length === 0) return null;
  for (const candidate of qmdResultPathCandidates(storage.dir, resultPath)) {
    const memory = await storage.readMemoryByPath(candidate);
    const id = memory?.frontmatter?.id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

export function createDeepRecallSeedSearch(deps: {
  namespace: string;
  storage: DeepRecallSeedStorage;
  router: DeepRecallSeedRouter;
}): (query: string, limit: number) => Promise<DeepRecallSeedHit[]> {
  return async (query, limit) => {
    if (limit <= 0) return [];
    const hits = await deps.router.searchAcrossNamespaces({
      query,
      namespaces: [deps.namespace],
      maxResults: limit,
    });
    const seeds: DeepRecallSeedHit[] = [];
    for (const hit of hits) {
      if (typeof hit.path !== "string" || hit.path.length === 0) continue;
      const memoryId = (await resolveSeedMemoryId(deps.storage, hit.path)) ?? hit.docid;
      if (typeof memoryId !== "string" || memoryId.length === 0) continue;
      seeds.push({
        memoryId,
        score: typeof hit.score === "number" && Number.isFinite(hit.score) ? hit.score : 0,
      });
    }
    return seeds;
  };
}
