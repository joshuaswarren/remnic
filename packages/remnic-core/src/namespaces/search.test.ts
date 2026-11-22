import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { NamespaceSearchRouter, NAMESPACE_SEARCH_LEG_TIMEOUT_MS, normalizeQmdResultPath, isSearchHealthDegraded } from "./search.js";
import { MaintenanceScheduler } from "../orchestration/maintenance.js";
import type { NamespaceCatalog } from "./catalog.js";
import type {
  SearchBackend,
  SearchBackendStatus,
  OperationalSearchHealth,
  SearchDegradation,
  SearchExecutionOptions,
  SearchQueryOptions,
} from "../search/port.js";
import type { QmdCapabilities, QmdVersionStatus } from "../qmd.js";
import { parseQmdStatusOutput } from "../qmd-status.js";
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
  disposeWait: Promise<void> | null = null;
  available = true;
  calls: Array<{
    method: string;
    collection: string | undefined;
    maxResults: number | undefined;
  }> = [];
  availabilitySignals: Array<AbortSignal | undefined> = [];
  probeSignals: Array<AbortSignal | undefined> = [];
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

  async probe(execution?: SearchExecutionOptions): Promise<boolean> {
    this.probeCalls += 1;
    this.probeSignals.push(execution?.signal);
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
    await this.disposeWait;
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

class StalledBackend extends FakeBackend {
  override async search(): Promise<QmdSearchResult[]> {
    return new Promise<QmdSearchResult[]>(() => {});
  }
}

test("searchAcrossNamespaces degrades only the namespace whose leg never settles", async (t) => {
  const degradations: SearchDegradation[] = [];
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    (scopedConfig) =>
      scopedConfig.memoryDir.endsWith("/stuck")
        ? new StalledBackend(false)
        : new FakeBackend(false, [
            { path: "facts/a.md", docid: "a", score: 0.9, snippet: "main" },
          ]),
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const call = router.searchAcrossNamespaces({
    query: "a",
    namespaces: ["main", "stuck"],
    maxResults: 10,
    execution: { onDegradation: (degradation) => degradations.push(degradation) },
  });
  let outcome: "settled" | "rejected" | "stalled" | undefined;
  const guard = new Promise<"stalled">((resolve) => {
    setTimeout(() => resolve("stalled"), 60_000);
  });
  void Promise.race([
    call.then(() => "settled" as const, () => "rejected" as const),
    guard,
  ]).then((value) => {
    outcome = value;
  });
  await setImmediate();
  t.mock.timers.tick(NAMESPACE_SEARCH_LEG_TIMEOUT_MS);
  await setImmediate();
  if (outcome === undefined) {
    t.mock.timers.tick(60_000);
    await setImmediate();
  }
  assert.equal(outcome, "settled", "a stalled namespace leg must not hold the whole search");
  const results = await call;
  assert.deepEqual(results.map((result) => result.snippet), ["main"]);
  assert.equal(degradations.length, 1);
  assert.equal(degradations[0].backend, "qmd");
  assert.equal(degradations[0].code, "deadline_exceeded");
  assert.match(degradations[0].detail ?? "", /stuck/);
});

test("searchAcrossNamespaces still rejects when the caller aborts", async () => {
  const degradations: SearchDegradation[] = [];
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => new StalledBackend(false),
  );
  const caller = new AbortController();
  const call = router.searchAcrossNamespaces({
    query: "a",
    namespaces: ["main"],
    maxResults: 10,
    execution: {
      signal: caller.signal,
      onDegradation: (degradation) => degradations.push(degradation),
    },
  });
  caller.abort();
  await assert.rejects(call, { message: "operation aborted" });
  assert.equal(degradations.length, 0, "a caller abort is not a backend degradation");
});

