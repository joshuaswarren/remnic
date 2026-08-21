import assert from "node:assert/strict";
import test from "node:test";
import { NamespaceSearchRouter, normalizeQmdResultPath } from "./search.js";
import type {
  SearchBackend,
  SearchBackendStatus,
  SearchExecutionOptions,
  SearchQueryOptions,
} from "../search/port.js";
import type { QmdCapabilities, QmdVersionStatus } from "../qmd.js";
import type { PluginConfig, QmdSearchResult } from "../types.js";

type CollectionState = "present" | "missing" | "unknown" | "skipped";

class FakeBackend implements SearchBackend {
  updates = 0;
  strictUpdates = 0;
  strictCollectionUpdates: string[] = [];
  embeds = 0;
  collectionEmbeds: string[] = [];
  strictEmbeds = 0;
  strictCollectionEmbeds: string[] = [];
  disposed = 0;
  available = true;
  calls: Array<{
    method: string;
    collection: string | undefined;
    maxResults: number | undefined;
  }> = [];
  availabilitySignals: Array<AbortSignal | undefined> = [];
  probeCalls = 0;
  ensureSignals: Array<AbortSignal | undefined> = [];
  ensureCollections: Array<string | undefined> = [];
  checkSignals: Array<AbortSignal | undefined> = [];
  checkCollections: Array<string | undefined> = [];

  constructor(
    private readonly globalUpdate: boolean,
    private readonly results: QmdSearchResult[] = [],
    private readonly collectionStates: {
      check?: CollectionState;
      ensure?: CollectionState;
    } = {},
    private readonly daemonMode = false,
    private readonly diagnostics: {
      debugStatus?: string;
      versionStatus?: QmdVersionStatus;
    } = {},
  ) {}

  private limitedResults(maxResults: number | undefined): QmdSearchResult[] {
    return typeof maxResults === "number"
      ? this.results.slice(0, maxResults)
      : this.results;
  }

  async probe(): Promise<boolean> {
    this.probeCalls += 1;
    return this.available;
  }

  async checkAvailability(execution?: SearchExecutionOptions): Promise<boolean> {
    this.availabilitySignals.push(execution?.signal);
    return this.available;
  }

  isAvailable(): boolean {
    return this.available;
  }

  debugStatus(): string {
    return this.diagnostics.debugStatus ?? "fake";
  }

  isDaemonMode(): boolean {
    return this.daemonMode;
  }

  getVersionStatus(): QmdVersionStatus | null {
    return this.diagnostics.versionStatus ?? null;
  }

  statusResult: SearchBackendStatus | null = null;

  async status(): Promise<SearchBackendStatus> {
    if (!this.statusResult) throw new Error("no status available");
    return this.statusResult;
  }

  async dispose(): Promise<void> {
    this.disposed += 1;
  }

  async search(
    _query: string,
    collection?: string,
    maxResults?: number,
    _options?: SearchQueryOptions,
    _execution?: SearchExecutionOptions,
  ): Promise<QmdSearchResult[]> {
    this.calls.push({ method: "search", collection, maxResults });
    return this.limitedResults(maxResults);
  }

  async searchGlobal(
    _query: string,
    maxResults?: number,
    _execution?: SearchExecutionOptions,
  ): Promise<QmdSearchResult[]> {
    return this.limitedResults(maxResults);
  }

  async bm25Search(
    _query: string,
    collection?: string,
    maxResults?: number,
    _execution?: SearchExecutionOptions,
  ): Promise<QmdSearchResult[]> {
    this.calls.push({ method: "bm25", collection, maxResults });
    return this.limitedResults(maxResults);
  }

  async vectorSearch(
    _query: string,
    collection?: string,
    maxResults?: number,
    _execution?: SearchExecutionOptions,
  ): Promise<QmdSearchResult[]> {
    this.calls.push({ method: "vector", collection, maxResults });
    return this.limitedResults(maxResults);
  }

