import { resolveNamespaceCapabilities } from "../capabilities.js";
import path from "node:path";
import type { PluginConfig, QmdSearchResult } from "../types.js";
import type {
  SearchBackend,
  SearchExecutionOptions,
  SearchQueryOptions,
} from "../search/port.js";
import { createSearchBackend } from "../search/factory.js";
import { namespaceIdentityToken, normalizeNamespaceIdentity } from "./identity.js";
import { ALL_CATEGORY_DIRS } from "../utils/category-dir.js";

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

export interface NamespaceUpdateResult {
  backendCount: number;
  eligibleNamespaces: string[];
}

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
  abortAsUnavailable: boolean;
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
          // A per-namespace backend that is unavailable (or missing its
          // collection) must report like any other QMD skip (#1536): its
          // empty contribution is otherwise indistinguishable from a true
          // no-matches for that namespace (codex round-5 review on #1544).
          try {
            options.execution?.onDegradation?.({
              backend: "qmd",
              code: "backend_unavailable",
              detail:
                record.collectionState === "missing"
                  ? `namespace collection missing: ${namespace}`
                  : `namespace backend unavailable: ${namespace}`,
            });
          } catch {
            // Observers must never break search.
          }
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
        results = filterNamespaceSubtreeResults(record, results).map((result) => ({
          ...result,
          namespace,
          // Resolve to an absolute path so the (namespace, path) identity is
          // globally unique — same-relative-path hits from different namespaces
          // stay distinct across every downstream consumer with no special
          // handling. Display/citation surfaces relativize for portability (#2020).
          path: resolveNamespaceResultPath(record.memoryDir, record.collection, result.path),
        }));
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
    options?: { strict?: boolean },
  ): Promise<number> {
    return (await this.updateNamespacesDetailed(namespaces, execution, options)).backendCount;
  }

  async updateNamespacesDetailed(
    namespaces: string[],
    execution?: SearchExecutionOptions,
    options?: { strict?: boolean },
  ): Promise<NamespaceUpdateResult> {
    const unique = Array.from(new Set(namespaces.map((value) => value.trim()).filter(Boolean)));
    const eligible = (await Promise.all(
      unique.map(async (namespace) => {
        const record = await this.backendRecordFor(namespace);
        return record.available && record.collectionState !== "missing"
          ? { namespace, record }
          : null;
      }),
    )).filter((entry): entry is { namespace: string; record: NamespaceBackendRecord } => entry !== null);

    const globalEntry = eligible.find(({ record }) => record.backend.updatesAllCollections?.() === true);
    const scopedEntries = globalEntry
      ? eligible.filter(({ record }) => record.backend.updatesAllCollections?.() !== true)
      : eligible;

    await Promise.all([
      globalEntry
        ? updateBackendRecord(globalEntry.record, execution, options)
        : Promise.resolve(),
      ...scopedEntries.map(({ record }) => updateBackendRecord(record, execution, options)),
    ]);

    return {
      backendCount: (globalEntry ? 1 : 0) + scopedEntries.length,
      eligibleNamespaces: eligible.map(({ namespace }) => namespace),
    };
  }

  async embedNamespaces(namespaces: string[], options?: { strict?: boolean }): Promise<void> {
    const unique = Array.from(new Set(namespaces.map((value) => value.trim()).filter(Boolean)));
    await Promise.all(
      unique.map(async (namespace) => {
        const record = await this.backendRecordFor(namespace);
        if (!record.available || record.collectionState === "missing") return;
        await embedBackendRecord(record, options);
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
    const key = namespace.trim() || this.config.defaultNamespace;
    const record = await this.createBackendRecordFor(
      key,
      execution,
      {
        autoCreateCollection: false,
        abortAsUnavailable: true,
        failOpenMissingGuardedCollection: false,
      },
    );
    try {
      const liveRecord = await this.liveCachedRecordForHealth(key, record, execution);
      const diagnosticBackend = liveRecord?.backend ?? record.backend;
      const versionStatus =
        "getVersionStatus" in diagnosticBackend &&
        typeof diagnosticBackend.getVersionStatus === "function"
          ? diagnosticBackend.getVersionStatus()
          : null;
      const daemonMode = daemonModeForBackend(diagnosticBackend);
      const collectionState =
        liveRecord?.collectionState === "missing"
          ? "missing"
          : record.collectionState;

      return {
        collection: record.collection,
        memoryDir: record.memoryDir,
        available: liveRecord?.available ?? record.available,
        collectionState,
        debugStatus: diagnosticBackend.debugStatus(),
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

  private async liveCachedRecordForHealth(
    key: string,
    disposableRecord: NamespaceBackendRecord,
    execution?: SearchExecutionOptions,
  ): Promise<NamespaceBackendRecord | null> {
    const pending = this.cache.get(key);
    if (!pending) return null;
    const cachedRecord = await awaitWithAbort(pending, execution?.signal).catch(() => null);
    if (!cachedRecord) return null;
    if (cachedRecord.collection !== disposableRecord.collection) return null;
    if (cachedRecord.memoryDir !== disposableRecord.memoryDir) return null;
    return cachedRecord;
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
      abortAsUnavailable: false,
      failOpenMissingGuardedCollection: true,
    }).catch((error) => {
      this.cache.delete(key);
      throw error;
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
      resolveNamespaceCapabilities(this.config).namespaces === true && useLegacyDefaultCollection;
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
    try {
      const availabilityProbe =
        options.autoCreateCollection || typeof backend.checkAvailability !== "function"
          ? backend.probe()
          : backend.checkAvailability({ signal: execution?.signal });
      const available = await awaitWithAbort(availabilityProbe, execution?.signal).catch((error) => {
        if (error instanceof NamespaceSearchAbortError && !options.abortAsUnavailable) {
          throw error;
        }
        return false;
      });
      const collectionState = available
        ? await awaitWithAbort(
          // The legacy default namespace at the flat root (`filtersNestedNamespaces`)
          // shares its `memoryDir` with the `namespaces/` container, so its base
          // collection is a "broad root" that also indexes nested-namespace files.
          // We STILL auto-create it (issue #1929): the search side already targets
          // this exact base collection and `filterNamespaceSubtreeResults` strips
          // the nested `namespaces/` subtree out of its results, so index and
          // search stay symmetric. Skipping creation left a configured default
          // namespace (e.g. `geek`) with maintenance "ran" but no collection and 0
          // recall results. `ensureCollection` is a no-op when the collection is
          // already present, so legacy installs that pre-created the broad root are
          // unaffected.
          this.collectionStateForBackend(backend, storage.dir, scopedConfig.qmdCollection, {
            autoCreate: options.autoCreateCollection,
            failOpenMissingGuardedCollection: options.failOpenMissingGuardedCollection,
            execution,
          }),
          execution?.signal,
        ).catch((error) => {
          if (error instanceof NamespaceSearchAbortError && !options.abortAsUnavailable) {
            throw error;
          }
          return "unknown" as const;
        })
        : "unknown";
      return {
        backend,
        collection: scopedConfig.qmdCollection,
        memoryDir: storage.dir,
        available,
        collectionState,
        filtersNestedNamespaces,
      };
    } catch (error) {
      const dispose = (backend as { dispose?: () => void | Promise<void> }).dispose;
      if (dispose) {
        await Promise.resolve(dispose.call(backend)).catch(() => {});
      }
      throw error;
    }
  }

  private async collectionStateForBackend(
    backend: SearchBackend,
    memoryDir: string,
    collection: string,
    options: {
      autoCreate: boolean;
      failOpenMissingGuardedCollection: boolean;
      execution?: SearchExecutionOptions;
    },
  ): Promise<CollectionState> {
    if (!options.autoCreate) {
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

class NamespaceSearchAbortError extends Error {
  constructor() {
    super("operation aborted");
  }
}

function awaitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new NamespaceSearchAbortError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new NamespaceSearchAbortError());
    };
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

async function updateBackendRecord(
  record: NamespaceBackendRecord,
  execution?: SearchExecutionOptions,
  options?: { strict?: boolean },
): Promise<void> {
  if (options?.strict === true) {
    if (
      record.backend.updatesAllCollections?.() === true &&
      typeof record.backend.updateStrict === "function"
    ) {
      await record.backend.updateStrict(execution);
      return;
    }
    if (typeof record.backend.updateCollectionStrict === "function") {
      await record.backend.updateCollectionStrict(record.collection, execution);
      return;
    }
  }
  await record.backend.update(execution);
}

async function embedBackendRecord(
  record: NamespaceBackendRecord,
  options?: { strict?: boolean },
): Promise<void> {
  if (options?.strict === true) {
    if (typeof record.backend.embedCollectionStrict === "function") {
      await record.backend.embedCollectionStrict(record.collection);
      return;
    }
    if (typeof record.backend.embedStrict === "function") {
      await record.backend.embedStrict();
      return;
    }
  }
  if (typeof record.backend.embedCollection === "function") {
    await record.backend.embedCollection(record.collection);
    return;
  }
  await record.backend.embed();
}

function daemonModeForBackend(backend: SearchBackend): boolean | null {
  return "isDaemonMode" in backend && typeof backend.isDaemonMode === "function"
    ? backend.isDaemonMode() === true
    : null;
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
export function normalizeQmdResultPath(resultPath: string, collection: string): string {
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

  // Only strip a genuine QMD collection prefix — never when the collection name
  // collides with a memory category dir (e.g. qmdCollection == "facts"), or a
  // bare "facts/<id>.md" hit would be corrupted to "<id>.md" and fail namespace
  // reads/access tracking (#2020).
  const collectionPrefix = `${collection}/`;
  if (value.startsWith(collectionPrefix) && !ALL_CATEGORY_DIRS.includes(collection)) {
    value = value.slice(collectionPrefix.length);
  }
  return value;
}
function resolveNamespaceResultPath(
  memoryDir: string,
  collection: string,
  resultPath: string,
): string {
  const normalized = normalizeQmdResultPath(resultPath, collection);
  if (path.isAbsolute(normalized)) return normalized;
  const root = path.resolve(memoryDir);
  const resolved = path.resolve(root, normalized);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return resultPath;
  }
  return resolved;
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
        merged.set(key, { ...result, namespace });
        continue;
      }
      if (result.score > existing.score) {
        merged.set(key, {
          ...result,
          namespace,
          snippet: existing.snippet || result.snippet || "",
        });
      }
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}