test("searchAcrossNamespaces with an already aborted caller leaves no unhandled backend rejection", async () => {
  // The backend leg gets the aborted signal and rejects after the router has
  // already returned its own rejection. Nothing may be left holding that
  // second rejection: on the daemon it is an unhandled AbortError and the
  // process exits (jarvis-ml, 12 Nov 2026).
  class AbortingBackend extends FakeBackend {
    override async search(): Promise<QmdSearchResult[]> {
      await setImmediate();
      throw Object.assign(new Error("QMD inflight search aborted"), { name: "AbortError" });
    }
  }
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => new AbortingBackend(false),
  );
  let unhandled = 0;
  const onUnhandled = () => {
    unhandled += 1;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const caller = new AbortController();
    caller.abort();
    await assert.rejects(
      router.searchAcrossNamespaces({ query: "a", namespaces: ["main"], maxResults: 10, execution: { signal: caller.signal } }),
      { message: "operation aborted" },
    );
    for (let i = 0; i < 5; i += 1) await setImmediate();
    assert.equal(unhandled, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("searchAcrossNamespaces propagates backend errors instead of masking them", async () => {
  const degradations: SearchDegradation[] = [];
  class ThrowingBackend extends FakeBackend {
    override async search(): Promise<QmdSearchResult[]> {
      throw new Error("boom");
    }
  }
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => new ThrowingBackend(false),
  );
  const call = router.searchAcrossNamespaces({
    query: "a",
    namespaces: ["main"],
    maxResults: 10,
    execution: { onDegradation: (degradation) => degradations.push(degradation) },
  });
  await assert.rejects(call, { message: "boom" });
  assert.equal(degradations.length, 0, "a backend error is not a deadline");
});

test("searchAcrossNamespaces hands each leg its deadline signal", async (t) => {
  const signals = new Map<string, AbortSignal | undefined>();
  const degradations: SearchDegradation[] = [];
  class RecordingBackend extends FakeBackend {
    constructor(private readonly name: string) {
      super(false);
    }
    override async search(
      _query: string,
      _collection?: string,
      _maxResults?: number,
      _options?: SearchQueryOptions,
      execution?: SearchExecutionOptions,
    ): Promise<QmdSearchResult[]> {
      signals.set(this.name, execution?.signal);
      if (this.name === "stuck") return new Promise<QmdSearchResult[]>(() => {});
      return [{ path: "facts/a.md", docid: "a", score: 0.9, snippet: this.name }];
    }
  }
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    (scopedConfig) => new RecordingBackend(scopedConfig.memoryDir.endsWith("/stuck") ? "stuck" : "healthy"),
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const call = router.searchAcrossNamespaces({
    query: "a",
    namespaces: ["healthy", "stuck"],
    maxResults: 10,
    execution: { onDegradation: (degradation) => degradations.push(degradation) },
  });
  await setImmediate();
  t.mock.timers.tick(NAMESPACE_SEARCH_LEG_TIMEOUT_MS);
  await setImmediate();
  const results = await call;
  assert.deepEqual(results.map((result) => result.snippet), ["healthy"]);
  assert.equal(signals.get("stuck")?.aborted, true, "the stuck leg's backend must see its deadline abort");
  assert.equal(signals.get("healthy")?.aborted, false, "a finished leg's timer must be cleared");
  const deadlineCodes = degradations.filter((degradation) => degradation.code === "deadline_exceeded");
  assert.equal(deadlineCodes.length, 1);
  assert.match(deadlineCodes[0].detail ?? "", /stuck/);
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
  assert.deepEqual(backend.probeSignals, [controller.signal]);
  assert.deepEqual(backend.ensureSignals, [controller.signal]);
  assert.deepEqual(backend.ensureCollections, ["openclaw-engram--ns-6d61696e"]);
});

test("disableSearchBackends releases cached namespace backends without recreating search", async () => {
  const backend = new FakeBackend(false);
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => backend,
  );

  assert.equal(await router.ensureNamespaceCollection("main"), "present");
  await router.disableSearchBackends();

  await router.disableSearchBackends();

  assert.equal(backend.disposed, 1, "repeated runtime disable must not double-dispose the same backend");
  assert.equal(await router.backendForNamespace("main"), null);
  assert.equal(await router.ensureNamespaceCollection("main"), "missing");
  assert.equal(backend.probeCalls, 1, "disabled records must not recreate a concrete backend");
});

test("clearCache releases evicted namespace backend handles before recreation", async () => {
  const oldBackend = new FakeBackend(false);
  const newBackend = new FakeBackend(false);
  let releaseOldDispose: (() => void) | undefined;
  oldBackend.disposeWait = new Promise<void>((resolve) => { releaseOldDispose = resolve; });
  let createCalls = 0;
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      createCalls += 1;
      return createCalls === 1 ? oldBackend : newBackend;
    },
  );

  await router.ensureNamespaceCollection("main");
  router.clearCache();
  const recreation = router.ensureNamespaceCollection("main");
  await Promise.resolve();
  assert.equal(createCalls, 1, "recreation must wait for the evicted handle disposal barrier");
  releaseOldDispose?.();
  assert.equal(await recreation, "present");
  assert.equal(oldBackend.disposed, 1);
  assert.equal(createCalls, 2);
});