  async hybridSearch(
    _query: string,
    collection?: string,
    maxResults?: number,
    _execution?: SearchExecutionOptions,
  ): Promise<QmdSearchResult[]> {
    this.calls.push({ method: "hybrid", collection, maxResults });
    return this.limitedResults(maxResults);
  }

  async update(): Promise<void> {
    this.updates += 1;
  }

  async updateStrict(): Promise<void> {
    this.strictUpdates += 1;
  }

  async updateCollection(): Promise<void> {}

  async updateCollectionStrict(collection: string): Promise<void> {
    this.strictCollectionUpdates.push(collection);
  }

  updatesAllCollections(): boolean {
    return this.globalUpdate;
  }

  async embed(): Promise<void> {
    this.embeds += 1;
  }

  async embedStrict(): Promise<void> {
    this.strictEmbeds += 1;
  }

  async embedCollection(collection: string): Promise<void> {
    this.collectionEmbeds.push(collection);
  }

  async embedCollectionStrict(collection: string): Promise<void> {
    this.strictCollectionEmbeds.push(collection);
  }

  async ensureCollection(
    _memoryDir?: string,
    collectionOrExecution?: string | { signal?: AbortSignal },
    execution?: { signal?: AbortSignal },
  ): Promise<CollectionState> {
    const collection = typeof collectionOrExecution === "string"
      ? collectionOrExecution
      : undefined;
    const effectiveExecution = typeof collectionOrExecution === "string"
      ? execution
      : collectionOrExecution ?? execution;
    this.ensureCollections.push(collection);
    this.ensureSignals.push(effectiveExecution?.signal);
    return this.collectionStates.ensure ?? "present";
  }

  async checkCollection(
    collectionOrExecution?: string | { signal?: AbortSignal },
    execution?: { signal?: AbortSignal },
  ): Promise<CollectionState> {
    const collection = typeof collectionOrExecution === "string"
      ? collectionOrExecution
      : undefined;
    const effectiveExecution = typeof collectionOrExecution === "string"
      ? execution
      : collectionOrExecution ?? execution;
    this.checkCollections.push(collection);
    this.checkSignals.push(effectiveExecution?.signal);
    return this.collectionStates.check ?? "present";
  }
}

function config(): PluginConfig {
  return {
    memoryDir: "/tmp/remnic",
    namespacesEnabled: true,
    qmdCollection: "openclaw-engram",
    defaultNamespace: "main",
    qmdMaxResults: 10,
    qmdEmbeddingBacklogThreshold: 5000,
  } as PluginConfig;
}

function qmdCapabilities(enabled: boolean): QmdCapabilities {
  return {
    version: enabled ? "2.5.3" : null,
    parsedVersion: enabled ? [2, 5, 3] : null,
    stableSdk: enabled,
    unifiedSearch: enabled,
    getDocumentBody: enabled,
    maintenanceApi: enabled,
    legacySkillInstall: enabled,
    intentHints: enabled,
    explainTraces: enabled,
    candidateLimit: enabled,
    v2McpQueryTool: enabled,
    structuredSearches: enabled,
    queryRerankToggle: enabled,
    chunkStrategy: enabled,
    qmdBench: enabled,
    perCollectionModels: enabled,
    jsonLineNumbers: enabled,
    editorLinks: enabled,
    doctor: enabled,
    versionedSkills: enabled,
    absoluteSnippetLines: enabled,
    fullQueryOutput: enabled,
    forceCpu: enabled,
    gpuBackendOverride: enabled,
    embedParallelism: enabled,
    modelEnvConsistency: enabled,
    scopedEmbed: enabled,
    safeStatusDeviceProbe: enabled,
    mcpIndexSelection: enabled,
    outputFormatFlag: enabled,
  };
}

