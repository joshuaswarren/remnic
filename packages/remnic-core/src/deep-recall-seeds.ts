/**
 * Deep-recall seed retrieval (issue #2332 review).
 *
 * Seeds route through the SAME namespace search router the rest of the read
 * path uses, so a non-default caller searches its own suffixed collection
 * instead of the base (default-namespace) collection — read and write resolve
 * through one resolver, never two (§30).
 *
 * Each hit is resolved to a real memory id through the shared QMD result
 * resolver (`QmdResultResolver.readQmdResultMemory`), per hit and bounded by
 * the requested limit, instead of pre-scanning the whole namespace corpus to
 * build a path index. With namespaces disabled the fanout queries the QMD
 * backend directly, so hits keep the indexer's raw path forms; the resolver
 * decodes `qmd://<collection>/` URIs and `<collection>/`-prefixed relatives,
 * and the two forms it cannot decode (`qmd:///`, a leading `/`) are stripped
 * for one retry. A hit with no path is dropped: its namespace membership
 * cannot be verified, and a bare docid from a foreign collection must never
 * enter the working set as a resolved memory.
 *
 * An unavailable namespace backend (or a missing collection) contributes an
 * empty result set and reports itself only through `execution.onDegradation`,
 * so the observer is REQUIRED here: without it a dead index is indistinguishable
 * from a healthy empty one and deep recall would answer `ok: true` with zero
 * entries instead of the advertised `backend_unavailable` failure.
 */

import type { DeepRecallSeedHit } from "./deep-recall.js";
import type { SearchDegradation } from "./search/port.js";

/** Namespace-scoped search entrypoint (satisfied by `Orchestrator.searchAcrossNamespaces`). */
export interface DeepRecallSeedRouter {
  searchAcrossNamespaces(options: {
    query: string;
    namespaces: string[];
    maxResults?: number;
    execution?: { onDegradation?: (degradation: SearchDegradation) => void };
  }): Promise<ReadonlyArray<{ path?: string; docid?: string; score?: number }>>;
}

/** Namespace-scoped storage read (satisfied by `StorageManager`). */
export interface DeepRecallSeedStorage {
  readonly dir: string;
  readMemoryByPath(filePath: string): Promise<{ frontmatter: { id?: string } } | null>;
}

/** Full QMD hit -> memory resolver (satisfied by `QmdResultResolver#readQmdResultMemory`). */
export interface DeepRecallSeedResultResolver {
  readQmdResultMemory(
    resultPath: string,
    fallbackStorage: DeepRecallSeedStorage,
    recallNamespaces?: readonly string[],
    preferredNamespace?: string,
  ): Promise<{ frontmatter: { id?: string } } | null>;
}

/**
 * Strip the collection-qualified forms the indexer can emit but
 * `readQmdResultMemory` cannot decode: the empty-hostname `qmd:///` URI and
 * the root-relative `/` path both reach its fallback probe still prefixed and
 * miss. Returns `null` when the path carries no such prefix — including a
 * decodable `qmd://<collection>/` or `<collection>/` form, which the resolver
 * owns, and a foreign collection prefix, which must stay a miss.
 */
function collectionPrefixStrippedPath(resultPath: string): string | null {
  const trimmed = resultPath.trim();
  if (trimmed.startsWith("qmd:///")) {
    const relative = trimmed.slice("qmd:///".length).replace(/^\/+/, "");
    return relative.length > 0 ? relative : null;
  }
  if (trimmed.startsWith("/")) {
    const relative = trimmed.replace(/^\/+/, "");
    return relative.length > 0 ? relative : null;
  }
  return null;
}

async function resolveSeedMemoryId(
  resolver: DeepRecallSeedResultResolver,
  storage: DeepRecallSeedStorage,
  namespace: string,
  resultPath: string | undefined,
): Promise<string | null> {
  if (typeof resultPath !== "string" || resultPath.length === 0) return null;
  const attempts = [resultPath];
  const stripped = collectionPrefixStrippedPath(resultPath);
  if (stripped !== null) attempts.push(stripped);
  for (const attempt of attempts) {
    const memory = await resolver.readQmdResultMemory(attempt, storage, [namespace]);
    const id = memory?.frontmatter?.id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

export function createDeepRecallSeedSearch(deps: {
  namespace: string;
  storage: DeepRecallSeedStorage;
  router: DeepRecallSeedRouter;
  resolver: DeepRecallSeedResultResolver;
}): (query: string, limit: number) => Promise<DeepRecallSeedHit[]> {
  return async (query, limit) => {
    if (limit <= 0) return [];
    const unavailable: SearchDegradation[] = [];
    const hits = await deps.router.searchAcrossNamespaces({
      query,
      namespaces: [deps.namespace],
      maxResults: limit,
      execution: {
        onDegradation: (degradation) => {
          if (degradation.code === "backend_unavailable") unavailable.push(degradation);
        },
      },
    });
    // The requested namespace has no usable index: a seed-search failure, which
    // is the one condition deep recall reports as `backend_unavailable`.
    if (unavailable.length > 0) {
      throw new Error(
        `deep recall seed search unavailable: ${unavailable.map((d) => d.detail ?? d.code).join("; ")}`,
      );
    }
    const seeds: DeepRecallSeedHit[] = [];
    for (const hit of hits) {
      if (typeof hit.path !== "string" || hit.path.length === 0) continue;
      const memoryId =
        (await resolveSeedMemoryId(deps.resolver, deps.storage, deps.namespace, hit.path)) ?? hit.docid;
      if (typeof memoryId !== "string" || memoryId.length === 0) continue;
      seeds.push({
        memoryId,
        score: typeof hit.score === "number" && Number.isFinite(hit.score) ? hit.score : 0,
      });
    }
    return seeds;
  };
}