test("a spelling alias of the legacy default namespace auto-creates its base collection (#1929)", async () => {
  const backend = new FakeBackend(false);
  const router = new NamespaceSearchRouter(
    { ...config(), defaultNamespace: "cafe\u0301" },
    { storageFor: async () => ({ dir: "/tmp/remnic" }) },
    () => backend,
  );
  const controller = new AbortController();

  const state = await router.ensureNamespaceCollection("caf\u00e9", {
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

test("healthForNamespace reuses a completed result within the TTL without re-probing", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  try {
    const created: FakeBackend[] = [];
    const router = new NamespaceSearchRouter(
      config(),
      { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
      () => {
        const backend = new FakeBackend(false, [], { check: "present" }, false, {
          debugStatus: "cached-health",
        });
        backend.statusResult = {
          pendingEmbeddings: 3,
          oldestPendingAgeMs: 1_000,
          totalFiles: 10,
          embeddedFiles: 7,
        };
        created.push(backend);
        return backend;
      },
    );

    const first = await router.healthForNamespace("shared");
    const second = await router.healthForNamespace("shared");

    assert.equal(created.length, 1, "second call must not create another backend probe");
    assert.equal(created[0]?.availabilitySignals.length, 1);
    assert.deepEqual(created[0]?.checkCollections, ["openclaw-engram--ns-736861726564"]);
    assert.deepEqual(first, second);
    assert.equal(first.debugStatus, "cached-health");
    assert.equal(first.pendingEmbeddings, 3);

    first.available = false;
    first.debugStatus = "mutated";
    const third = await router.healthForNamespace("shared");
    assert.equal(third.available, true, "returned health objects must be copies");
    assert.equal(third.debugStatus, "cached-health");
    assert.equal(created.length, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test("healthForNamespace re-probes after the health result TTL elapses", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  try {
    const created: FakeBackend[] = [];
    const router = new NamespaceSearchRouter(
      config(),
      { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
      () => {
        const backend = new FakeBackend(false, [], { check: "present" });
        backend.statusResult = {
          pendingEmbeddings: created.length,
          oldestPendingAgeMs: 0,
          totalFiles: 1,
          embeddedFiles: 1,
        };
        created.push(backend);
        return backend;
      },
    );

    const first = await router.healthForNamespace("shared");
    assert.equal(created.length, 1);
    assert.equal(first.pendingEmbeddings, 0);

    t.mock.timers.tick(10_000);
    const second = await router.healthForNamespace("shared");

    assert.equal(created.length, 2, "TTL expiry must force a fresh backend probe");
    assert.equal(second.pendingEmbeddings, 1);
    assert.equal(created[0]?.disposed, 1);
    assert.equal(created[1]?.disposed, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test("healthForNamespace clearCache forces a re-probe before the TTL", async () => {
  const created: FakeBackend[] = [];
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      const backend = new FakeBackend(false, [], { check: "present" });
      backend.statusResult = {
        pendingEmbeddings: created.length + 1,
        oldestPendingAgeMs: 0,
        totalFiles: 1,
        embeddedFiles: 1,
      };
      created.push(backend);
      return backend;
    },
  );

  const first = await router.healthForNamespace("shared");
  assert.equal(created.length, 1);
  assert.equal(first.pendingEmbeddings, 1);

  router.clearCache();
  const second = await router.healthForNamespace("shared");

  assert.equal(created.length, 2, "clearCache must drop the health result cache");
  assert.equal(second.pendingEmbeddings, 2);
});

test("healthForNamespace does not cache a thrown probe", async () => {
  let attempts = 0;
  const created: FakeBackend[] = [];
  const router = new NamespaceSearchRouter(
    config(),
    {
      storageFor: async (namespace: string) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("storage unavailable");
        }
        return { dir: `/tmp/remnic/${namespace}` };
      },
    },
    () => {
      const backend = new FakeBackend(false, [], { check: "present" });
      backend.statusResult = {
        pendingEmbeddings: 9,
        oldestPendingAgeMs: 0,
        totalFiles: 1,
        embeddedFiles: 1,
      };
      created.push(backend);
      return backend;
    },
  );

  await assert.rejects(
    () => router.healthForNamespace("shared"),
    /storage unavailable/,
  );
  assert.equal(created.length, 0, "failed call must not create a backend");

  const health = await router.healthForNamespace("shared");
  assert.equal(health.pendingEmbeddings, 9);
  assert.equal(created.length, 1);

  const cached = await router.healthForNamespace("shared");
  assert.equal(created.length, 1, "only the successful result is cached");
  assert.deepEqual(cached, health);
});

test("healthForNamespace does not cache an unavailable answer", async () => {
  const created: FakeBackend[] = [];
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      const backend = new FakeBackend(false, [], { check: "present" });
      if (created.length === 0) {
        backend.available = false;
      }
      backend.statusResult = {
        pendingEmbeddings: created.length,
        oldestPendingAgeMs: 0,
        totalFiles: 1,
        embeddedFiles: 1,
      };
      created.push(backend);
      return backend;
    },
  );

  const first = await router.healthForNamespace("shared");
  assert.equal(first.available, false);
  assert.equal(created.length, 1);

  const second = await router.healthForNamespace("shared");
  assert.equal(second.available, true, "recovery must be visible on the next probe");
  assert.equal(created.length, 2, "unavailable answers must not be cached");
});

test("healthForNamespace does not cache a missing-collection answer", async () => {
  const created: FakeBackend[] = [];
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      const backend = new FakeBackend(
        false,
        [],
        created.length === 0 ? { check: "missing" } : { check: "present" },
      );
      backend.statusResult = {
        pendingEmbeddings: created.length,
        oldestPendingAgeMs: 0,
        totalFiles: 1,
        embeddedFiles: 1,
      };
      created.push(backend);
      return backend;
    },
  );

  const first = await router.healthForNamespace("shared");
  assert.equal(first.collectionState, "missing");
  assert.equal(created.length, 1);

  const second = await router.healthForNamespace("shared");
  assert.equal(second.collectionState, "present", "collection recovery must re-probe");
  assert.equal(created.length, 2, "missing-collection answers must not be cached");
});

function routerWithDegradedFirstProbe(
  created: FakeBackend[],
  firstCheck: CollectionState,
  degradeFirst: (backend: FakeBackend) => void,
): NamespaceSearchRouter {
  return new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      const isFirst = created.length === 0;
      const backend = new FakeBackend(false, [], { check: isFirst ? firstCheck : "present" });
      backend.statusResult = {
        pendingEmbeddings: 10,
        oldestPendingAgeMs: 0,
        totalFiles: 1,
        embeddedFiles: 1,
      };
      if (isFirst) degradeFirst(backend);
      created.push(backend);
      return backend;
    },
  );
}

test("healthForNamespace does not cache an unknown-collection answer", async () => {
  const created: FakeBackend[] = [];
  const router = routerWithDegradedFirstProbe(created, "unknown", () => {});

  const first = await router.healthForNamespace("shared");
  assert.equal(first.collectionState, "unknown");

  const second = await router.healthForNamespace("shared");
  assert.equal(second.collectionState, "present", "recovery must be visible on the next probe");
  assert.equal(created.length, 2, "unknown-collection answers must not be cached");
});

test("healthForNamespace does not cache an answer whose backend status failed", async () => {
  const created: FakeBackend[] = [];
  const router = routerWithDegradedFirstProbe(created, "present", (backend) => {
    backend.statusResult = null;
  });

  const first = await router.healthForNamespace("shared");
  assert.equal(first.pendingEmbeddings, null);
  assert.equal(first.collectionState, "unknown");
  assert.equal(isSearchHealthDegraded(first, first.embeddingBacklogThreshold), true);

  const second = await router.healthForNamespace("shared");
  assert.equal(second.pendingEmbeddings, 10, "backlog data must be visible on the next probe");
  assert.equal(created.length, 2, "answers without backlog data must not be cached");
});

test("healthForNamespace does not cache a backlog over the threshold", async () => {
  const created: FakeBackend[] = [];
  const router = routerWithDegradedFirstProbe(created, "present", (backend) => {
    backend.statusResult = {
      pendingEmbeddings: config().qmdEmbeddingBacklogThreshold + 1,
      oldestPendingAgeMs: 0,
      totalFiles: 1,
      embeddedFiles: 1,
    };
  });

  await router.healthForNamespace("shared");

  const second = await router.healthForNamespace("shared");
  assert.equal(second.pendingEmbeddings, 10, "a drained backlog must be visible on the next probe");
  assert.equal(created.length, 2, "over-threshold answers must not be cached");
});

test("healthForNamespace dispose drops the health result cache", async () => {
  const created: FakeBackend[] = [];
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      const backend = new FakeBackend(false, [], { check: "present" });
      backend.statusResult = {
        pendingEmbeddings: created.length + 1,
        oldestPendingAgeMs: 0,
        totalFiles: 1,
        embeddedFiles: 1,
      };
      created.push(backend);
      return backend;
    },
  );

  const first = await router.healthForNamespace("shared");
  assert.equal(created.length, 1);
  assert.equal(first.pendingEmbeddings, 1);

  await router.dispose();
  const second = await router.healthForNamespace("shared");

  assert.equal(created.length, 2, "dispose must drop the health result cache");
  assert.equal(second.pendingEmbeddings, 2);
});