test("updateNamespaces runs a global-update backend only once", async () => {
  const created: FakeBackend[] = [];
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      const backend = new FakeBackend(true);
      created.push(backend);
      return backend;
    },
  );

  const updated = await router.updateNamespaces(["main", "shared", "main", "project"]);

  assert.equal(updated, 1);
  assert.equal(created.reduce((sum, backend) => sum + backend.updates, 0), 1);
});

test("updateNamespaces still updates every namespace for scoped backends", async () => {
  const created: FakeBackend[] = [];
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      const backend = new FakeBackend(false);
      created.push(backend);
      return backend;
    },
  );

  const updated = await router.updateNamespaces(["main", "shared", "main", "project"]);

  assert.equal(updated, 3);
  assert.equal(created.reduce((sum, backend) => sum + backend.updates, 0), 3);
});

test("updateNamespaces uses strict global update when requested", async () => {
  const created: FakeBackend[] = [];
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      const backend = new FakeBackend(true);
      created.push(backend);
      return backend;
    },
  );

  const updated = await router.updateNamespaces(
    ["main", "shared", "main", "project"],
    undefined,
    { strict: true },
  );

  assert.equal(updated, 1);
  assert.equal(created.reduce((sum, backend) => sum + backend.strictUpdates, 0), 1);
  assert.equal(created.reduce((sum, backend) => sum + backend.updates, 0), 0);
});

test("updateNamespaces uses strict collection updates for scoped backends when requested", async () => {
  const created: FakeBackend[] = [];
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      const backend = new FakeBackend(false);
      created.push(backend);
      return backend;
    },
  );

  const updated = await router.updateNamespaces(
    ["main", "shared", "main", "project"],
    undefined,
    { strict: true },
  );

  assert.equal(updated, 3);
  assert.equal(created.reduce((sum, backend) => sum + backend.strictCollectionUpdates.length, 0), 3);
  assert.equal(created.reduce((sum, backend) => sum + backend.updates, 0), 0);
});

test("embedNamespaces uses strict collection embeds when requested", async () => {
  const created: FakeBackend[] = [];
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      const backend = new FakeBackend(false);
      created.push(backend);
      return backend;
    },
  );

  await router.embedNamespaces(["main", "shared", "main", "project"], { strict: true });

  assert.equal(created.reduce((sum, backend) => sum + backend.strictCollectionEmbeds.length, 0), 3);
  assert.equal(created.reduce((sum, backend) => sum + backend.collectionEmbeds.length, 0), 0);
  assert.equal(created.reduce((sum, backend) => sum + backend.embeds, 0), 0);
});

test("embedNamespaces propagates strict embed failures", async () => {
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      const backend = new FakeBackend(false);
      backend.embedCollectionStrict = async () => {
        throw new Error("embed failed");
      };
      return backend;
    },
  );

  await assert.rejects(
    () => router.embedNamespaces(["main"], { strict: true }),
    /embed failed/,
  );
});

test("updateNamespacesDetailed reports only eligible namespaces", async () => {
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    (scopedConfig) => {
      const backend = new FakeBackend(false, [], {
        ensure: scopedConfig.memoryDir.endsWith("/missing") ? "missing" : "present",
      });
      return backend;
    },
  );

  const result = await router.updateNamespacesDetailed(["main", "missing", "shared"]);

  assert.equal(result.backendCount, 2);
  assert.deepEqual(result.eligibleNamespaces.sort(), ["main", "shared"]);
});

test("searchAcrossNamespaces preserves same path results from distinct namespaces", async () => {
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    (scopedConfig) => {
      const namespace = scopedConfig.memoryDir.endsWith("/shared") ? "shared" : "main";
      return new FakeBackend(false, [
        {
          path: "facts/a.md",
          docid: "a",
          score: namespace === "main" ? 0.9 : 0.8,
          snippet: namespace,
        },
      ]);
    },
  );

  const results = await router.searchAcrossNamespaces({
    query: "a",
    namespaces: ["main", "shared"],
    maxResults: 10,
  });

  assert.deepEqual(results.map((result) => result.snippet), ["main", "shared"]);
  assert.deepEqual(results.map((result) => result.namespace), ["main", "shared"]);
  // Same-relative-path hits from distinct namespaces resolve to distinct
  // absolute paths (globally-unique identity); display surfaces relativize.
  assert.deepEqual(results.map((result) => result.path), [
    "/tmp/remnic/main/facts/a.md",
    "/tmp/remnic/shared/facts/a.md",
  ]);
});

