import type { PluginConfig, QmdSearchResult } from "../types.js";
import type { SearchBackend, SearchExecutionOptions, SearchQueryOptions } from "../search/port.js";
import { createSearchBackend } from "../search/factory.js";
import { namespaceIdentityToken, normalizeNamespaceIdentity } from "./identity.js";

export function namespaceCollectionName(
  baseCollection: string,
  namespace: string,
  options?: {
    defaultNamespace?: string;
    useLegacyDefaultCollection?: boolean;
  },
): string {
  const trimmed = normalizeNamespaceIdentity(namespace);
  const defaultNamespace = normalizeNamespaceIdentity(options?.defaultNamespace ?? "") || "default";
  if (
    options?.useLegacyDefaultCollection === true &&
    trimmed === defaultNamespace
  ) {
    return baseCollection;
  }

  return `${baseCollection}--${namespaceIdentityToken(trimmed || defaultNamespace)}`;
}

type StorageRouterLike = {
  storageFor(namespace: string): Promise<{ dir: string }>;
};

type NamespaceBackendRecord = {
  backend: SearchBackend;
  collection: string;
  memoryDir: string;
  available: boolean;
  collectionState: "present" | "missing" | "unknown" | "skipped";
};

export class NamespaceSearchRouter {
  private readonly cache = new Map<string, Promise<NamespaceBackendRecord>>();

  constructor(
    private readonly config: PluginConfig,
    private readonly storageRouter: StorageRouterLike,
    private readonly createBackend: (config: PluginConfig) => SearchBackend = createSearchBackend,
  ) {}

  async collectionForNamespace(namespace: string): Promise<string> {
    return (await this.backendRecordFor(namespace)).collection;
  }

  async searchAcrossNamespaces(options: {
    query: string;
    namespaces: string[];
    maxResults?: number;
    mode?: "search" | "hybrid" | "bm25" | "vector";
    searchOptions?: SearchQueryOptions;
    execution?: SearchExecutionOptions;
  }): Promise<QmdSearchResult[]> {
    const query = options.query.trim();
    if (!query) return [];
    const maxResults = Math.max(0, Math.floor(options.maxResults ?? this.config.qmdMaxResults));
    if (maxResults === 0) return [];

    const method = options.mode ?? "search";
    const namespaces = Array.from(new Set(options.namespaces.map((value) => value.trim()).filter(Boolean)));
    if (namespaces.length === 0) return [];

    const resultsByNamespace = await Promise.all(
      namespaces.map(async (namespace) => {
        const record = await this.backendRecordFor(namespace);
        if (!record.available || record.collectionState === "missing") {
          return { namespace, results: [] as QmdSearchResult[] };
        }
        let results: QmdSearchResult[];
        switch (method) {
          case "hybrid":
            results = await record.backend.hybridSearch(query, record.collection, maxResults, options.execution);
            break;
          case "bm25":
            results = await record.backend.bm25Search(query, record.collection, maxResults, options.execution);
            break;
          case "vector":
            results = await record.backend.vectorSearch(query, record.collection, maxResults, options.execution);
            break;
          default:
            results = await record.backend.search(
              query,
              record.collection,
              maxResults,
              options.searchOptions,
              options.execution,
            );
            break;
        }
        return { namespace, results };
      }),
    );

    return mergeNamespaceSearchResults(resultsByNamespace, maxResults);
  }

  /**
   * Update all namespace backends.
   * Returns the number of backends for which an update was attempted
   * (i.e., available and collection present).  Callers can treat 0 as a
   * signal that no backend was eligible — useful for success-verification in
   * startup-sync when namespacesEnabled is true.
   */
  async updateNamespaces(
    namespaces: string[],
    execution?: SearchExecutionOptions,
  ): Promise<number> {
    const unique = Array.from(new Set(namespaces.map((value) => value.trim()).filter(Boolean)));
    const eligible = (await Promise.all(
      unique.map(async (namespace) => {
        const record = await this.backendRecordFor(namespace);
        return record.available && record.collectionState !== "missing"
          ? record
          : null;
      }),
    )).filter((record): record is NamespaceBackendRecord => record !== null);

    const globalRecord = eligible.find((record) => record.backend.updatesAllCollections?.() === true);
    const scopedRecords = globalRecord
      ? eligible.filter((record) => record.backend.updatesAllCollections?.() !== true)
      : eligible;

    await Promise.all([
      globalRecord ? globalRecord.backend.update(execution) : Promise.resolve(),
      ...scopedRecords.map((record) => record.backend.update(execution)),
    ]);

    return (globalRecord ? 1 : 0) + scopedRecords.length;
  }

  async embedNamespaces(namespaces: string[]): Promise<void> {
    const unique = Array.from(new Set(namespaces.map((value) => value.trim()).filter(Boolean)));
    await Promise.all(
      unique.map(async (namespace) => {
        const record = await this.backendRecordFor(namespace);
        if (!record.available || record.collectionState === "missing") return;
        await record.backend.embed();
      }),
    );
  }

  async ensureNamespaceCollection(namespace: string): Promise<"present" | "missing" | "unknown" | "skipped"> {
    const record = await this.backendRecordFor(namespace);
    return record.collectionState;
  }

  /** Clear cached backend records so the next access re-probes availability. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Release any per-namespace backend handles held by cached records. */
  async dispose(): Promise<void> {
    const pendingRecords = Array.from(this.cache.values());
    this.cache.clear();
    const settled = await Promise.allSettled(pendingRecords);
    await Promise.allSettled(
      settled.flatMap((entry) => {
        if (entry.status !== "fulfilled") return [];
        const dispose = (entry.value.backend as { dispose?: () => void | Promise<void> }).dispose;
        return dispose ? [dispose.call(entry.value.backend)] : [];
      }),
    );
  }

  private async backendRecordFor(namespace: string): Promise<NamespaceBackendRecord> {
    const key = namespace.trim() || this.config.defaultNamespace;
    const existing = this.cache.get(key);
    if (existing) return await existing;

    const pending = (async (): Promise<NamespaceBackendRecord> => {
      const storage = await this.storageRouter.storageFor(key);
      const useLegacyDefaultCollection =
        key === this.config.defaultNamespace && storage.dir === this.config.memoryDir;
      const scopedConfig: PluginConfig = {
        ...this.config,
        memoryDir: storage.dir,
        qmdCollection: namespaceCollectionName(this.config.qmdCollection, key, {
          defaultNamespace: this.config.defaultNamespace,
          useLegacyDefaultCollection,
        }),
      };

      const backend = this.createBackend(scopedConfig);
      const available = await backend.probe().catch(() => false);
      const collectionState = available
        ? await backend.ensureCollection(storage.dir).catch(() => "unknown" as const)
        : "unknown";
      return {
        backend,
        collection: scopedConfig.qmdCollection,
        memoryDir: storage.dir,
        available,
        collectionState,
      };
    })();

    this.cache.set(key, pending);
    return await pending;
  }
}

function mergeNamespaceSearchResults(
  lists: Array<{ namespace: string; results: QmdSearchResult[] }>,
  maxResults: number,
): QmdSearchResult[] {
  const merged = new Map<string, QmdSearchResult>();

  for (const { namespace, results } of lists) {
    for (const result of results) {
      const key = `${namespace}\0${result.path || result.docid}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, result);
        continue;
      }
      if (result.score > existing.score) {
        merged.set(key, {
          ...result,
          snippet: existing.snippet || result.snippet || "",
        });
      }
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}
