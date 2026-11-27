
import type { DeepRecallSeedHit } from "./deep-recall.js";
import type { SearchDegradation } from "./search/port.js";

/** Namespace-scoped search entrypoint (satisfied by `Orchestrator.searchAcrossNamespaces`). */
export interface DeepRecallSeedRouter {
  searchAcrossNamespaces(options: {
    query: string;
    namespaces: string[];
    maxResults?: number;
    execution?: {
      signal?: AbortSignal;
      onDegradation?: (degradation: SearchDegradation) => void;
    };
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
  /** Transport cancellation (issue #2915); forwarded to the search router. */
  signal?: AbortSignal;
}): (query: string, limit: number) => Promise<DeepRecallSeedHit[]> {
  return async (query, limit) => {
    if (limit <= 0) return [];
    const unavailable: SearchDegradation[] = [];
    const hits = await deps.router.searchAcrossNamespaces({
      query,
      namespaces: [deps.namespace],
      maxResults: limit,
      execution: {
        ...(deps.signal ? { signal: deps.signal } : {}),
        onDegradation: (degradation) => {
          if (degradation.code === "backend_unavailable") unavailable.push(degradation);
        },
      },
    });
    if (unavailable.length > 0) {
      throw new Error(
        `deep recall seed search unavailable: ${unavailable.map((d) => d.detail ?? d.code).join("; ")}`,
      );
    }
    const seeds: DeepRecallSeedHit[] = [];
    for (const hit of hits) {
      if (typeof hit.path !== "string" || hit.path.length === 0) continue;
      const memoryId = await resolveSeedMemoryId(deps.resolver, deps.storage, deps.namespace, hit.path);
      if (memoryId === null) continue;
      seeds.push({
        memoryId,
        score: typeof hit.score === "number" && Number.isFinite(hit.score) ? hit.score : 0,
      });
    }
    return seeds;
  };
}