test("searchAcrossNamespaces passes scoped collection to backend search methods", async () => {
  const created: FakeBackend[] = [];
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      const backend = new FakeBackend(false);
      created.push(backend);
      return backend;
    },
  );

  for (const mode of ["search", "hybrid", "bm25", "vector"] as const) {
    router.clearCache();
    created.length = 0;
    await router.searchAcrossNamespaces({
      query: "a",
      namespaces: ["main", "shared"],
      maxResults: 10,
      mode,
    });

    assert.deepEqual(
      created.flatMap((backend) => backend.calls.map((call) => call.collection)),
      [
        "openclaw-engram--ns-6d61696e",
        "openclaw-engram--ns-736861726564",
      ],
      mode,
    );
  }
});

test("ensureNamespaceCollection forwards abort signals to backend collection checks", async () => {
  const backend = new FakeBackend(false);
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => backend,
  );
  const controller = new AbortController();

  const state = await router.ensureNamespaceCollection("main", {
    signal: controller.signal,
  });

  assert.equal(state, "present");
  assert.deepEqual(backend.ensureSignals, [controller.signal]);
  assert.deepEqual(backend.ensureCollections, ["openclaw-engram--ns-6d61696e"]);
});

test("legacy default namespace root auto-creates its base collection (broad root, #1929)", async () => {
  const backend = new FakeBackend(false);
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async () => ({ dir: "/tmp/remnic" }) },
    () => backend,
  );
  const controller = new AbortController();

  const state = await router.ensureNamespaceCollection("main", {
    signal: controller.signal,
  });

  // The default namespace at the flat root targets the BASE collection (not a
  // tokenized name) on both index and search sides, and that collection is now
  // auto-created so recall has something to read. Skipping creation left a
  // configured default namespace with maintenance "ran" but 0 results (#1929).
  assert.equal(state, "present");
  assert.deepEqual(backend.ensureSignals, [controller.signal]);
  assert.deepEqual(backend.ensureCollections, ["openclaw-engram"]);
});

test("legacy default namespace root auto-creates a missing base collection (#1929)", async () => {
  const backend = new FakeBackend(false, [], { check: "missing", ensure: "present" });
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async () => ({ dir: "/tmp/remnic" }) },
    () => backend,
  );

  const state = await router.ensureNamespaceCollection("main");

  // A missing base collection is no longer left missing (the old fail-open path);
  // it is created so a fresh install with a flat-root default namespace gets a
  // working QMD collection instead of silently returning 0 results.
  assert.equal(state, "present");
  assert.deepEqual(backend.ensureCollections, ["openclaw-engram"]);
});

test("configured non-legacy default namespace still recalls from its flat-root base collection (#1929)", async () => {
  // Reporter's config: defaultNamespace "geek", data at the flat root. The
  // default record must search the SAME base collection the index side creates,
  // so recall returns results instead of 0.
  const geekConfig = { ...config(), defaultNamespace: "geek" } as PluginConfig;
  const created: FakeBackend[] = [];
  const router = new NamespaceSearchRouter(
    geekConfig,
    { storageFor: async () => ({ dir: "/tmp/remnic" }) },
    () => {
      const backend = new FakeBackend(false, [
        { docid: "1", path: "facts/geek-fact.md", snippet: "geek", score: 1 },
      ]);
      created.push(backend);
      return backend;
    },
  );

  const ensured = await router.ensureNamespaceCollection("geek");
  assert.equal(ensured, "present");
  assert.deepEqual(created[0]?.ensureCollections, ["openclaw-engram"]);

  const results = await router.searchAcrossNamespaces({
    query: "geek",
    namespaces: ["geek"],
    maxResults: 10,
  });

  assert.deepEqual(
    created.flatMap((backend) => backend.calls.map((call) => call.collection)),
    ["openclaw-engram"],
  );
  assert.equal(results.length, 1);
  assert.equal(results[0]?.snippet, "geek");
});