test("healthForNamespace disableSearchBackends drops the health result cache", async () => {
  const created: FakeBackend[] = [];
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      const backend = new FakeBackend(false, [], { check: "present" });
      backend.statusResult = {
        pendingEmbeddings: created.length + 1,
        oldestPendingAgeMs: 0,
        totalFiles: 1,
        embeddedFiles: 1,
      };
      created.push(backend);
      return backend;
    },
  );

  const first = await router.healthForNamespace("shared");
  assert.equal(created.length, 1);
  assert.equal(first.pendingEmbeddings, 1);

  await router.disableSearchBackends();
  const second = await router.healthForNamespace("shared");

  assert.equal(created.length, 2, "disableSearchBackends must drop the health result cache");
  assert.equal(second.pendingEmbeddings, 2);
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

/**
 * Orama, LanceDB, Meilisearch and remote backends have no updateStrict or
 * updateCollectionStrict; their plain update() is fail-open. They report whether
 * an update ran through updateCompleted() (issue #3286).
 */
class NonQmdBackend extends FakeBackend {
  completedCalls = 0;

  constructor(completed: boolean) {
    super(false);
    // Instance properties shadow the QMD-only strict methods FakeBackend defines.
    Object.defineProperty(this, "updateStrict", { value: undefined });
    Object.defineProperty(this, "updateCollectionStrict", { value: undefined });
    Object.defineProperty(this, "updateCompleted", {
      value: async (): Promise<boolean> => {
        this.completedCalls += 1;
        return completed;
      },
    });
  }
}

