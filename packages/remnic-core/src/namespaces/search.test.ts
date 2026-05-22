import assert from "node:assert/strict";
import test from "node:test";
import { NamespaceSearchRouter } from "./search.js";
import type { SearchBackend } from "../search/port.js";
import type { PluginConfig, QmdSearchResult } from "../types.js";

class FakeBackend implements SearchBackend {
  updates = 0;
  calls: Array<{ method: string; collection: string | undefined }> = [];

  constructor(
    private readonly globalUpdate: boolean,
    private readonly results: QmdSearchResult[] = [],
  ) {}

  async probe(): Promise<boolean> {
    return true;
  }

  isAvailable(): boolean {
    return true;
  }

  debugStatus(): string {
    return "fake";
  }

  async search(_query?: string, collection?: string): Promise<QmdSearchResult[]> {
    this.calls.push({ method: "search", collection });
    return this.results;
  }

  async searchGlobal(): Promise<QmdSearchResult[]> {
    return [];
  }

  async bm25Search(_query?: string, collection?: string): Promise<QmdSearchResult[]> {
    this.calls.push({ method: "bm25", collection });
    return [];
  }

  async vectorSearch(_query?: string, collection?: string): Promise<QmdSearchResult[]> {
    this.calls.push({ method: "vector", collection });
    return [];
  }

  async hybridSearch(_query?: string, collection?: string): Promise<QmdSearchResult[]> {
    this.calls.push({ method: "hybrid", collection });
    return [];
  }

  async update(): Promise<void> {
    this.updates += 1;
  }

  async updateCollection(): Promise<void> {}

  updatesAllCollections(): boolean {
    return this.globalUpdate;
  }

  async embed(): Promise<void> {}

  async embedCollection(): Promise<void> {}

  async ensureCollection(): Promise<"present"> {
    return "present";
  }
}

function config(): PluginConfig {
  return {
    qmdCollection: "openclaw-engram",
    defaultNamespace: "main",
    qmdMaxResults: 10,
  } as PluginConfig;
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

  assert.deepEqual(
    results.map((result) => result.snippet),
    ["main", "shared"],
  );
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