test("configured non-legacy default namespace filters nested namespace files from its base collection (#1929)", async () => {
  // The broad-root base collection also indexes nested `namespaces/` files; the
  // default namespace search must strip them so auto-creation does not leak
  // cross-namespace data into the default recall path.
  const geekConfig = { ...config(), defaultNamespace: "geek" } as PluginConfig;
  const backend = new FakeBackend(false, [
    { docid: "1", path: "facts/geek-fact.md", snippet: "geek", score: 2 },
    { docid: "2", path: "namespaces/ns-736861726564/facts/shared.md", snippet: "shared", score: 1 },
  ]);
  const router = new NamespaceSearchRouter(
    geekConfig,
    { storageFor: async () => ({ dir: "/tmp/remnic" }) },
    () => backend,
  );

  const results = await router.searchAcrossNamespaces({
    query: "geek",
    namespaces: ["geek"],
    maxResults: 10,
  });

  assert.deepEqual(results.map((result) => result.snippet), ["geek"]);
});

test("healthForNamespace checks namespace collection without auto-creating or caching state", async () => {
  const created: FakeBackend[] = [];
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      const backend = new FakeBackend(false, [], created.length === 0
        ? { check: "missing" }
        : { ensure: "present" });
      created.push(backend);
      return backend;
    },
  );

  const health = await router.healthForNamespace("shared");

  assert.equal(health.collectionState, "missing");
  assert.equal(health.collection, "openclaw-engram--ns-736861726564");
  assert.deepEqual(created[0]?.checkCollections, ["openclaw-engram--ns-736861726564"]);
  assert.deepEqual(created[0]?.ensureCollections, []);
  assert.equal(created[0]?.probeCalls, 0);
  assert.equal(created[0]?.availabilitySignals.length, 1);
  assert.equal(created[0]?.disposed, 1);

  const ensured = await router.ensureNamespaceCollection("shared");

  assert.equal(ensured, "present");
  assert.equal(created.length, 2);
  assert.deepEqual(created[1]?.ensureCollections, ["openclaw-engram--ns-736861726564"]);
});

test("healthForNamespace reports daemon mode from live cached namespace backend", async () => {
  const created: FakeBackend[] = [];
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      const backend = created.length === 0
        ? new FakeBackend(false, [
          {
            path: "facts/a.md",
            docid: "a",
            score: 1,
            snippet: "a",
          },
        ], { ensure: "present" }, true, {
          debugStatus: "live-daemon",
          versionStatus: {
            installedVersion: "qmd 2.5.3",
            supportedVersion: "2.5.3",
            supported: true,
            newerThanSupported: false,
            upgradeAvailable: false,
            capabilities: qmdCapabilities(true),
          },
        })
        : new FakeBackend(false, [], { check: "present" }, false, {
          debugStatus: "probe-unavailable",
          versionStatus: {
            installedVersion: null,
            supportedVersion: "2.5.3",
            supported: false,
            newerThanSupported: false,
            upgradeAvailable: false,
            capabilities: qmdCapabilities(false),
          },
        });
      if (created.length === 1) {
        backend.available = false;
      }
      created.push(backend);
      return backend;
    },
  );

  await router.searchAcrossNamespaces({
    query: "a",
    namespaces: ["shared"],
    maxResults: 1,
  });
  const health = await router.healthForNamespace("shared");

  assert.equal(health.available, true);
  assert.equal(health.daemonMode, true);
  assert.equal(health.debugStatus, "live-daemon");
  assert.equal(health.installedVersion, "qmd 2.5.3");
  assert.equal(health.supportedVersion, "2.5.3");
  assert.equal(health.supported, true);
  assert.equal(health.upgradeAvailable, false);
  assert.equal(health.doctorAvailable, true);
  assert.equal(health.collectionState, "unknown");
  assert.equal(created.length, 2);
  assert.equal(created[0]?.disposed, 0);
  assert.equal(created[1]?.disposed, 1);
  assert.deepEqual(created[1]?.checkCollections, []);
});