function nonQmdRouter(completed: boolean, created: NonQmdBackend[], cfg: PluginConfig = config()): NamespaceSearchRouter {
  return new NamespaceSearchRouter(
    cfg,
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      const backend = new NonQmdBackend(completed);
      created.push(backend);
      return backend;
    },
  );
}

test("strict updateNamespaces fails for a non-QMD backend whose refresh did not complete", async () => {
  const created: NonQmdBackend[] = [];
  const router = nonQmdRouter(false, created);

  await assert.rejects(
    router.updateNamespaces(["main"], undefined, { strict: true }),
    /did not complete/,
  );
  assert.equal(created.reduce((sum, backend) => sum + backend.updates, 0), 0, "the fail-open update() is not what strict runs");
});

test("strict updateNamespaces succeeds for a non-QMD backend whose refresh completed", async () => {
  const created: NonQmdBackend[] = [];
  const router = nonQmdRouter(true, created);

  assert.equal(await router.updateNamespaces(["main", "shared"], undefined, { strict: true }), 2);
  assert.equal(created.reduce((sum, backend) => sum + backend.completedCalls, 0), 2);
  assert.equal(created.reduce((sum, backend) => sum + backend.updates, 0), 0);
});

test("non-strict updateNamespaces keeps the fail-open update() for non-QMD backends", async () => {
  const created: NonQmdBackend[] = [];
  const router = nonQmdRouter(false, created);

  assert.equal(await router.updateNamespaces(["main"]), 1);
  assert.equal(created.reduce((sum, backend) => sum + backend.updates, 0), 1);
  assert.equal(created.reduce((sum, backend) => sum + backend.completedCalls, 0), 0);
});

test("strict updateNamespaces falls back to update() for a backend with no strict or completed variant", async () => {
  const created: FakeBackend[] = [];
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      const backend = new FakeBackend(false);
      Object.defineProperty(backend, "updateCollectionStrict", { value: undefined });
      created.push(backend);
      return backend;
    },
  );

  assert.equal(await router.updateNamespaces(["main"], undefined, { strict: true }), 1);
  assert.equal(created.reduce((sum, backend) => sum + backend.updates, 0), 1);
});

test("namespace-mode maintenance is served only when a non-QMD backend's refresh completed", async () => {
  for (const completed of [true, false]) {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-3286-ns-completion-"));
    const cfg: PluginConfig = {
      ...config(),
      memoryDir,
      sharedNamespace: "shared",
      namespacePolicies: [],
      maintenanceNamespaceLockStaleMs: 100,
      qmdMaintenanceEnabled: true,
      qmdMaintenanceDebounceMs: 60_000,
      qmdAutoEmbedEnabled: false,
    };
    const created: NonQmdBackend[] = [];
    const router = nonQmdRouter(completed, created, cfg);
    const catalog: NamespaceCatalog = Object.assign(Object.create(null), {
      enabled: true,
      async listNamespaces() {
        return [{ namespace: "main" }];
      },
      async markMaintenance() {},
    });
    const qmd: SearchBackend = Object.assign(Object.create(null), { isAvailable: () => true });
    const scheduler = new MaintenanceScheduler({ config: cfg, getQmd: () => qmd, namespaceSearchRouter: router, namespaceCatalog: catalog });
    try {
      const served = scheduler.requestQmdMaintenanceCompletion();
      await scheduler.runQmdMaintenance();
      assert.equal(await served, completed, completed ? "a completed refresh serves the request" : "an incomplete refresh must keep the marker owed");
      assert.ok(created.some((backend) => backend.completedCalls > 0), "maintenance asked the backend whether it completed");
    } finally {
      await scheduler.dispose();
      await rm(memoryDir, { recursive: true, force: true });
    }
  }
});

const operationalSnapshot: OperationalSearchHealth = {
  collectionState: "present", pendingEmbeddings: 0, oldestPendingAgeMs: null,
  totalFiles: 0, embeddedFiles: null,
};

