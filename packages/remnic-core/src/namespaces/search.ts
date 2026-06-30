import path from "node:path";
import type { PluginConfig, QmdSearchResult } from "../types.js";
import type {
  SearchBackend,
  SearchExecutionOptions,
  SearchQueryOptions,
} from "../search/port.js";
import { createSearchBackend } from "../search/factory.js";
import { namespaceIdentityToken, normalizeNamespaceIdentity } from "./identity.js";

const NESTED_NAMESPACE_FILTER_OVERFETCH_FACTOR = 4;
const NESTED_NAMESPACE_FILTER_OVERFETCH_MIN = 50;

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
  collectionState: CollectionState;
  filtersNestedNamespaces: boolean;
};

export type CollectionState = "present" | "missing" | "unknown" | "skipped";

export interface NamespaceSearchHealth {
  collection: string;
  memoryDir: string;
  available: boolean;
  collectionState: CollectionState;
  debugStatus: string;
  installedVersion: string | null;
  supportedVersion: string | null;
  supported: boolean | null;
  upgradeAvailable: boolean | null;
  doctorAvailable: boolean | null;
  daemonMode: boolean | null;
}

type NamespaceScopedSearchConfig = PluginConfig & {
  hostEmbeddingProviderScope?: string;
};

type BackendRecordOptions = {
  autoCreateCollection: boolean;
  failOpenMissingGuardedCollection: boolean;
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
        const backendLimit = backendSearchLimit(record, maxResults);
        let results: QmdSearchResult[];
        switch (method) {
          case "hybrid":
            results = await record.backend.hybridSearch(
              query,
              record.collection,
              backendLimit,
              options.execution,
            );
            break;
          case "bm25":
            results = await record.backend.bm25Search(
              query,
              record.collection,
              backendLimit,
              options.execution,
            );
            break;
          case "vector":
            results = await record.backend.vectorSearch(
              query,
              record.collection,
              backendLimit,
              options.execution,
            );
            break;
          default:
            results = await record.backend.search(
              query,
              record.collection,
              backendLimit,
              options.searchOptions,
              options.execution,
            );
            break;
        }
        results = filterNamespaceSubtreeResults(record, results);
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

  async ensureNamespaceCollection(
    namespace: string,
    execution?: SearchExecutionOptions,
  ): Promise<"present" | "missing" | "unknown" | "skipped"> {
    const record = await this.backendRecordFor(namespace, execution);
    return record.collectionState;
  }

  async healthForNamespace(
    namespace: string,
    execution?: SearchExecutionOptions,
  ): Promise<NamespaceSearchHealth> {
    const record = await this.createBackendRecordFor(
      namespace.trim() || this.config.defaultNamespace,
      execution,
      {
        autoCreateCollection: false,
        failOpenMissingGuardedCollection: false,
      },
    );
    try {
      const versionStatus =
        "getVersionStatus" in record.backend &&
        typeof record.backend.getVersionStatus === "function"
          ? record.backend.getVersionStatus()
          : null;
      const daemonMode =
        "isDaemonMode" in record.backend &&
        typeof record.backend.isDaemonMode === "function"
          ? record.backend.isDaemonMode() === true
          : null;

      return {
        collection: record.collection,
        memoryDir: record.memoryDir,
        available: record.available,
        collectionState: record.collectionState,
        debugStatus: record.backend.debugStatus(),
        installedVersion: versionStatus?.installedVersion ?? null,
        supportedVersion: versionStatus?.supportedVersion ?? null,
        supported: versionStatus?.supported ?? null,
        upgradeAvailable: versionStatus?.upgradeAvailable ?? null,
        doctorAvailable: versionStatus?.capabilities?.doctor ?? null,
        daemonMode,
      };
    } finally {
      const dispose = (record.backend as { dispose?: () => void | Promise<void> }).dispose;
      await dispose?.call(record.backend);
    }
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

  private async backendRecordFor(
    namespace: string,
    execution?: SearchExecutionOptions,
  ): Promise<NamespaceBackendRecord> {
    const key = namespace.trim() || this.config.defaultNamespace;
    const existing = this.cache.get(key);
    if (existing) return await existing;

    const pending = this.createBackendRecordFor(key, execution, {
      autoCreateCollection: true,
      failOpenMissingGuardedCollection: true,
    });

    this.cache.set(key, pending);
    return await pending;
  }

  private async createBackendRecordFor(
    namespace: string,
    execution: SearchExecutionOptions | undefined,
    options: BackendRecordOptions,
  ): Promise<NamespaceBackendRecord> {
    const key = namespace.trim() || this.config.defaultNamespace;
    const storage = await this.storageRouter.storageFor(key);
    const useLegacyDefaultCollection =
      key === this.config.defaultNamespace && storage.dir === this.config.memoryDir;
    const filtersNestedNamespaces =
      this.config.namespacesEnabled === true && useLegacyDefaultCollection;
    const rootHostEmbeddingScope =
      (this.config as NamespaceScopedSearchConfig).hostEmbeddingProviderScope ??
      this.config.memoryDir;
    const scopedConfig: NamespaceScopedSearchConfig = {
      ...this.config,
      memoryDir: storage.dir,
      hostEmbeddingProviderScope: rootHostEmbeddingScope,
      qmdCollection: namespaceCollectionName(this.config.qmdCollection, key, {
        defaultNamespace: this.config.defaultNamespace,
        useLegacyDefaultCollection,
      }),
    };

    const backend = this.createBackend(scopedConfig);
    const available = await awaitWithAbort(backend.probe(), execution?.signal).catch(() => false);
    const collectionState = available
      ? await awaitWithAbort(
        this.collectionStateForBackend(backend, storage.dir, scopedConfig.qmdCollection, {
          autoCreate: options.autoCreateCollection,
          failOpenMissingGuardedCollection: options.failOpenMissingGuardedCollection,
          skipAutoCreate: filtersNestedNamespaces,
          execution,
        }),
        execution?.signal,
      ).catch(() => "unknown" as const)
      : "unknown";
    return {
      backend,
      collection: scopedConfig.qmdCollection,
      memoryDir: storage.dir,
      available,
      collectionState,
      filtersNestedNamespaces,
    };
  }

  private async collectionStateForBackend(
    backend: SearchBackend,
    memoryDir: string,
    collection: string,
    options: {
      autoCreate: boolean;
      failOpenMissingGuardedCollection: boolean;
      skipAutoCreate: boolean;
      execution?: SearchExecutionOptions;
    },
  ): Promise<CollectionState> {
    if (!options.autoCreate || options.skipAutoCreate) {
      if (!backend.checkCollection) return "unknown";
      const collectionState = await backend
        .checkCollection(collection, options.execution)
        .catch(() => "unknown" as const);
      return options.failOpenMissingGuardedCollection && collectionState === "missing"
        ? "unknown"
        : collectionState;
    }
    return await backend.ensureCollection(memoryDir, collection, options.execution).catch(() => "unknown" as const);
  }
}

function awaitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new Error("operation aborted"));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("operation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function filterNamespaceSubtreeResults(
  record: NamespaceBackendRecord,
  results: QmdSearchResult[],
): QmdSearchResult[] {
  if (!record.filtersNestedNamespaces) return results;
  return results.filter((result) =>
    !pathIsInsideNamespaceSubtree(record.memoryDir, record.collection, result.path)
  );
}