test("healthForNamespace reports embedding backlog from backend status", async () => {
  const created: FakeBackend[] = [];
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      const backend = new FakeBackend(false, [], { ensure: "present" }, false, {
        debugStatus: "backlog-test",
      });
      backend.statusResult = {
        pendingEmbeddings: 42,
        oldestPendingAgeMs: 120_000,
        totalFiles: 100,
        embeddedFiles: 58,
      };
      created.push(backend);
      return backend;
    },
  );

  const health = await router.healthForNamespace("shared");

  assert.equal(health.pendingEmbeddings, 42);
  assert.equal(health.oldestPendingAgeMs, 120_000);
  assert.equal(health.embeddingBacklogThreshold, 5000);
  assert.equal(created.length, 1);
  assert.equal(created[0]?.disposed, 1);
});

test("healthForNamespace returns null backlog when backend status fails", async () => {
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      const backend = new FakeBackend(false, [], { ensure: "present" });
      backend.statusResult = null;
      return backend;
    },
  );

  const health = await router.healthForNamespace("shared");

  assert.equal(health.pendingEmbeddings, null);
  assert.equal(health.oldestPendingAgeMs, null);
  assert.equal(health.embeddingBacklogThreshold, 5000);
});

test("healthForNamespace preserves cached missing collection state", async () => {
  const created: FakeBackend[] = [];
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      const backend = created.length === 0
        ? new FakeBackend(false, [], { ensure: "missing" }, true)
        : new FakeBackend(false, [], { check: "present" }, false);
      created.push(backend);
      return backend;
    },
  );

  assert.deepEqual(
    await router.searchAcrossNamespaces({
      query: "a",
      namespaces: ["shared"],
      maxResults: 1,
    }),
    [],
  );
  const health = await router.healthForNamespace("shared");

  assert.equal(health.available, true);
  assert.equal(health.daemonMode, true);
  assert.equal(health.collectionState, "missing");
  assert.equal(created.length, 2);
  assert.deepEqual(created[1]?.checkCollections, ["openclaw-engram--ns-736861726564"]);
});

test("healthForNamespace stops waiting when namespace availability probe aborts", async () => {
  const backend = new class extends FakeBackend {
    override async checkAvailability(execution?: SearchExecutionOptions): Promise<boolean> {
      this.availabilitySignals.push(execution?.signal);
      return await new Promise<boolean>(() => {});
    }
  }(false);
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => backend,
  );
  const controller = new AbortController();
  controller.abort();

  const health = await router.healthForNamespace("shared", {
    signal: controller.signal,
  });

  assert.equal(health.available, false);
  assert.equal(health.collectionState, "unknown");
  assert.equal(backend.probeCalls, 0);
  assert.equal(backend.availabilitySignals[0], controller.signal);
  assert.deepEqual(backend.checkCollections, []);
  assert.deepEqual(backend.ensureCollections, []);
  assert.equal(backend.disposed, 1);
});