test("native removal invalidates CLI readiness across equivalent namespace spellings", async t => {
  let snapshot: OperationalSearchHealth | undefined;
  let created = 0;
  const composed = "caf\u00e9";
  const decomposed = "cafe\u0301";
  const live = new FakeBackend(false, [], { ensure: "present" }, true);
  live.statusResult = { ...operationalSnapshot };
  Object.assign(live, { readOperationalHealth: async () => snapshot });
  const missing = new FakeBackend(false, [], { check: "missing" });
  const present = new FakeBackend(false, [], { check: "present" });
  present.statusResult = operationalSnapshot;
  const router = new NamespaceSearchRouter(config(),
    { storageFor: async () => ({ dir: "/fixture/notes" }) },
    () => ++created === 1 ? live : created === 2 ? present : missing);
  t.after(() => router.dispose());
  await router.ensureNamespaceCollection(decomposed);
  assert.equal((await router.healthForNamespace(composed)).collectionState, "present");
  assert.equal(created, 2);
  assert.equal((await router.healthForNamespace(composed)).collectionState, "present");
  assert.equal(created, 2, "absent older capability must retain the guarded diagnostic TTL");
  snapshot = { ...operationalSnapshot, collectionState: "missing", pendingEmbeddings: null };
  assert.equal((await router.healthForNamespace(decomposed)).collectionState, "missing");
  assert.equal(created, 2);
  assert.equal(live.disposed, 0);
  snapshot = undefined; // Operational metadata became unavailable after the removal.
  assert.equal((await router.healthForNamespace(composed)).collectionState, "missing");
  assert.equal(created, 3, "the native removal must have invalidated the old CLI result");
});

test("an older CLI diagnostic cannot publish readiness after native removal", async t => {
  let snapshot: OperationalSearchHealth | undefined;
  let created = 0;
  const { promise: entered, resolve: statusEntered } = Promise.withResolvers<void>();
  const { promise: status, resolve: releaseStatus } = Promise.withResolvers<SearchBackendStatus>();
  t.after(() => releaseStatus(operationalSnapshot));
  const live = new FakeBackend(false, [], { ensure: "present" }, true);
  t.mock.method(live, "status", () => {
    statusEntered();
    return status;
  });
  Object.assign(live, { readOperationalHealth: async () => snapshot });
  const router = new NamespaceSearchRouter(config(),
    { storageFor: async () => ({ dir: "/fixture/notes" }) }, () => {
      created++;
      return created === 1 ? live
        : new FakeBackend(false, [], { check: created === 2 ? "present" : "missing" });
    });
  t.after(() => router.dispose());
  await router.ensureNamespaceCollection("shared");
  const older = router.healthForNamespace("shared");
  await entered;
  snapshot = { ...operationalSnapshot, collectionState: "missing", pendingEmbeddings: null };
  assert.equal((await router.healthForNamespace("shared")).collectionState, "missing");
  snapshot = undefined;
  releaseStatus(operationalSnapshot);
  const stale = await older;
  assert.equal((await router.healthForNamespace("shared")).collectionState, "missing");
  assert.equal(created, 3);
  assert.equal(stale.collectionState, "unknown");
  assert.equal(stale.pendingEmbeddings, null);
});

test("a cancelled poll does not invalidate another poll's CLI readiness", async t => {
  const { promise: entered, resolve: statusEntered } = Promise.withResolvers<void>();
  const { promise: status, resolve: releaseStatus } = Promise.withResolvers<SearchBackendStatus>();
  const { promise: storage, resolve: releaseStorage } = Promise.withResolvers<{ dir: string }>();
  const { promise: paused, resolve: storageEntered } = Promise.withResolvers<void>();
  const dir = "/fixture/notes";
  t.after(() => { releaseStatus(operationalSnapshot); releaseStorage({ dir }); });
  let pauseStorage = false;
  let created = 0;
  const live = new FakeBackend(false, [], { ensure: "present" }, true);
  t.mock.method(live, "status", () => { statusEntered(); return status; });
  Object.assign(live, { readOperationalHealth: async () => undefined });
  const router = new NamespaceSearchRouter(config(), {
    storageFor: async () => {
      if (pauseStorage) { storageEntered(); return storage; }
      return { dir };
    },
  }, () => ++created === 1 ? live : new FakeBackend(false, [], { check: "present" }));
  t.after(() => router.dispose());
  await router.ensureNamespaceCollection("shared");
  const older = router.healthForNamespace("shared");
  await entered;
  pauseStorage = true;
  const controller = new AbortController();
  const cancelled = router.healthForNamespace("shared", { signal: controller.signal });
  await paused;
  controller.abort();
  assert.equal((await cancelled).collectionState, "unknown");
  pauseStorage = false;
  releaseStorage({ dir });
  releaseStatus(operationalSnapshot);
  assert.equal((await older).collectionState, "present");
  assert.equal((await router.healthForNamespace("shared")).collectionState, "present");
  assert.equal(created, 2, "the successful diagnostic still uses the TTL");
});