function backendSearchLimit(
  record: NamespaceBackendRecord,
  maxResults: number,
): number {
  if (!record.filtersNestedNamespaces) return maxResults;
  return Math.max(
    maxResults,
    maxResults * NESTED_NAMESPACE_FILTER_OVERFETCH_FACTOR,
    NESTED_NAMESPACE_FILTER_OVERFETCH_MIN,
  );
}

function pathIsInsideNamespaceSubtree(
  memoryDir: string,
  collection: string,
  resultPath: string | undefined,
): boolean {
  if (!resultPath) return false;
  const normalizedResultPath = normalizeQmdResultPath(resultPath, collection);
  const memoryRoot = path.resolve(memoryDir);
  const namespacesRoot = path.join(memoryRoot, "namespaces");
  const candidate = path.isAbsolute(normalizedResultPath)
    ? path.normalize(normalizedResultPath)
    : path.resolve(memoryRoot, normalizedResultPath);
  const relative = path.relative(namespacesRoot, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeQmdResultPath(resultPath: string, collection: string): string {
  let value = resultPath.trim();
  if (value.startsWith("qmd://")) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol === "qmd:" && parsed.hostname === collection) {
        value = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
      }
    } catch {
      const remainder = value.slice("qmd://".length);
      const slashIndex = remainder.indexOf("/");
      if (slashIndex !== -1) {
        value = remainder.slice(slashIndex + 1);
      }
    }
  }

  const collectionPrefix = `${collection}/`;
  if (value.startsWith(collectionPrefix)) {
    value = value.slice(collectionPrefix.length);
  }
  return value;
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