test("ensureNamespaceCollection does not cache aborted namespace backend probes", async () => {
  const created: FakeBackend[] = [];
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      const backend = created.length === 0
        ? new class extends FakeBackend {
          override async probe(): Promise<boolean> {
            return await new Promise<boolean>(() => {});
          }
        }(false)
        : new FakeBackend(false, [], { ensure: "present" });
      created.push(backend);
      return backend;
    },
  );
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => router.ensureNamespaceCollection("shared", { signal: controller.signal }),
    /operation aborted/,
  );

  assert.equal(created[0]?.disposed, 1);
  assert.deepEqual(created[0]?.checkCollections, []);
  assert.deepEqual(created[0]?.ensureCollections, []);

  const ensured = await router.ensureNamespaceCollection("shared");

  assert.equal(ensured, "present");
  assert.equal(created.length, 2);
  assert.deepEqual(created[1]?.ensureCollections, ["openclaw-engram--ns-736861726564"]);
});

test("legacy default namespace root filters nested namespace search results", async () => {
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async () => ({ dir: "/tmp/remnic" }) },
    () => new FakeBackend(false, [
      {
        path: "/tmp/remnic/facts/main.md",
        docid: "main",
        score: 0.9,
        snippet: "main",
      },
      {
        path: "/tmp/remnic/namespaces/shared/facts/shared.md",
        docid: "shared",
        score: 0.95,
        snippet: "shared",
      },
      {
        path: "namespaces/project/facts/project.md",
        docid: "project",
        score: 0.8,
        snippet: "project",
      },
      {
        path: "qmd://openclaw-engram/facts/qmd-main.md",
        docid: "qmd-main",
        score: 0.85,
        snippet: "qmd-main",
      },
      {
        path: "qmd://openclaw-engram/namespaces/uri/facts/uri.md",
        docid: "uri",
        score: 0.99,
        snippet: "uri",
      },
      {
        path: "openclaw-engram/namespaces/prefix/facts/prefix.md",
        docid: "prefix",
        score: 0.98,
        snippet: "prefix",
      },
    ]),
  );

  const results = await router.searchAcrossNamespaces({
    query: "a",
    namespaces: ["main"],
    maxResults: 10,
  });

  assert.deepEqual(
    results.map((result) => result.docid),
    ["main", "qmd-main"],
  );
});

test("legacy default namespace root overfetches before filtering nested namespace results", async () => {
  const backend = new FakeBackend(false, [
    {
      path: "/tmp/remnic/namespaces/shared/facts/shared.md",
      docid: "shared",
      score: 0.99,
      snippet: "shared",
    },
    {
      path: "qmd://openclaw-engram/namespaces/project/facts/project.md",
      docid: "project",
      score: 0.98,
      snippet: "project",
    },
    {
      path: "/tmp/remnic/facts/main-a.md",
      docid: "main-a",
      score: 0.9,
      snippet: "main-a",
    },
    {
      path: "/tmp/remnic/facts/main-b.md",
      docid: "main-b",
      score: 0.8,
      snippet: "main-b",
    },
  ]);
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async () => ({ dir: "/tmp/remnic" }) },
    () => backend,
  );

  const results = await router.searchAcrossNamespaces({
    query: "a",
    namespaces: ["main"],
    maxResults: 2,
  });

  assert.equal(backend.calls[0]?.maxResults, 50);
  assert.deepEqual(
    results.map((result) => result.docid),
    ["main-a", "main-b"],
  );
});

test("normalizeQmdResultPath strips a real collection prefix but not a category dir (#2020)", () => {
  // Genuine QMD collection prefix (qmd:// URI) is stripped.
  assert.equal(
    normalizeQmdResultPath("qmd://openclaw-engram/facts/a.md", "openclaw-engram"),
    "facts/a.md",
  );
  // Plain relative hit is left untouched when its leading segment is a memory
  // category dir that happens to equal the collection name (qmdCollection ==
  // "facts"): stripping would corrupt "facts/a.md" -> "a.md" and break reads.
  assert.equal(normalizeQmdResultPath("facts/a.md", "facts"), "facts/a.md");
  // A non-category collection prefix on a plain hit is still stripped.
  assert.equal(normalizeQmdResultPath("openclaw-engram/facts/a.md", "openclaw-engram"), "facts/a.md");
});