test("health re-probes after a cached operational backend failed startup", async t => {
  let created = 0;
  const cold = new FakeBackend(false);
  cold.available = false;
  const router = new NamespaceSearchRouter(config(),
    { storageFor: async () => ({ dir: "/fixture/notes" }) }, () => {
      if (++created === 1) return cold;
      const diagnostic = new FakeBackend(false, [], { check: "present" });
      diagnostic.statusResult = operationalSnapshot;
      return diagnostic;
    });
  t.after(() => router.dispose());
  assert.equal(await router.ensureNamespaceCollection("shared"), "unknown");
  const recovered = await router.healthForNamespace("shared");
  assert.equal(recovered.available, true);
  assert.equal(recovered.collectionState, "present");
  assert.equal(recovered.pendingEmbeddings, 0);
  assert.equal(isSearchHealthDegraded(recovered, recovered.embeddingBacklogThreshold), false);
  assert.equal((await router.healthForNamespace("shared")).collectionState, "present");
  assert.equal(created, 2);
});

test("CLI-only health caches a recognized QMD report with no pending embeddings", async t => {
  let created = 0;
  const router = new NamespaceSearchRouter(config(),
    { storageFor: async () => ({ dir: "/fixture/notes" }) }, () => {
      created++;
      const backend = new FakeBackend(false, [], { check: "present" });
      backend.statusResult = parseQmdStatusOutput(
        "QMD Status\n\nIndex: /fixture/index.sqlite\nSize: 1 KB\n\nDocuments\n  Total: 1 files indexed\n  Vectors: 1 embedded\n",
      );
      return backend;
    });
  t.after(() => router.dispose());
  const health = await router.healthForNamespace("shared");
  assert.equal(health.collectionState, "present");
  assert.equal(health.pendingEmbeddings, 0);
  assert.equal(isSearchHealthDegraded(health, health.embeddingBacklogThreshold), false);
  assert.equal((await router.healthForNamespace("shared")).pendingEmbeddings, 0);
  assert.equal(created, 1);
});

test("operational snapshot is revalidated at the public return boundary", async t => {
  let valid = true;
  const live = new FakeBackend(false, [], { ensure: "present" }, true);
  Object.assign(live, {
    readOperationalHealth: async () => ({
      ...operationalSnapshot,
      isCurrent: () => {
        queueMicrotask(() => { valid = false; });
        return valid;
      },
    }),
  });
  const router = new NamespaceSearchRouter(config(),
    { storageFor: async () => ({ dir: "/fixture/notes" }) }, () => live);
  t.after(() => router.dispose());
  await router.ensureNamespaceCollection("shared");
  assert.equal((await router.healthForNamespace("shared")).collectionState, "unknown");
});

test("operational health preserves backlog and fresh removal instead of returning old readiness", async t => {
  let snapshot: OperationalSearchHealth = { ...operationalSnapshot, pendingEmbeddings: 50_000 };
  const live = new FakeBackend(false, [], { ensure: "present" }, true);
  Object.assign(live, { readOperationalHealth: async () => snapshot });
  const router = new NamespaceSearchRouter(config(),
    { storageFor: async () => ({ dir: "/fixture/notes" }) },
    () => live);
  t.after(() => router.dispose());
  await router.ensureNamespaceCollection("shared");
  const backlog = await router.healthForNamespace("shared");
  assert.equal(backlog.pendingEmbeddings, 50_000);
  assert.equal(isSearchHealthDegraded(backlog, backlog.embeddingBacklogThreshold), true);
  snapshot = { ...operationalSnapshot, collectionState: "missing" };
  assert.equal((await router.healthForNamespace("shared")).collectionState, "missing");
});

test("operational health does not heal a cached missing collection using a positive snapshot", async t => {
  let created = 0;
  let metadataReads = 0;
  const live = new FakeBackend(false, [], { ensure: "missing" }, true);
  Object.assign(live, { readOperationalHealth: async () => { metadataReads++; return operationalSnapshot; } });
  const router = new NamespaceSearchRouter(config(),
    { storageFor: async () => ({ dir: "/fixture/notes" }) },
    () => ++created === 1 ? live : new FakeBackend(false, [], { check: "present" }));
  t.after(() => router.dispose());
  await router.ensureNamespaceCollection("shared");
  assert.equal((await router.healthForNamespace("shared")).collectionState, "missing");
  assert.equal(metadataReads, 0);
});

test("operational health refuses a failed RPC without creating a disposable CLI diagnostic", async t => {
  let created = 0;
  const live = new FakeBackend(false, [], { ensure: "present" }, true);
  Object.assign(live, { readOperationalHealth: async () => { throw new Error("Synthetic RPC failure"); } });
  const router = new NamespaceSearchRouter(config(),
    { storageFor: async () => ({ dir: "/fixture/notes" }) },
    () => {
      assert.equal(++created, 1, "No second diagnostic backend after an advertised capability fails");
      return live;
    });
  t.after(() => router.dispose());
  await router.ensureNamespaceCollection("shared");
  assert.equal((await router.healthForNamespace("shared")).collectionState, "unknown");
});

test("operational health refuses a result after abort, namespace path drift, or record replacement", async t => {
  let directory = "/fixture/notes";
  let afterRead = () => {};
  const live = new FakeBackend(false, [], { ensure: "present" }, true);
  Object.assign(live, { readOperationalHealth: async () => { afterRead(); return operationalSnapshot; } });
  const router = new NamespaceSearchRouter(config(),
    { storageFor: async () => ({ dir: directory }) }, () => live);
  t.after(() => router.dispose());
  await router.ensureNamespaceCollection("shared");
  const controller = new AbortController();
  afterRead = () => controller.abort();
  assert.equal((await router.healthForNamespace("shared", { signal: controller.signal })).collectionState, "unknown");
  afterRead = () => { directory = "/fixture/changed"; };
  assert.equal((await router.healthForNamespace("shared")).collectionState, "unknown");
  directory = "/fixture/notes";
  afterRead = () => router.clearCache();
  assert.equal((await router.healthForNamespace("shared")).collectionState, "unknown");
});

test("operational record creation during a cached-health read cannot return old green", async t => {
  let created = 0;
  const cold = new FakeBackend(false, [], { check: "present" });
  cold.statusResult = { ...operationalSnapshot };
  const live = new FakeBackend(false, [], { ensure: "present" }, true);
  Object.assign(live, {
    readOperationalHealth: async () => ({
      ...operationalSnapshot, collectionState: "unknown", pendingEmbeddings: null,
    }),
  });
  const router = new NamespaceSearchRouter(config(),
    { storageFor: async () => ({ dir: "/fixture/notes" }) },
    () => ++created === 1 ? cold : live);
  t.after(() => router.dispose());
  assert.equal((await router.healthForNamespace("shared")).collectionState, "present");
  const preparing = router.ensureNamespaceCollection("shared");
  const reading = router.healthForNamespace("shared");
  await preparing;
  const health = await reading;
  assert.equal(health.collectionState, "unknown");
  assert.equal(isSearchHealthDegraded(health, health.embeddingBacklogThreshold), true);
});

test("cold health refuses status errors, unknown backlog and unsupported versions without caching green", async () => {
  const failures: Array<[string, (backend: FakeBackend) => void]> = [
    ["null status", backend => {
      Object.defineProperty(backend, "status", { value: async () => null });
    }],
    ["status error", backend => {
      backend.statusResult = Object.assign({
        pendingEmbeddings: 0, oldestPendingAgeMs: null, totalFiles: null, embeddedFiles: null,
      }, { error: "synthetic status failure" });
    }],
    ["unknown backlog", backend => {
      backend.statusResult = {
        pendingEmbeddings: null, oldestPendingAgeMs: null, totalFiles: 1, embeddedFiles: null,
      };
    }],
    ["unsupported version", backend => {
      Object.defineProperty(backend, "getVersionStatus", { value: () => ({
        installedVersion: "1.0.0", supportedVersion: "2.8.3", supported: false,
        newerThanSupported: false, upgradeAvailable: true, capabilities: qmdCapabilities(false),
      }) });
    }],
  ];
  for (const [name, fail] of failures) {
    const created: FakeBackend[] = [];
    const router = routerWithDegradedFirstProbe(created, "present", fail);
    try {
      const first = await router.healthForNamespace("shared");
      assert.equal(first.collectionState, "unknown", name);
      assert.equal(isSearchHealthDegraded(first, first.embeddingBacklogThreshold), true, name);
      const recovered = await router.healthForNamespace("shared");
      assert.equal(recovered.collectionState, "present", name);
      assert.equal(recovered.pendingEmbeddings, 10, name);
      assert.equal(created.length, 2, `${name} must not cache green`);
    } finally {
      await router.dispose();
    }
  }
});

test("a backend without a status capability retains legitimate readiness and its diagnostic TTL", async () => {
  let created = 0;
  const router = new NamespaceSearchRouter(config(),
    { storageFor: async () => ({ dir: "/fixture/notes" }) },
    () => {
      created++;
      const backend = new FakeBackend(false, [], { check: "present" });
      Object.defineProperty(backend, "status", { value: undefined });
      return backend;
    });
  try {
    const health = await router.healthForNamespace("shared");
    assert.equal(health.collectionState, "present");
    assert.equal(health.pendingEmbeddings, null);
    assert.equal(isSearchHealthDegraded(health, health.embeddingBacklogThreshold), false);
    assert.equal((await router.healthForNamespace("shared")).collectionState, "present");
    assert.equal(created, 1);
  } finally {
    await router.dispose();
  }
});
