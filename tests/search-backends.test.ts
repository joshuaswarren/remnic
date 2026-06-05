import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";

// Test factory routing and adapter construction — no live services needed.

describe("search backend factory", () => {
  it("routes 'noop' to NoopSearchBackend", async () => {
    const { createSearchBackend } = await import("../src/search/factory.js");
    const config = fakeConfig({ searchBackend: "noop" });
    const backend = createSearchBackend(config);
    assert.equal(backend.debugStatus(), "backend=noop");
    assert.equal(backend.isAvailable(), false);
  });

  it("routes 'remote' to RemoteSearchBackend", async () => {
    const { createSearchBackend } = await import("../src/search/factory.js");
    const config = fakeConfig({ searchBackend: "remote", remoteSearchBaseUrl: "http://localhost:9999" });
    const backend = createSearchBackend(config);
    assert.ok(backend.debugStatus().startsWith("backend=remote"));
  });

  it("routes 'orama' to OramaBackend", async () => {
    const { createSearchBackend } = await import("../src/search/factory.js");
    const config = fakeConfig({ searchBackend: "orama" });
    const backend = createSearchBackend(config);
    assert.ok(backend.debugStatus().startsWith("backend=orama"));
  });

  it("routes 'meilisearch' to MeilisearchBackend", async () => {
    const { createSearchBackend } = await import("../src/search/factory.js");
    const config = fakeConfig({ searchBackend: "meilisearch" });
    const backend = createSearchBackend(config);
    assert.ok(backend.debugStatus().startsWith("backend=meilisearch"));
  });

  it("routes 'lancedb' to LanceDbBackend", async () => {
    const { createSearchBackend } = await import("../src/search/factory.js");
    const config = fakeConfig({ searchBackend: "lancedb" });
    const backend = createSearchBackend(config);
    assert.ok(backend.debugStatus().startsWith("backend=lancedb"));
  });

  it("defaults to QMD when searchBackend is unset", async () => {
    const { createSearchBackend } = await import("../src/search/factory.js");
    const config = fakeConfig({ qmdEnabled: true });
    const backend = createSearchBackend(config);
    // QmdClient debug status contains "cli=" — that's its signature
    assert.ok(backend.debugStatus().includes("cli="));
  });

  it("falls back to noop when qmd is default but disabled", async () => {
    const { createSearchBackend } = await import("../src/search/factory.js");
    const config = fakeConfig({ qmdEnabled: false });
    const backend = createSearchBackend(config);
    assert.equal(backend.debugStatus(), "backend=noop");
  });

  it("QMD capability gating tolerates banner-prefixed semantic versions", async () => {
    const { QmdClient } = await import("../src/qmd.js");
    const client = new QmdClient("test-collection", 10);
    (client as any).cliVersion = "warning: experimental build\nqmd 1.1.5";
    (client as any).qmdCapabilities = (await import("../src/qmd.js")).resolveQmdCapabilities((client as any).cliVersion);
    assert.deepEqual(
      client.resolveSupportedSearchOptions({
        intent: "goal:review",
        explain: true,
      }),
      {
        intent: "goal:review",
        explain: true,
      },
    );
  });

  it("QMD probe prefers qmd-labelled version lines over banner versions", async () => {
    const { QmdClient } = await import("../src/qmd.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-version-"));
    const fakeQmdPath = path.join(tempDir, "qmd");
    await writeFile(
      fakeQmdPath,
      "#!/bin/sh\nprintf 'bun 1.2.0\\nqmd 1.1.1\\n'\n",
      "utf8",
    );
    await chmod(fakeQmdPath, 0o755);

    try {
      const client = new QmdClient("test-collection", 10, { qmdPath: fakeQmdPath });
      assert.equal(await client.probe(), true);
      assert.equal((client as any).cliVersion, "qmd 1.1.1");
      assert.deepEqual(
        client.resolveSupportedSearchOptions({
          intent: "goal:review",
          explain: true,
        }),
        undefined,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("QMD 2.x supported options include structured searches but keep MCP-unsupported chunking out of args", async () => {
    const { QmdClient, resolveQmdCapabilities } = await import("../src/qmd.js");
    const client = new QmdClient("test-collection", 10);
    (client as any).cliVersion = "qmd 2.5.3";
    (client as any).qmdCapabilities = resolveQmdCapabilities("qmd 2.5.3");
    assert.deepEqual(
      client.resolveSupportedSearchOptions({
        intent: "goal:review",
        explain: true,
        candidateLimit: 12,
        rerank: false,
        chunkStrategy: "auto",
        structuredSearches: [
          { type: "lex", query: "review" },
          { type: "vec", query: "review current work" },
          { type: "hyde", query: "A memory about reviewing the current work." },
        ],
      }),
      {
        intent: "goal:review",
        explain: true,
        candidateLimit: 12,
        rerank: false,
        chunkStrategy: "auto",
        structuredSearches: [
          { type: "lex", query: "review" },
          { type: "vec", query: "review current work" },
          { type: "hyde", query: "A memory about reviewing the current work." },
        ],
      },
    );
  });
});

describe("document scanner", () => {
  it("returns empty array for non-existent directory", async () => {
    const { scanMemoryDir } = await import("../src/search/document-scanner.js");
    const docs = await scanMemoryDir("/tmp/nonexistent-engram-test-dir-" + Date.now());
    assert.deepEqual(docs, []);
  });

  it("keeps scanning when optional category directories are missing", async () => {
    const { scanMemoryDir } = await import("../src/search/document-scanner.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-scan-missing-categories-"));
    try {
      const factsDir = path.join(tempDir, "facts");
      await mkdir(factsDir);
      await writeFile(
        path.join(factsDir, "kept.md"),
        "---\nid: kept-fact\n---\nA fact that should remain indexed.\n",
        "utf8",
      );

      const docs = await scanMemoryDir(tempDir);
      assert.equal(docs.length, 1);
      assert.equal(docs[0].docid, "kept-fact");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects category scan errors instead of treating them as empty input", async () => {
    const { scanMemoryDir } = await import("../src/search/document-scanner.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-scan-failure-"));
    try {
      await writeFile(path.join(tempDir, "facts"), "not a directory", "utf8");
      await assert.rejects(
        () => scanMemoryDir(tempDir),
        (err: unknown) => {
          assert.equal((err as NodeJS.ErrnoException).code, "ENOTDIR");
          return true;
        },
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("excludes symlinked markdown files from memory scans", async () => {
    const { scanMemoryDir } = await import("../src/search/document-scanner.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-scan-symlink-"));
    const externalDir = await mkdtemp(path.join(os.tmpdir(), "engram-scan-external-"));
    try {
      const factsDir = path.join(tempDir, "facts");
      await mkdir(factsDir);
      await writeFile(path.join(factsDir, "local.md"), "Local memory stays visible.", "utf8");

      const externalFile = path.join(externalDir, "leak.md");
      await writeFile(externalFile, "External memory must not be indexed.", "utf8");
      await symlink(externalFile, path.join(factsDir, "leak.md"));

      const docs = await scanMemoryDir(tempDir);
      assert.deepEqual(docs.map((doc) => doc.docid), ["local"]);
      assert.ok(docs.every((doc) => !doc.content.includes("External memory")));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      await rm(externalDir, { recursive: true, force: true });
    }
  });
});

describe("lancedb backend refresh", () => {
  it("refreshes with table overwrite without dropping the existing table", async () => {
    const { LanceDbBackend } = await import("../src/search/lancedb-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-lance-refresh-"));
    try {
      const factsDir = path.join(tempDir, "facts");
      await mkdir(factsDir);
      await writeFile(path.join(factsDir, "same.md"), "Updated content.", "utf8");

      const addCalls: Array<{ rows: any[]; options: any }> = [];
      let dropCalls = 0;
      let createCalls = 0;
      const table = {
        query: () => ({
          select: () => ({
            toArray: async () => [{ docid: "same", vector: [0.25, 0.75] }],
          }),
        }),
        add: async (rows: any[], options: any) => {
          addCalls.push({ rows, options });
        },
        createIndex: async () => {},
      };
      const backend = new LanceDbBackend({
        dbPath: path.join(tempDir, "db"),
        collection: "memories",
        embedHelper: fakeEmbedHelper(),
        memoryDir: tempDir,
        embeddingDimension: 2,
      });
      (backend as any).db = {
        dropTable: async () => {
          dropCalls++;
        },
        createTable: async () => {
          createCalls++;
          throw new Error("createTable should not be used for refresh");
        },
      };
      (backend as any).table = table;
      (backend as any).lanceModule = { Index: { fts: () => ({}) } };

      await backend.updateCollection("memories");

      assert.equal(dropCalls, 0);
      assert.equal(createCalls, 0);
      assert.equal(addCalls.length, 1);
      assert.equal(addCalls[0].options.mode, "overwrite");
      assert.deepEqual(addCalls[0].rows[0].vector, [0.25, 0.75]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("zero-fills malformed current-provider vectors during refresh", async () => {
    const { LanceDbBackend } = await import("../src/search/lancedb-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-lance-refresh-malformed-"));
    try {
      const factsDir = path.join(tempDir, "facts");
      await mkdir(factsDir);
      await writeFile(path.join(factsDir, "nan.md"), "Malformed vector row.", "utf8");
      await writeFile(path.join(factsDir, "placeholder.md"), "Placeholder vector row.", "utf8");

      const addCalls: Array<{ rows: any[]; options: any }> = [];
      const table = {
        query: () => ({
          select: () => ({
            toArray: async () => [
              {
                docid: "nan",
                vector: [Number.NaN, 1],
                vectorProvider: "host:openclaw-memory",
              },
              {
                docid: "placeholder",
                vector: [0, 0],
                vectorProvider: "host:openclaw-memory",
              },
            ],
          }),
        }),
        add: async (rows: any[], options: any) => {
          addCalls.push({ rows, options });
        },
        createIndex: async () => {},
      };
      const backend = new LanceDbBackend({
        dbPath: path.join(tempDir, "db"),
        collection: "memories",
        embedHelper: {
          ...fakeEmbedHelper(),
          getProviderIdentity: () => "host:openclaw-memory",
        },
        memoryDir: tempDir,
        embeddingDimension: 2,
      });
      (backend as any).table = table;
      (backend as any).lanceModule = { Index: { fts: () => ({}) } };

      await backend.updateCollection("memories");

      assert.equal(addCalls.length, 1);
      const rowsByDocid = new Map(addCalls[0].rows.map((row) => [row.docid, row]));
      assert.deepEqual(rowsByDocid.get("nan")?.vector, [0, 0]);
      assert.equal(rowsByDocid.get("nan")?.vectorProvider, "");
      assert.deepEqual(rowsByDocid.get("placeholder")?.vector, [0, 0]);
      assert.equal(rowsByDocid.get("placeholder")?.vectorProvider, "");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not drop the existing table when overwrite fails", async () => {
    const { LanceDbBackend } = await import("../src/search/lancedb-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-lance-overwrite-failure-"));
    try {
      const factsDir = path.join(tempDir, "facts");
      await mkdir(factsDir);
      await writeFile(path.join(factsDir, "same.md"), "Updated content.", "utf8");

      let dropCalls = 0;
      const table = {
        query: () => ({
          select: () => ({
            toArray: async () => [{ docid: "same", vector: [0.25, 0.75] }],
          }),
        }),
        add: async () => {
          throw new Error("overwrite failed");
        },
        createIndex: async () => {},
      };
      const backend = new LanceDbBackend({
        dbPath: path.join(tempDir, "db"),
        collection: "memories",
        embedHelper: fakeEmbedHelper(),
        memoryDir: tempDir,
        embeddingDimension: 2,
      });
      (backend as any).db = {
        dropTable: async () => {
          dropCalls++;
        },
      };
      (backend as any).table = table;
      (backend as any).lanceModule = { Index: { fts: () => ({}) } };

      await backend.updateCollection("memories");

      assert.equal(dropCalls, 0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("non-QMD backend cancellation", () => {
  it("OramaBackend honors already-aborted search and update signals before I/O", async () => {
    const { OramaBackend } = await import("../src/search/orama-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-orama-abort-"));
    try {
      const embedHelper = countingEmbedHelper();
      const backend = new OramaBackend({
        dbPath: path.join(tempDir, "db"),
        collection: "memories",
        embedHelper,
        memoryDir: path.join(tempDir, "missing-memory-dir"),
        embeddingDimension: 2,
      });
      (backend as any).available = true;

      const controller = new AbortController();
      controller.abort();

      assert.deepEqual(
        await backend.search("abort", "memories", 5, undefined, {
          signal: controller.signal,
        }),
        [],
      );
      await backend.updateCollection("memories", { signal: controller.signal });
      assert.equal(embedHelper.embedCalls, 0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("LanceDbBackend honors already-aborted search and update signals before I/O", async () => {
    const { LanceDbBackend } = await import("../src/search/lancedb-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-lance-abort-"));
    try {
      const embedHelper = countingEmbedHelper();
      const backend = new LanceDbBackend({
        dbPath: path.join(tempDir, "db"),
        collection: "memories",
        embedHelper,
        memoryDir: path.join(tempDir, "missing-memory-dir"),
        embeddingDimension: 2,
      });
      (backend as any).available = true;

      const controller = new AbortController();
      controller.abort();

      assert.deepEqual(
        await backend.search("abort", "memories", 5, undefined, {
          signal: controller.signal,
        }),
        [],
      );
      await backend.updateCollection("memories", { signal: controller.signal });
      assert.equal(embedHelper.embedCalls, 0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("MeilisearchBackend honors already-aborted search and update signals before SDK calls", async () => {
    const { MeilisearchBackend } = await import("../src/search/meilisearch-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-meili-abort-"));
    try {
      const backend = new MeilisearchBackend({
        host: "http://localhost:7700",
        collection: "memories",
        autoIndex: true,
        memoryDir: path.join(tempDir, "missing-memory-dir"),
      });
      (backend as any).available = true;
      let clientCalls = 0;
      (backend as any).ensureClient = async () => {
        clientCalls++;
        throw new Error("ensureClient must not run after abort");
      };

      const controller = new AbortController();
      controller.abort();

      assert.deepEqual(
        await backend.search("abort", "memories", 5, undefined, {
          signal: controller.signal,
        }),
        [],
      );
      await backend.updateCollection("memories", { signal: controller.signal });
      assert.equal(clientCalls, 0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("MeilisearchBackend ensures the requested collection before auto-indexing it", async () => {
    const { MeilisearchBackend } = await import("../src/search/meilisearch-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-meili-target-collection-"));
    try {
      await mkdir(path.join(tempDir, "facts"), { recursive: true });
      await writeFile(path.join(tempDir, "facts", "other.md"), "Other collection memory.", "utf8");

      const existingIndexes = new Set(["default"]);
      const getIndexCalls: string[] = [];
      const createIndexCalls: Array<{ uid: string; options: Record<string, unknown> }> = [];
      const indexCalls: string[] = [];
      const addCalls: Array<{ collection: string; docs: unknown[] }> = [];
      const waitForTaskCalls: Array<{ taskUid: number; knownIndexes: string[] }> = [];
      const client = {
        getIndex: async (uid: string) => {
          getIndexCalls.push(uid);
          if (!existingIndexes.has(uid)) throw new Error("index not found");
          return { uid };
        },
        createIndex: async (uid: string, options: Record<string, unknown>) => {
          createIndexCalls.push({ uid, options });
          existingIndexes.add(uid);
          return { taskUid: 1 };
        },
        index: (uid: string) => {
          indexCalls.push(uid);
          return {
            addDocuments: async (docs: unknown[]) => {
              addCalls.push({ collection: uid, docs });
              return { taskUid: 2 };
            },
            getDocuments: async () => ({ results: [] }),
            deleteDocuments: async () => ({ taskUid: 3 }),
          };
        },
        waitForTask: async (taskUid: number) => {
          waitForTaskCalls.push({
            taskUid,
            knownIndexes: Array.from(existingIndexes).sort(),
          });
        },
      };
      const backend = new MeilisearchBackend({
        host: "http://localhost:7700",
        collection: "default",
        autoIndex: true,
        memoryDir: tempDir,
      });
      (backend as any).available = true;
      (backend as any).client = client;

      await backend.updateCollection("other");

      assert.deepEqual(getIndexCalls, ["other"]);
      assert.deepEqual(createIndexCalls, [{ uid: "other", options: { primaryKey: "id" } }]);
      assert.deepEqual(indexCalls, ["other"]);
      assert.deepEqual(waitForTaskCalls, [
        { taskUid: 1, knownIndexes: ["default", "other"] },
        { taskUid: 2, knownIndexes: ["default", "other"] },
      ]);
      assert.equal(addCalls.length, 1);
      assert.equal(addCalls[0]?.collection, "other");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("MeilisearchBackend still auto-indexes when collection status check is unavailable", async () => {
    const { MeilisearchBackend } = await import("../src/search/meilisearch-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-meili-transient-collection-check-"));
    try {
      await mkdir(path.join(tempDir, "facts"), { recursive: true });
      await writeFile(path.join(tempDir, "facts", "kept.md"), "Index this despite a transient status check failure.", "utf8");

      const createIndexCalls: string[] = [];
      const indexCalls: string[] = [];
      const addCalls: Array<{ collection: string; docs: unknown[] }> = [];
      const client = {
        getIndex: async () => {
          throw new Error("getIndex upstream timeout");
        },
        createIndex: async (uid: string) => {
          createIndexCalls.push(uid);
          throw new Error("createIndex should only run when getIndex reports a missing index");
        },
        index: (uid: string) => {
          indexCalls.push(uid);
          return {
            addDocuments: async (docs: unknown[]) => {
              addCalls.push({ collection: uid, docs });
              return { taskUid: 4 };
            },
            getDocuments: async () => ({ results: [] }),
            deleteDocuments: async () => ({ taskUid: 5 }),
          };
        },
        waitForTask: async () => {},
      };
      const backend = new MeilisearchBackend({
        host: "http://localhost:7700",
        collection: "default",
        autoIndex: true,
        memoryDir: tempDir,
      });
      (backend as any).available = true;
      (backend as any).client = client;

      await backend.updateCollection("other");

      assert.deepEqual(createIndexCalls, []);
      assert.deepEqual(indexCalls, ["other"]);
      assert.equal(addCalls.length, 1);
      assert.equal(addCalls[0]?.collection, "other");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("MeilisearchBackend preserves legacy ensureCollection execution-argument calls", async () => {
    const { MeilisearchBackend } = await import("../src/search/meilisearch-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-meili-ensure-legacy-"));
    try {
      const getIndexCalls: unknown[] = [];
      const client = {
        getIndex: async (uid: unknown) => {
          getIndexCalls.push(uid);
          return { uid };
        },
      };
      const backend = new MeilisearchBackend({
        host: "http://localhost:7700",
        collection: "default",
        autoIndex: true,
        memoryDir: tempDir,
      });
      (backend as any).available = true;
      (backend as any).client = client;
      const controller = new AbortController();

      assert.equal(await backend.ensureCollection(tempDir, { signal: controller.signal }), "present");

      assert.deepEqual(getIndexCalls, ["default"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("embed helper", () => {
  it("returns not available when embedding is disabled", async () => {
    const { EmbedHelper } = await import("../src/search/embed-helper.js");
    const helper = new EmbedHelper(fakeConfig({ embeddingFallbackEnabled: false }) as any);
    assert.equal(helper.isAvailable(), false);
  });

  it("returns null vectors when not available", async () => {
    const { EmbedHelper } = await import("../src/search/embed-helper.js");
    const helper = new EmbedHelper(fakeConfig({ embeddingFallbackEnabled: false }) as any);
    const result = await helper.embed("test");
    assert.equal(result, null);
  });

  it("falls back when a scoped host provider cannot embed", async () => {
    const { EmbedHelper } = await import("../src/search/embed-helper.js");
    const {
      clearHostEmbeddingProvidersForTest,
      registerHostEmbeddingProvider,
    } = await import("../src/host-embedding-provider.js");
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-embed-helper-host-"));
    const originalFetch = globalThis.fetch;
    const unregister = registerHostEmbeddingProvider(memoryDir, {
      id: "host-test",
      async embed() {
        return null as unknown as number[];
      },
    });
    try {
      let fetchCalls = 0;
      globalThis.fetch = (async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ data: [{ embedding: [0.3, 0.4] }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;
      const helper = new EmbedHelper(fakeConfig({
        embeddingFallbackEnabled: true,
        embeddingFallbackProvider: "openai",
        openaiApiKey: "test-key",
        memoryDir,
      }) as any);

      const result = await helper.embed("test");
      assert.deepEqual(result, [0.3, 0.4]);
      assert.equal(fetchCalls, 1);
    } finally {
      globalThis.fetch = originalFetch;
      unregister();
      clearHostEmbeddingProvidersForTest();
    }
  });

  it("closes a replaced host embedding provider for the same scope", async () => {
    const {
      clearHostEmbeddingProvidersForTest,
      getHostEmbeddingProvider,
      registerHostEmbeddingProvider,
    } = await import("../src/host-embedding-provider.js");
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-embed-helper-host-replace-"));
    const closes: string[] = [];
    const unregisterFirst = registerHostEmbeddingProvider(memoryDir, {
      id: "first-host",
      async embed() {
        return [1, 0];
      },
      close() {
        closes.push("first");
      },
    });
    const unregisterSecond = registerHostEmbeddingProvider(memoryDir, {
      id: "second-host",
      async embed() {
        return [0, 1];
      },
      close() {
        closes.push("second");
      },
    });
    try {
      assert.equal(getHostEmbeddingProvider(memoryDir)?.id, "second-host");
      assert.deepEqual(closes, ["first"]);
      unregisterFirst();
      assert.deepEqual(closes, ["first"]);
      assert.equal(getHostEmbeddingProvider(memoryDir)?.id, "second-host");
      unregisterSecond();
      assert.deepEqual(closes, ["first", "second"]);
      assert.equal(getHostEmbeddingProvider(memoryDir), undefined);
    } finally {
      clearHostEmbeddingProvidersForTest();
      await rm(memoryDir, { recursive: true, force: true });
    }
  });

  it("passes query input type for search embeddings and document input type for batches", async () => {
    const { EmbedHelper } = await import("../src/search/embed-helper.js");
    const {
      clearHostEmbeddingProvidersForTest,
      registerHostEmbeddingProvider,
    } = await import("../src/host-embedding-provider.js");
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-embed-helper-input-type-"));
    const calls: string[] = [];
    const unregister = registerHostEmbeddingProvider(memoryDir, {
      id: "host-test",
      async embed(_text, options) {
        calls.push(options?.inputType ?? "missing");
        return [0.5, 0.6];
      },
      async embedBatch(texts, options) {
        calls.push(options?.inputType ?? "missing");
        return texts.map(() => [0.7, 0.8]);
      },
    });
    try {
      const helper = new EmbedHelper(fakeConfig({
        embeddingFallbackEnabled: true,
        memoryDir,
      }) as any);

      assert.deepEqual(await helper.embed("search query"), [0.5, 0.6]);
      assert.deepEqual(await helper.embedBatch(["doc one", "doc two"]), [
        [0.7, 0.8],
        [0.7, 0.8],
      ]);
      assert.deepEqual(calls, ["query", "document"]);
    } finally {
      unregister();
      clearHostEmbeddingProvidersForTest();
    }
  });

  it("picks up host embedding providers registered after construction", async () => {
    const { EmbedHelper } = await import("../src/search/embed-helper.js");
    const {
      clearHostEmbeddingProvidersForTest,
      registerHostEmbeddingProvider,
    } = await import("../src/host-embedding-provider.js");
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-embed-helper-late-host-"));
    const originalFetch = globalThis.fetch;
    let fallbackCalls = 0;
    let hostCalls = 0;
    let unregister: (() => void) | undefined;
    try {
      globalThis.fetch = (async () => {
        fallbackCalls += 1;
        return new Response(JSON.stringify({ data: [{ embedding: [0, 1] }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;
      const helper = new EmbedHelper(fakeConfig({
        embeddingFallbackEnabled: true,
        embeddingFallbackProvider: "openai",
        openaiApiKey: "test-key",
        memoryDir,
      }) as any);

      assert.deepEqual(await helper.embed("before host registration"), [0, 1]);
      assert.equal(helper.getProviderIdentity(), "openai:text-embedding-3-small");

      unregister = registerHostEmbeddingProvider(memoryDir, {
        id: "host-test",
        async embed() {
          hostCalls += 1;
          return [1, 0];
        },
      });

      (helper as any).cachedProviderAt = 0;
      assert.deepEqual(await helper.embed("after host registration"), [1, 0]);
      assert.equal(helper.getProviderIdentity(), "host:host-test");
      assert.equal(fallbackCalls, 1);
      assert.equal(hostCalls, 1);
    } finally {
      globalThis.fetch = originalFetch;
      unregister?.();
      clearHostEmbeddingProvidersForTest();
    }
  });

  it("rejects malformed HTTP embedding vectors instead of coercing components", async () => {
    const { EmbedHelper } = await import("../src/search/embed-helper.js");
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ data: [{ embedding: [0.1, null] }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch;
      const helper = new EmbedHelper(fakeConfig({
        embeddingFallbackEnabled: true,
        embeddingFallbackProvider: "openai",
        openaiApiKey: "test-key",
      }) as any);

      assert.equal(await helper.embed("bad vector"), null);
      assert.equal(await helper.embedWithProvider("bad vector"), null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses the root host embedding scope for namespace-scoped memory dirs", async () => {
    const { EmbedHelper } = await import("../src/search/embed-helper.js");
    const {
      clearHostEmbeddingProvidersForTest,
      registerHostEmbeddingProvider,
    } = await import("../src/host-embedding-provider.js");
    const rootMemoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-embed-helper-root-host-"));
    const namespaceMemoryDir = path.join(rootMemoryDir, "namespaces", "shared");
    let hostCalls = 0;
    const unregister = registerHostEmbeddingProvider(rootMemoryDir, {
      id: "host-test",
      async embed() {
        hostCalls += 1;
        return [0.2, 0.8];
      },
    });
    try {
      const helper = new EmbedHelper(fakeConfig({
        embeddingFallbackEnabled: true,
        memoryDir: namespaceMemoryDir,
        hostEmbeddingProviderScope: rootMemoryDir,
      }) as any);

      assert.deepEqual(await helper.embed("namespaced query"), [0.2, 0.8]);
      assert.equal(helper.getProviderIdentity(), "host:host-test");
      assert.equal(hostCalls, 1);
    } finally {
      unregister();
      clearHostEmbeddingProvidersForTest();
      await rm(rootMemoryDir, { recursive: true, force: true });
    }
  });

  it("falls back a whole host batch instead of mixing vector spaces", async () => {
    const { EmbedHelper } = await import("../src/search/embed-helper.js");
    const {
      clearHostEmbeddingProvidersForTest,
      registerHostEmbeddingProvider,
    } = await import("../src/host-embedding-provider.js");
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-embed-helper-batch-fallback-"));
    const originalFetch = globalThis.fetch;
    const hostCalls: string[] = [];
    const fallbackInputs: string[] = [];
    let hostAvailable = false;
    const unregister = registerHostEmbeddingProvider(memoryDir, {
      id: "host-test",
      async embed() {
        return null;
      },
      async embedBatch(texts) {
        hostCalls.push(...texts);
        return hostAvailable ? texts.map(() => [1, 0]) : [[1, 0], null];
      },
    });
    try {
      globalThis.fetch = (async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
        fallbackInputs.push(body.input ?? "");
        return new Response(JSON.stringify({ data: [{ embedding: [0, 1] }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;
      const helper = new EmbedHelper(fakeConfig({
        embeddingFallbackEnabled: true,
        embeddingFallbackProvider: "openai",
        openaiApiKey: "test-key",
        memoryDir,
      }) as any);

      assert.equal(helper.getProviderIdentity(), "host:host-test");
      assert.deepEqual(await helper.embedBatch(["doc one", "doc two"]), [
        [0, 1],
        [0, 1],
      ]);
      assert.equal(helper.getProviderIdentity(), "host:host-test");

      hostAvailable = true;
      assert.deepEqual(await helper.embedBatch(["doc three"]), [[1, 0]]);
      assert.equal(helper.getProviderIdentity(), "host:host-test");

      assert.deepEqual(hostCalls, ["doc one", "doc two", "doc three"]);
      assert.deepEqual(fallbackInputs, ["doc one", "doc two"]);
    } finally {
      globalThis.fetch = originalFetch;
      unregister();
      clearHostEmbeddingProvidersForTest();
    }
  });

  it("falls back the whole host batch when host vectors have the wrong dimension", async () => {
    const { EmbedHelper } = await import("../src/search/embed-helper.js");
    const {
      clearHostEmbeddingProvidersForTest,
      registerHostEmbeddingProvider,
    } = await import("../src/host-embedding-provider.js");
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-embed-helper-host-dimension-"));
    const originalFetch = globalThis.fetch;
    const hostInputs: string[] = [];
    const fallbackInputs: string[] = [];
    const unregister = registerHostEmbeddingProvider(memoryDir, {
      id: "host-test",
      dimensions: 3,
      async embed() {
        return [1, 0, 0];
      },
      async embedBatch(texts) {
        hostInputs.push(...texts);
        return texts.map(() => [1, 0, 0]);
      },
    });
    try {
      globalThis.fetch = (async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
        fallbackInputs.push(body.input ?? "");
        return new Response(JSON.stringify({ data: [{ embedding: [0, 1] }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;
      const helper = new EmbedHelper(fakeConfig({
        embeddingFallbackEnabled: true,
        embeddingFallbackProvider: "openai",
        openaiApiKey: "test-key",
        memoryDir,
      }) as any, { hostEmbeddingExpectedDimension: 2 });

      const result = await helper.embedBatchWithProvider(["doc one", "doc two"]);
      assert.deepEqual(result?.vectors, [
        [0, 1],
        [0, 1],
      ]);
      assert.equal(result?.providerIdentity, "openai:text-embedding-3-small");
      assert.deepEqual(hostInputs, ["doc one", "doc two"]);
      assert.deepEqual(fallbackInputs, ["doc one", "doc two"]);
    } finally {
      globalThis.fetch = originalFetch;
      unregister();
      clearHostEmbeddingProvidersForTest();
      await rm(memoryDir, { recursive: true, force: true });
    }
  });

  it("falls back the whole host call when a later batch fails", async () => {
    const { EmbedHelper } = await import("../src/search/embed-helper.js");
    const {
      clearHostEmbeddingProvidersForTest,
      registerHostEmbeddingProvider,
    } = await import("../src/host-embedding-provider.js");
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-embed-helper-cross-batch-"));
    const originalFetch = globalThis.fetch;
    const hostInputs: string[] = [];
    const fallbackInputs: string[] = [];
    const unregister = registerHostEmbeddingProvider(memoryDir, {
      id: "host-test",
      async embed() {
        return null;
      },
      async embedBatch(texts) {
        hostInputs.push(...texts);
        return texts.map((text) => (text === "doc four" ? null : [1, 0]));
      },
    });
    try {
      globalThis.fetch = (async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
        fallbackInputs.push(body.input ?? "");
        return new Response(JSON.stringify({ data: [{ embedding: [0, 1] }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;
      const helper = new EmbedHelper(fakeConfig({
        embeddingFallbackEnabled: true,
        embeddingFallbackProvider: "openai",
        openaiApiKey: "test-key",
        memoryDir,
      }) as any);

      assert.deepEqual(await helper.embedBatch(["doc one", "doc two", "doc three", "doc four"], 2), [
        [0, 1],
        [0, 1],
        [0, 1],
        [0, 1],
      ]);
      assert.deepEqual(hostInputs, ["doc one", "doc two", "doc three", "doc four"]);
      assert.deepEqual(fallbackInputs, ["doc one", "doc two", "doc three", "doc four"]);
    } finally {
      globalThis.fetch = originalFetch;
      unregister();
      clearHostEmbeddingProvidersForTest();
    }
  });
});

describe("embedded backend provider identity", () => {
  it("LanceDbBackend resets stale vectors when the embedding provider changes", async () => {
    const { LanceDbBackend } = await import("../src/search/lancedb-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-lance-provider-id-"));
    try {
      const factsDir = path.join(tempDir, "facts");
      await mkdir(factsDir);
      await writeFile(path.join(factsDir, "same.md"), "Updated content.", "utf8");

      const addCalls: Array<{ rows: any[]; options: any }> = [];
      const table = {
        query: () => ({
          select: () => ({
            toArray: async () => [{
              docid: "same",
              vector: [0.25, 0.75],
              vectorProvider: "openai:text-embedding-3-small",
            }],
          }),
        }),
        add: async (rows: any[], options: any) => {
          addCalls.push({ rows, options });
        },
        createIndex: async () => {},
      };
      const backend = new LanceDbBackend({
        dbPath: path.join(tempDir, "db"),
        collection: "memories",
        embedHelper: {
          ...fakeEmbedHelper(),
          isAvailable: () => true,
          getProviderIdentity: () => "host:openclaw-memory",
        },
        memoryDir: tempDir,
        embeddingDimension: 2,
      });
      (backend as any).table = table;
      (backend as any).lanceModule = { Index: { fts: () => ({}) } };

      await backend.updateCollection("memories");

      assert.equal(addCalls.length, 1);
      assert.deepEqual(addCalls[0].rows[0].vector, [0, 0]);
      assert.equal(addCalls[0].rows[0].vectorProvider, "");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("LanceDbBackend recreates legacy tables before writing vectorProvider rows", async () => {
    const { LanceDbBackend } = await import("../src/search/lancedb-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-lance-provider-migrate-"));
    try {
      const factsDir = path.join(tempDir, "facts");
      await mkdir(factsDir);
      await writeFile(path.join(factsDir, "same.md"), "Updated content.", "utf8");

      let dropped = false;
      const addCalls: Array<{ rows: any[]; options: any }> = [];
      const legacyTable = {
        query: () => ({
          select: (columns: string[]) => ({
            toArray: async () => {
              if (columns.includes("vectorProvider")) {
                throw new Error("missing column vectorProvider");
              }
              return [];
            },
          }),
        }),
      };
      const migratedTable = {
        query: () => ({
          select: () => ({
            toArray: async () => [],
          }),
        }),
        add: async (rows: any[], options: any) => {
          addCalls.push({ rows, options });
        },
        createIndex: async () => {},
        delete: async () => {},
      };
      const backend = new LanceDbBackend({
        dbPath: path.join(tempDir, "db"),
        collection: "memories",
        embedHelper: {
          ...fakeEmbedHelper(),
          isAvailable: () => true,
          getProviderIdentity: () => "host:openclaw-memory",
        },
        memoryDir: tempDir,
        embeddingDimension: 2,
      });
      (backend as any).table = legacyTable;
      (backend as any).db = {
        tableNames: async () => (dropped ? [] : ["memories"]),
        dropTable: async () => {
          dropped = true;
        },
        createTable: async () => migratedTable,
      };
      (backend as any).lanceModule = { Index: { fts: () => ({}) } };

      await backend.updateCollection("memories");

      assert.equal(dropped, true);
      assert.equal(addCalls.length, 1);
      assert.equal(addCalls[0].rows[0].vectorProvider, "");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("LanceDbBackend skips overwrite when the vectorProvider probe fails transiently", async () => {
    const { LanceDbBackend } = await import("../src/search/lancedb-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-lance-provider-probe-fail-"));
    try {
      const factsDir = path.join(tempDir, "facts");
      await mkdir(factsDir);
      await writeFile(path.join(factsDir, "same.md"), "Updated content.", "utf8");

      let dropped = false;
      let createTableCalled = false;
      const addCalls: Array<{ rows: any[]; options: any }> = [];
      const table = {
        query: () => ({
          select: () => ({
            toArray: async () => {
              throw new Error("transient query failure");
            },
          }),
        }),
        add: async (rows: any[], options: any) => {
          addCalls.push({ rows, options });
        },
        createIndex: async () => {},
      };
      const backend = new LanceDbBackend({
        dbPath: path.join(tempDir, "db"),
        collection: "memories",
        embedHelper: {
          ...fakeEmbedHelper(),
          isAvailable: () => true,
          getProviderIdentity: () => "host:openclaw-memory",
        },
        memoryDir: tempDir,
        embeddingDimension: 2,
      });
      (backend as any).table = table;
      (backend as any).db = {
        tableNames: async () => ["memories"],
        dropTable: async () => {
          dropped = true;
        },
        createTable: async () => {
          createTableCalled = true;
          throw new Error("createTable should not be called for transient probe failures");
        },
      };
      (backend as any).lanceModule = { Index: { fts: () => ({}) } };

      await backend.updateCollection("memories");

      assert.equal(dropped, false);
      assert.equal(createTableCalled, false);
      assert.equal(addCalls.length, 0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("LanceDbBackend skips overwrite when existing vector preservation fails", async () => {
    const { LanceDbBackend } = await import("../src/search/lancedb-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-lance-provider-preserve-fail-"));
    try {
      const factsDir = path.join(tempDir, "facts");
      await mkdir(factsDir);
      await writeFile(path.join(factsDir, "same.md"), "Updated content.", "utf8");

      const addCalls: Array<{ rows: any[]; options: any }> = [];
      const table = {
        query: () => ({
          select: (columns: string[]) => ({
            toArray: async () => {
              if (columns.length === 1 && columns[0] === "vectorProvider") {
                return [{ vectorProvider: "host:openclaw-memory" }];
              }
              throw new Error("transient row load failure");
            },
          }),
        }),
        add: async (rows: any[], options: any) => {
          addCalls.push({ rows, options });
        },
        createIndex: async () => {},
      };
      const backend = new LanceDbBackend({
        dbPath: path.join(tempDir, "db"),
        collection: "memories",
        embedHelper: {
          ...fakeEmbedHelper(),
          isAvailable: () => true,
          getProviderIdentity: () => "host:openclaw-memory",
        },
        memoryDir: tempDir,
        embeddingDimension: 2,
      });
      (backend as any).table = table;
      (backend as any).lanceModule = { Index: { fts: () => ({}) } };

      await backend.updateCollection("memories");

      assert.equal(addCalls.length, 0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("LanceDbBackend falls back to FTS when stored vectors use another provider", async () => {
    const { LanceDbBackend } = await import("../src/search/lancedb-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-lance-provider-search-"));
    try {
      const searchCalls: string[] = [];
      const table = {
        query: () => ({
          select: () => ({
            toArray: async () => [{
              docid: "same",
              vector: [0.25, 0.75],
              vectorProvider: "openai:text-embedding-3-small",
            }],
          }),
        }),
        search: (value: unknown, mode?: string) => {
          searchCalls.push(mode ?? (Array.isArray(value) ? "vector" : "unknown"));
          return {
            limit: () => ({
              toArray: async () => [{
                docid: "same",
                path: "facts/same.md",
                snippet: "same",
                _relevance_score: 0.9,
              }],
            }),
          };
        },
      };
      const backend = new LanceDbBackend({
        dbPath: path.join(tempDir, "db"),
        collection: "memories",
        embedHelper: {
          ...fakeEmbedHelper(),
          isAvailable: () => true,
          embedWithProvider: async () => ({
            vector: [1, 0],
            providerIdentity: "host:openclaw-memory",
          }),
        },
        memoryDir: tempDir,
        embeddingDimension: 2,
      });
      (backend as any).table = table;

      const results = await backend.vectorSearch("same", "memories", 5);

      assert.deepEqual(searchCalls, ["fts"]);
      assert.deepEqual(results.map((result) => result.docid), ["same"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("LanceDbBackend clears vector provider compatibility when active provider identity is unavailable", async () => {
    const { LanceDbBackend } = await import("../src/search/lancedb-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-lance-provider-cache-clear-"));
    try {
      const table = {};
      const backend = new LanceDbBackend({
        dbPath: path.join(tempDir, "db"),
        collection: "memories",
        embedHelper: fakeEmbedHelper(),
        memoryDir: tempDir,
        embeddingDimension: 2,
      });
      (backend as any).vectorProviderCompatibility.set(table, {
        providerIdentity: "host:openclaw-memory",
        compatible: true,
      });

      (backend as any).rememberVectorProviderCompatibility(table, null, false);

      assert.equal((backend as any).vectorProviderCompatibility.get(table), undefined);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("LanceDbBackend searches stored fallback vectors before FTS", async () => {
    const { LanceDbBackend } = await import("../src/search/lancedb-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-lance-provider-fallback-search-"));
    try {
      const searchCalls: Array<{ mode: string; value: unknown }> = [];
      const fallbackProviderIdentity = "openai:text-embedding-3-small";
      const table = {
        query: () => ({
          select: () => ({
            toArray: async () => [{
              docid: "fallback",
              vector: [0.25, 0.75],
              vectorProvider: fallbackProviderIdentity,
            }],
          }),
        }),
        search: (value: unknown, mode?: string) => {
          searchCalls.push({ mode: mode ?? (Array.isArray(value) ? "vector" : "unknown"), value });
          return {
            limit: () => ({
              toArray: async () => [{
                docid: "fallback",
                path: "facts/fallback.md",
                snippet: "fallback",
                _distance: 0,
              }],
            }),
          };
        },
      };
      const fallbackEmbeds: string[] = [];
      const backend = new LanceDbBackend({
        dbPath: path.join(tempDir, "db"),
        collection: "memories",
        embedHelper: {
          ...fakeEmbedHelper(),
          isAvailable: () => true,
          embedWithProvider: async () => ({
            vector: [1, 0],
            providerIdentity: "host:openclaw-memory",
          }),
          embedWithFallbackProviderIdentity: async (
            _query: string,
            providerIdentity: string,
          ) => {
            fallbackEmbeds.push(providerIdentity);
            return {
              vector: [0.25, 0.75],
              providerIdentity,
            };
          },
        },
        memoryDir: tempDir,
        embeddingDimension: 2,
      });
      (backend as any).table = table;

      const results = await backend.vectorSearch("semantic only", "memories", 5);

      assert.deepEqual(fallbackEmbeds, [fallbackProviderIdentity]);
      assert.deepEqual(searchCalls.map((call) => call.mode), ["vector"]);
      assert.deepEqual(searchCalls[0]?.value, [0.25, 0.75]);
      assert.deepEqual(results.map((result) => result.docid), ["fallback"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("LanceDbBackend falls back to FTS when query vector dimensions do not match schema", async () => {
    const { LanceDbBackend } = await import("../src/search/lancedb-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-lance-provider-dim-search-"));
    try {
      const searchCalls: string[] = [];
      const table = {
        query: () => ({
          select: () => ({
            toArray: async () => [{
              docid: "same",
              vectorProvider: "host:openclaw-memory",
            }],
          }),
        }),
        search: (value: unknown, mode?: string) => {
          searchCalls.push(mode ?? (Array.isArray(value) ? "vector" : "unknown"));
          return {
            limit: () => ({
              toArray: async () => [{
                docid: "same",
                path: "facts/same.md",
                snippet: "same",
                _relevance_score: 0.9,
              }],
            }),
          };
        },
      };
      const backend = new LanceDbBackend({
        dbPath: path.join(tempDir, "db"),
        collection: "memories",
        embedHelper: {
          ...fakeEmbedHelper(),
          isAvailable: () => true,
          embedWithProvider: async () => ({
            vector: [1, 0, 0],
            providerIdentity: "host:openclaw-memory",
          }),
        },
        memoryDir: tempDir,
        embeddingDimension: 2,
      });
      (backend as any).table = table;

      const results = await backend.vectorSearch("same", "memories", 5);

      assert.deepEqual(searchCalls, ["fts"]);
      assert.deepEqual(results.map((result) => result.docid), ["same"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("LanceDbBackend falls back to FTS when stored same-provider vectors have stale dimensions", async () => {
    const { LanceDbBackend } = await import("../src/search/lancedb-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-lance-provider-stale-dim-search-"));
    try {
      const searchCalls: string[] = [];
      const selectCalls: string[][] = [];
      const table = {
        query: () => ({
          select: (columns: string[]) => ({
            toArray: async () => {
              selectCalls.push(columns);
              return [{
                docid: "same",
                vector: [1, 0, 0],
                vectorProvider: "host:openclaw-memory",
              }];
            },
          }),
        }),
        search: (value: unknown, mode?: string) => {
          searchCalls.push(mode ?? (Array.isArray(value) ? "vector" : "unknown"));
          return {
            limit: () => ({
              toArray: async () => [{
                docid: "same",
                path: "facts/same.md",
                snippet: "same",
                _relevance_score: 0.9,
              }],
            }),
          };
        },
      };
      const backend = new LanceDbBackend({
        dbPath: path.join(tempDir, "db"),
        collection: "memories",
        embedHelper: {
          ...fakeEmbedHelper(),
          isAvailable: () => true,
          embedWithProvider: async () => ({
            vector: [1, 0],
            providerIdentity: "host:openclaw-memory",
          }),
        },
        memoryDir: tempDir,
        embeddingDimension: 2,
      });
      (backend as any).table = table;

      const results = await backend.vectorSearch("same", "memories", 5);

      assert.deepEqual(selectCalls, [["vector", "vectorProvider"]]);
      assert.deepEqual(searchCalls, ["fts"]);
      assert.deepEqual(results.map((result) => result.docid), ["same"]);
      assert.deepEqual((backend as any).vectorProviderCompatibility.get(table), {
        providerIdentity: "host:openclaw-memory",
        compatible: false,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("LanceDbBackend skips writes for mismatched embedding dimensions", async () => {
    const { LanceDbBackend } = await import("../src/search/lancedb-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-lance-provider-dim-embed-"));
    try {
      const updateCalls: Array<Record<string, unknown>> = [];
      const table = {
        query: () => ({
          select: () => ({
            toArray: async () => [{
              docid: "same",
              content: "Updated content.",
              vector: [0, 0],
              vectorProvider: "",
            }],
          }),
        }),
        update: async (payload: Record<string, unknown>) => {
          updateCalls.push(payload);
        },
      };
      const backend = new LanceDbBackend({
        dbPath: path.join(tempDir, "db"),
        collection: "memories",
        embedHelper: {
          ...fakeEmbedHelper(),
          isAvailable: () => true,
          getProviderIdentity: () => "host:openclaw-memory",
          embedBatchWithProvider: async () => ({
            vectors: [[1, 0, 0]],
            providerIdentity: "host:openclaw-memory",
          }),
        },
        memoryDir: tempDir,
        embeddingDimension: 2,
      });
      (backend as any).table = table;
      (backend as any).vectorProviderCompatibility.set(table, {
        providerIdentity: "openai:text-embedding-3-small",
        compatible: false,
      });

      await backend.embedCollection("memories");

      assert.equal(updateCalls.length, 0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("LanceDbBackend re-embeds same-provider rows with stale vector dimensions", async () => {
    const { LanceDbBackend } = await import("../src/search/lancedb-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-lance-provider-stale-dim-"));
    try {
      const updateCalls: Array<Record<string, unknown>> = [];
      const table = {
        query: () => ({
          select: () => ({
            toArray: async () => [{
              docid: "same",
              content: "Updated content.",
              vector: [0, 0, 0],
              vectorProvider: "host:openclaw-memory",
            }],
          }),
        }),
        update: async (payload: Record<string, unknown>) => {
          updateCalls.push(payload);
        },
      };
      const backend = new LanceDbBackend({
        dbPath: path.join(tempDir, "db"),
        collection: "memories",
        embedHelper: {
          ...fakeEmbedHelper(),
          isAvailable: () => true,
          getProviderIdentity: () => "host:openclaw-memory",
          embedBatchWithProvider: async () => ({
            vectors: [[1, 0]],
            providerIdentity: "host:openclaw-memory",
          }),
        },
        memoryDir: tempDir,
        embeddingDimension: 2,
      });
      (backend as any).table = table;

      await backend.embedCollection("memories");

      assert.equal(updateCalls.length, 1);
      assert.deepEqual((updateCalls[0]?.values as Record<string, unknown>)?.vector, [1, 0]);
      assert.equal(
        (updateCalls[0]?.values as Record<string, unknown>)?.vectorProvider,
        "host:openclaw-memory",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("LanceDbBackend re-embeds current-provider rows when embedding falls back", async () => {
    const { LanceDbBackend } = await import("../src/search/lancedb-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-lance-fallback-cache-"));
    try {
      const rows = [
        {
          docid: "host-row",
          content: "Already embedded by the host.",
          vector: [1, 0],
          vectorProvider: "host:openclaw-memory",
        },
        {
          docid: "fallback-row",
          content: "Needs fallback embedding.",
          vector: [0, 0],
          vectorProvider: "",
        },
      ];
      let embedCalls = 0;
      const updateCalls: Array<Record<string, unknown>> = [];
      const table = {
        query: () => ({
          select: () => ({
            toArray: async () => rows.map((row) => ({ ...row })),
          }),
        }),
        update: async (payload: Record<string, unknown>) => {
          updateCalls.push(payload);
          const docid = /docid = '([^']+)'/.exec(String(payload.where ?? ""))?.[1];
          const row = rows.find((entry) => entry.docid === docid);
          if (row) {
            Object.assign(row, payload.values);
          }
        },
      };
      const backend = new LanceDbBackend({
        dbPath: path.join(tempDir, "db"),
        collection: "memories",
        embedHelper: {
          ...fakeEmbedHelper(),
          isAvailable: () => true,
          getProviderIdentity: () => "host:openclaw-memory",
          embedBatchWithProvider: async (texts: string[]) => {
            embedCalls += 1;
            return {
              vectors: texts.map((_, index) => [index + 1, 1]),
              providerIdentity: "openai:text-embedding-3-small",
            };
          },
        },
        memoryDir: tempDir,
        embeddingDimension: 2,
      });
      (backend as any).table = table;

      await backend.embedCollection("memories");

      assert.equal(embedCalls, 2);
      assert.equal(updateCalls.length, 2);
      assert.deepEqual(rows.map((row) => row.vectorProvider), [
        "openai:text-embedding-3-small",
        "openai:text-embedding-3-small",
      ]);
      assert.deepEqual((backend as any).vectorProviderCompatibility.get(table), {
        providerIdentity: "openai:text-embedding-3-small",
        compatible: true,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("OramaBackend migrates legacy documents missing vectorProvider", async () => {
    const { OramaBackend } = await import("../src/search/orama-backend.js");
    const { create, insert, search } = await import("@orama/orama");
    const { persist, restore } = await import("@orama/plugin-data-persistence");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-orama-provider-migrate-"));
    try {
      const dbPath = path.join(tempDir, "db");
      await mkdir(dbPath, { recursive: true });
      const legacyDb = await create({
        schema: {
          id: "string",
          path: "string",
          content: "string",
          snippet: "string",
          vector: "vector[2]",
        },
      });
      await insert(legacyDb, {
        id: "same",
        path: "facts/same.md",
        content: "legacy content",
        snippet: "legacy",
        vector: [1, 0],
      });
      await writeFile(
        path.join(dbPath, "memories.msp"),
        await persist(legacyDb, "json") as string,
        "utf-8",
      );

      const backend = new OramaBackend({
        dbPath,
        collection: "memories",
        embedHelper: {
          ...fakeEmbedHelper(),
          isAvailable: () => true,
          getProviderIdentity: () => "host:openclaw-memory",
          embedBatchWithProvider: async () => ({
            vectors: [[0, 1]],
            providerIdentity: "host:openclaw-memory",
          }),
        },
        memoryDir: tempDir,
        embeddingDimension: 2,
      });

      assert.equal(await backend.probe(), true);
      await backend.embedCollection("memories");

      const migrated = await restore(
        "json",
        await readFile(path.join(dbPath, "memories.msp"), "utf-8"),
      );
      const results = await search(migrated, { term: "", limit: 10 });
      assert.equal(results.hits[0]?.document.vectorProvider, "host:openclaw-memory");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("OramaBackend migrates legacy files loaded by global search", async () => {
    const { OramaBackend } = await import("../src/search/orama-backend.js");
    const { create, insert, search } = await import("@orama/orama");
    const { persist, restore } = await import("@orama/plugin-data-persistence");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-orama-global-provider-migrate-"));
    try {
      const dbPath = path.join(tempDir, "db");
      await mkdir(dbPath, { recursive: true });
      const legacyDb = await create({
        schema: {
          id: "string",
          path: "string",
          content: "string",
          snippet: "string",
          vector: "vector[2]",
        },
      });
      await insert(legacyDb, {
        id: "same",
        path: "facts/same.md",
        content: "legacy global content",
        snippet: "legacy global",
        vector: [1, 0],
      });
      await writeFile(
        path.join(dbPath, "memories.msp"),
        await persist(legacyDb, "json") as string,
        "utf-8",
      );

      const backend = new OramaBackend({
        dbPath,
        collection: "other",
        embedHelper: fakeEmbedHelper(),
        memoryDir: tempDir,
        embeddingDimension: 2,
      });
      (backend as any).available = true;

      const results = await backend.searchGlobal("legacy global", 5);
      assert.equal(results[0]?.docid, "same");

      const migrated = await restore(
        "json",
        await readFile(path.join(dbPath, "memories.msp"), "utf-8"),
      );
      const migratedResults = await search(migrated, { term: "", limit: 10 });
      assert.equal(migratedResults.hits[0]?.document.vectorProvider, "");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("OramaBackend aborts legacy vectorProvider migration without persisting partial copies", async () => {
    const { OramaBackend } = await import("../src/search/orama-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-orama-provider-migrate-fail-"));
    try {
      const migratedDb = {};
      const inserted: string[] = [];
      let persisted = false;
      const backend = new OramaBackend({
        dbPath: path.join(tempDir, "db"),
        collection: "memories",
        embedHelper: fakeEmbedHelper(),
        memoryDir: tempDir,
        embeddingDimension: 2,
      });
      (backend as any).oramaModule = {
        count: async () => 2,
        search: async () => ({
          hits: [
            {
              id: "one",
              document: {
                id: "one",
                path: "facts/one.md",
                content: "one",
                snippet: "one",
                vector: [1, 0],
              },
            },
            {
              id: "two",
              document: {
                id: "two",
                path: "facts/two.md",
                content: "two",
                snippet: "two",
                vector: [0, 1],
              },
            },
          ],
        }),
        create: async () => migratedDb,
        insert: async (_db: unknown, payload: Record<string, unknown>) => {
          inserted.push(String(payload.id));
          if (payload.id === "two") {
            throw new Error("insert failed");
          }
        },
      };
      (backend as any).persistDbForCollection = async () => {
        persisted = true;
      };

      await assert.rejects(
        () => (backend as any).migrateLegacyVectorProviderSchema({}, "memories"),
        /insert failed/,
      );

      assert.deepEqual(inserted, ["one", "two"]);
      assert.equal(persisted, false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("OramaBackend preserves internal vectors during legacy vectorProvider migration", async () => {
    const { OramaBackend } = await import("../src/search/orama-backend.js");
    const { create, insert, search } = await import("@orama/orama");
    const { persist, restore } = await import("@orama/plugin-data-persistence");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-orama-provider-migrate-vector-"));
    try {
      const dbPath = path.join(tempDir, "db");
      await mkdir(dbPath, { recursive: true });
      const legacyDb = await create({
        schema: {
          id: "string",
          path: "string",
          content: "string",
          snippet: "string",
          vector: "vector[2]",
        },
      });
      await insert(legacyDb, {
        id: "same",
        path: "facts/same.md",
        content: "legacy content",
        snippet: "legacy",
        vector: [1, 0],
      });
      await writeFile(
        path.join(dbPath, "memories.msp"),
        await persist(legacyDb, "json") as string,
        "utf-8",
      );

      const backend = new OramaBackend({
        dbPath,
        collection: "memories",
        embedHelper: fakeEmbedHelper(),
        memoryDir: tempDir,
        embeddingDimension: 2,
      });

      assert.equal(await backend.probe(), true);

      const migrated = await restore(
        "json",
        await readFile(path.join(dbPath, "memories.msp"), "utf-8"),
      );
      const results = await search(migrated, { term: "", limit: 10 });
      const hit = results.hits[0];
      const doc = (backend as any).getStoredDocument(migrated, hit);
      assert.equal(doc.vectorProvider, "");
      assert.deepEqual((backend as any).getStoredVector(migrated, hit, doc), [1, 0]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("OramaBackend clears provider tags for persisted rows with missing vectors", async () => {
    const { OramaBackend } = await import("../src/search/orama-backend.js");
    const { create, getByID, insert, search } = await import("@orama/orama");
    const { persist } = await import("@orama/plugin-data-persistence");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-orama-compatible-cache-"));
    try {
      const dbPath = path.join(tempDir, "db");
      await mkdir(dbPath, { recursive: true });
      await mkdir(path.join(tempDir, "facts"), { recursive: true });
      await writeFile(
        path.join(tempDir, "facts", "same.md"),
        "---\nid: same\n---\nThe same launch fact should preserve compatible vectors.",
        "utf-8",
      );
      const db = await create({
        schema: {
          id: "string",
          path: "string",
          content: "string",
          snippet: "string",
          vector: "vector[2]",
          vectorProvider: "string",
        },
      });
      await insert(db, {
        id: "same",
        path: "facts/same.md",
        content: "old content",
        snippet: "old",
        vector: [1, 0],
        vectorProvider: "host:openclaw-memory",
      });
      await writeFile(
        path.join(dbPath, "memories.msp"),
        await persist(db, "json") as string,
        "utf-8",
      );

      const backend = new OramaBackend({
        dbPath,
        collection: "memories",
        embedHelper: {
          ...fakeEmbedHelper(),
          isAvailable: () => true,
          getProviderIdentity: () => "host:openclaw-memory",
        },
        memoryDir: tempDir,
        embeddingDimension: 2,
      });

      assert.equal(await backend.probe(), true);
      await backend.update();

      const cache = (backend as any).vectorProviderCompatibility.get(
        (backend as any).db,
      );
      assert.deepEqual(cache, {
        providerIdentity: "host:openclaw-memory",
        compatible: false,
      });
      const hits = await search((backend as any).db, { term: "", limit: 1 });
      assert.equal(hits.hits[0]?.document.vectorProvider, "");
      const internalId = (backend as any).db.internalDocumentIDStore.idToInternalId.get("same");
      const vectorEntry =
        (backend as any).db.data.index.vectorIndexes.vector.node.vectors.get(internalId);
      assert.deepEqual(Array.from(vectorEntry[1]), [0, 0]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("OramaBackend re-embeds same-provider rows with placeholder zero vectors", async () => {
    const { OramaBackend } = await import("../src/search/orama-backend.js");
    const { create, getByID, insert } = await import("@orama/orama");
    const { persist, restore } = await import("@orama/plugin-data-persistence");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-orama-zero-vector-"));
    try {
      const dbPath = path.join(tempDir, "db");
      await mkdir(dbPath, { recursive: true });
      const db = await create({
        schema: {
          id: "string",
          path: "string",
          content: "string",
          snippet: "string",
          vector: "vector[2]",
          vectorProvider: "string",
        },
      });
      await insert(db, {
        id: "zero",
        path: "facts/zero.md",
        content: "placeholder vector row",
        snippet: "placeholder",
        vector: [0, 0],
        vectorProvider: "host:openclaw-memory",
      });
      await writeFile(
        path.join(dbPath, "memories.msp"),
        await persist(db, "json") as string,
        "utf-8",
      );
      let embedCalls = 0;

      const backend = new OramaBackend({
        dbPath,
        collection: "memories",
        embedHelper: {
          ...fakeEmbedHelper(),
          isAvailable: () => true,
          getProviderIdentity: () => "host:openclaw-memory",
          embedBatchWithProvider: async () => {
            embedCalls += 1;
            return {
              vectors: [[0, 1]],
              providerIdentity: "host:openclaw-memory",
            };
          },
        },
        memoryDir: tempDir,
        embeddingDimension: 2,
      });

      assert.equal(await backend.probe(), true);
      await backend.embedCollection("memories");

      const updated = await restore(
        "json",
        await readFile(path.join(dbPath, "memories.msp"), "utf-8"),
      );
      const document = await getByID(updated, "zero");
      assert.equal(embedCalls, 1);
      assert.deepEqual(document?.vector, [0, 1]);
      assert.equal(document?.vectorProvider, "host:openclaw-memory");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("OramaBackend re-embeds current-provider rows when embedding falls back", async () => {
    const { OramaBackend } = await import("../src/search/orama-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-orama-fallback-converge-"));
    try {
      const db = {};
      const rows = [
        {
          id: "host-row",
          path: "facts/host.md",
          content: "Already embedded by the host.",
          snippet: "host",
          vector: [1, 0],
          vectorProvider: "host:openclaw-memory",
        },
        {
          id: "fallback-row",
          path: "facts/fallback.md",
          content: "Needs fallback embedding.",
          snippet: "fallback",
          vector: [0, 0],
          vectorProvider: "",
        },
      ];
      let embedCalls = 0;
      const updateCalls: Array<{ id: string; payload: Record<string, unknown> }> = [];

      const backend = new OramaBackend({
        dbPath: path.join(tempDir, "db"),
        collection: "memories",
        embedHelper: {
          ...fakeEmbedHelper(),
          isAvailable: () => true,
          getProviderIdentity: () => "host:openclaw-memory",
          embedBatchWithProvider: async (texts: string[]) => {
            embedCalls += 1;
            return {
              vectors: texts.map((_, index) => [index + 1, 1]),
              providerIdentity: "openai:text-embedding-3-small",
            };
          },
        },
        memoryDir: tempDir,
        embeddingDimension: 2,
      });
      (backend as any).ensureDbForCollection = async () => db;
      (backend as any).persistDbForCollection = async () => {};
      (backend as any).oramaModule = {
        count: async () => rows.length,
        search: async () => ({
          hits: rows.map((row) => ({
            id: row.id,
            document: { ...row },
          })),
        }),
        update: async (_db: unknown, id: string, payload: Record<string, unknown>) => {
          updateCalls.push({ id, payload });
          const row = rows.find((entry) => entry.id === id);
          if (row) Object.assign(row, payload);
        },
      };
      (backend as any).vectorProviderCompatibility.set(db, {
        providerIdentity: "openai:text-embedding-3-small",
        compatible: false,
      });

      await backend.embedCollection("memories");

      assert.equal(embedCalls, 2);
      assert.deepEqual(updateCalls.map((call) => call.id).sort(), [
        "fallback-row",
        "host-row",
      ]);
      assert.deepEqual(rows.map((row) => row.vectorProvider), [
        "openai:text-embedding-3-small",
        "openai:text-embedding-3-small",
      ]);
      assert.deepEqual((backend as any).vectorProviderCompatibility.get(db), {
        providerIdentity: "openai:text-embedding-3-small",
        compatible: true,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("OramaBackend clears vector provider compatibility when active provider identity is unavailable", async () => {
    const { OramaBackend } = await import("../src/search/orama-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-orama-provider-cache-clear-"));
    try {
      const db = {};
      const backend = new OramaBackend({
        dbPath: path.join(tempDir, "db"),
        collection: "memories",
        embedHelper: fakeEmbedHelper(),
        memoryDir: tempDir,
        embeddingDimension: 2,
      });
      (backend as any).vectorProviderCompatibility.set(db, {
        providerIdentity: "host:openclaw-memory",
        compatible: true,
      });

      (backend as any).rememberVectorProviderCompatibility(db, null, false);

      assert.equal((backend as any).vectorProviderCompatibility.get(db), undefined);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("OramaBackend recreates empty legacy DBs before embedding new documents", async () => {
    const { OramaBackend } = await import("../src/search/orama-backend.js");
    const { create, search } = await import("@orama/orama");
    const { persist, restore } = await import("@orama/plugin-data-persistence");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-orama-empty-legacy-"));
    try {
      const dbPath = path.join(tempDir, "db");
      await mkdir(dbPath, { recursive: true });
      const legacyDb = await create({
        schema: {
          id: "string",
          path: "string",
          content: "string",
          snippet: "string",
        },
      });
      await writeFile(
        path.join(dbPath, "memories.msp"),
        await persist(legacyDb, "json") as string,
        "utf-8",
      );
      await mkdir(path.join(tempDir, "facts"), { recursive: true });
      await writeFile(
        path.join(tempDir, "facts", "launch.md"),
        "The launch memo should be embedded after legacy schema migration.",
        "utf-8",
      );
      let embedCalls = 0;

      const backend = new OramaBackend({
        dbPath,
        collection: "memories",
        embedHelper: {
          ...fakeEmbedHelper(),
          isAvailable: () => true,
          getProviderIdentity: () => "host:openclaw-memory",
          embedBatchWithProvider: async () => {
            embedCalls += 1;
            return {
              vectors: [[1, 0]],
              providerIdentity: "host:openclaw-memory",
            };
          },
          embedWithProvider: async () => ({
            vector: [1, 0],
            providerIdentity: "host:openclaw-memory",
          }),
        },
        memoryDir: tempDir,
        embeddingDimension: 2,
      });

      assert.equal(await backend.probe(), true);
      await backend.update();
      await backend.embed();

      const restored = await restore(
        "json",
        await readFile(path.join(dbPath, "memories.msp"), "utf-8"),
      );
      const allHits = await search(restored, { term: "", limit: 10 });
      const launchDoc = allHits.hits.find((hit: any) => hit.document?.id === "launch")
        ?.document;
      assert.equal(embedCalls, 1);
      assert.equal(launchDoc?.vectorProvider, "host:openclaw-memory");
      assert.doesNotThrow(() =>
        search(restored, {
          mode: "vector",
          vector: { value: [1, 0], property: "vector" },
          limit: 5,
        } as any),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("OramaBackend keeps no-provider collections vector-ready for later embeddings", async () => {
    const { OramaBackend } = await import("../src/search/orama-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-orama-late-embed-"));
    try {
      const dbPath = path.join(tempDir, "db");
      await mkdir(path.join(tempDir, "facts"), { recursive: true });
      await writeFile(
        path.join(tempDir, "facts", "handoff.md"),
        "The handoff memory should become vector searchable once embeddings start.",
        "utf-8",
      );

      const noProviderBackend = new OramaBackend({
        dbPath,
        collection: "memories",
        embedHelper: fakeEmbedHelper(),
        memoryDir: tempDir,
        embeddingDimension: 2,
      });

      assert.equal(await noProviderBackend.probe(), true);
      await noProviderBackend.update();
      const noProviderResults = await noProviderBackend.bm25Search("handoff", "memories", 5);
      assert.equal(noProviderResults[0]?.docid, "handoff");

      const vectorBackend = new OramaBackend({
        dbPath,
        collection: "memories",
        embedHelper: {
          ...fakeEmbedHelper(),
          isAvailable: () => true,
          getProviderIdentity: () => "host:openclaw-memory",
          embedBatchWithProvider: async () => ({
            vectors: [[1, 0]],
            providerIdentity: "host:openclaw-memory",
          }),
          embedWithProvider: async () => ({
            vector: [1, 0],
            providerIdentity: "host:openclaw-memory",
          }),
        },
        memoryDir: tempDir,
        embeddingDimension: 2,
      });

      assert.equal(await vectorBackend.probe(), true);
      await vectorBackend.embed();

      const results = await vectorBackend.vectorSearch("handoff", "memories", 5);
      assert.equal(results[0]?.docid, "handoff");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("OramaBackend zero-fills vector fields when migrating legacy text-only documents", async () => {
    const { OramaBackend } = await import("../src/search/orama-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-orama-text-legacy-"));
    try {
      const insertCalls: Array<Record<string, unknown>> = [];
      const backend = new OramaBackend({
        dbPath: path.join(tempDir, "db"),
        collection: "memories",
        embedHelper: fakeEmbedHelper(),
        memoryDir: tempDir,
        embeddingDimension: 2,
      });
      (backend as any).oramaModule = {
        count: async () => 1,
        create: async () => ({}),
        search: async () => ({
          hits: [
            {
              id: "text-only-internal",
              document: {
                id: "text-only",
                path: "facts/text-only.md",
                content: "legacy text-only content",
                snippet: "legacy text",
              },
            },
          ],
        }),
        insert: async (_db: unknown, payload: Record<string, unknown>) => {
          insertCalls.push(payload);
        },
      };
      (backend as any).persistModule = {
        persist: async () => "{}",
      };

      await (backend as any).migrateLegacyVectorProviderSchema({}, "memories");

      assert.equal(insertCalls.length, 1);
      assert.deepEqual(insertCalls[0]?.vector, [0, 0]);
      assert.equal(insertCalls[0]?.vectorProvider, "");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("OramaBackend re-embeds malformed current-provider vectors", async () => {
    const { OramaBackend } = await import("../src/search/orama-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-orama-reembed-"));
    try {
      const backend = new OramaBackend({
        dbPath: path.join(tempDir, "db"),
        collection: "memories",
        embedHelper: {
          ...fakeEmbedHelper(),
          isAvailable: () => true,
          getProviderIdentity: () => "host:openclaw-memory",
          embedBatchWithProvider: async () => ({
            vectors: [[0, 1]],
            providerIdentity: "host:openclaw-memory",
          }),
        },
        memoryDir: tempDir,
        embeddingDimension: 2,
      });
      const updateCalls: Array<{ id: string; payload: Record<string, unknown> }> = [];
      (backend as any).db = {};
      (backend as any).oramaModule = {
        count: async () => 1,
        search: async () => ({
          hits: [
            {
              id: "internal-malformed",
              document: {
                id: "malformed",
                path: "facts/malformed.md",
                content: "Malformed vector should be embedded again.",
                snippet: "Malformed vector",
                vector: [1, 0, 0],
                vectorProvider: "host:openclaw-memory",
              },
            },
          ],
        }),
        update: async (_db: unknown, id: string, payload: Record<string, unknown>) => {
          updateCalls.push({ id, payload });
        },
      };
      (backend as any).persistModule = {
        persist: async () => "{}",
      };

      await backend.embedCollection("memories");

      assert.equal(updateCalls.length, 1);
      assert.equal(updateCalls[0]?.id, "internal-malformed");
      assert.deepEqual(updateCalls[0]?.payload.vector, [0, 1]);
      assert.equal(updateCalls[0]?.payload.vectorProvider, "host:openclaw-memory");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("OramaBackend preserves valid vectors when provider identity is unavailable", async () => {
    const { OramaBackend } = await import("../src/search/orama-backend.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-orama-no-provider-preserve-"));
    try {
      await mkdir(path.join(tempDir, "facts"), { recursive: true });
      await writeFile(
        path.join(tempDir, "facts", "same.md"),
        "---\nid: same\n---\nThe same launch fact should keep an existing vector.",
        "utf-8",
      );
      const backend = new OramaBackend({
        dbPath: path.join(tempDir, "db"),
        collection: "memories",
        embedHelper: fakeEmbedHelper(),
        memoryDir: tempDir,
        embeddingDimension: 2,
      });
      const updateCalls: Array<{ id: string; payload: Record<string, unknown> }> = [];
      (backend as any).db = {};
      (backend as any).oramaModule = {
        count: async () => 1,
        search: async () => ({
          hits: [
            {
              id: "same",
              document: {
                id: "same",
                path: "facts/same.md",
                content: "Old content with a vector.",
                snippet: "Old content",
                vector: [1, 0],
                vectorProvider: "host:older-openclaw-memory",
              },
            },
          ],
        }),
        update: async (_db: unknown, id: string, payload: Record<string, unknown>) => {
          updateCalls.push({ id, payload });
        },
      };
      (backend as any).persistModule = {
        persist: async () => "{}",
      };

      await backend.updateCollection("memories");

      assert.equal(updateCalls.length, 1);
      assert.equal(updateCalls[0]?.id, "same");
      assert.deepEqual(updateCalls[0]?.payload.vector, [1, 0]);
      assert.equal(updateCalls[0]?.payload.vectorProvider, "host:older-openclaw-memory");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("OramaBackend falls back to fulltext for incompatible stored vector dimensions", async () => {
    const { OramaBackend } = await import("../src/search/orama-backend.js");
    const { create, insert } = await import("@orama/orama");
    const { persist } = await import("@orama/plugin-data-persistence");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-orama-dim-fallback-"));
    try {
      const dbPath = path.join(tempDir, "db");
      await mkdir(dbPath, { recursive: true });
      const db = await create({
        schema: {
          id: "string",
          path: "string",
          content: "string",
          snippet: "string",
          vector: "vector[3]",
          vectorProvider: "string",
        },
      });
      await insert(db, {
        id: "dimension-mismatch",
        path: "facts/dimension-mismatch.md",
        content: "The dimension mismatch memory must remain searchable.",
        snippet: "dimension mismatch",
        vector: [1, 0, 0],
        vectorProvider: "host:openclaw-memory",
      });
      await writeFile(
        path.join(dbPath, "memories.msp"),
        await persist(db, "json") as string,
        "utf-8",
      );

      const backend = new OramaBackend({
        dbPath,
        collection: "memories",
        embedHelper: {
          ...fakeEmbedHelper(),
          isAvailable: () => true,
          getProviderIdentity: () => "host:openclaw-memory",
          embedWithProvider: async () => ({
            vector: [1, 0],
            providerIdentity: "host:openclaw-memory",
          }),
        },
        memoryDir: tempDir,
        embeddingDimension: 2,
      });

      assert.equal(await backend.probe(), true);
      const results = await backend.vectorSearch("dimension mismatch", "memories", 5);
      assert.equal(results[0]?.docid, "dimension-mismatch");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("OramaBackend searches stored fallback vectors before fulltext", async () => {
    const { OramaBackend } = await import("../src/search/orama-backend.js");
    const { create, insert } = await import("@orama/orama");
    const { persist } = await import("@orama/plugin-data-persistence");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-orama-provider-fallback-search-"));
    try {
      const dbPath = path.join(tempDir, "db");
      await mkdir(dbPath, { recursive: true });
      const fallbackProviderIdentity = "openai:text-embedding-3-small";
      const db = await create({
        schema: {
          id: "string",
          path: "string",
          content: "string",
          snippet: "string",
          vector: "vector[2]",
          vectorProvider: "string",
        },
      });
      await insert(db, {
        id: "fallback-vector",
        path: "facts/fallback-vector.md",
        content: "A stored fallback embedding should be found without lexical overlap.",
        snippet: "fallback vector",
        vector: [0.25, 0.75],
        vectorProvider: fallbackProviderIdentity,
      });
      await writeFile(
        path.join(dbPath, "memories.msp"),
        await persist(db, "json") as string,
        "utf-8",
      );

      const fallbackEmbeds: string[] = [];
      const backend = new OramaBackend({
        dbPath,
        collection: "memories",
        embedHelper: {
          ...fakeEmbedHelper(),
          isAvailable: () => true,
          embedWithProvider: async () => ({
            vector: [1, 0],
            providerIdentity: "host:openclaw-memory",
          }),
          embedWithFallbackProviderIdentity: async (
            _query: string,
            providerIdentity: string,
          ) => {
            fallbackEmbeds.push(providerIdentity);
            return {
              vector: [0.25, 0.75],
              providerIdentity,
            };
          },
        },
        memoryDir: tempDir,
        embeddingDimension: 2,
      });

      assert.equal(await backend.probe(), true);
      const results = await backend.vectorSearch("semantic only", "memories", 5);

      assert.deepEqual(fallbackEmbeds, [fallbackProviderIdentity]);
      assert.equal(results[0]?.docid, "fallback-vector");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

/** Minimal fake PluginConfig for factory routing tests. */
function fakeConfig(overrides: Record<string, unknown> = {}): any {
  return {
    searchBackend: "qmd",
    qmdEnabled: false,
    qmdCollection: "test-collection",
    qmdMaxResults: 10,
    qmdPath: undefined,
    qmdDaemonEnabled: false,
    qmdDaemonUrl: "",
    qmdDaemonRecheckIntervalMs: 60_000,
    qmdIntentHintsEnabled: false,
    qmdExplainEnabled: false,
    slowLogEnabled: false,
    slowLogThresholdMs: 5000,
    qmdUpdateTimeoutMs: 30_000,
    qmdUpdateMinIntervalMs: 0,
    remoteSearchBaseUrl: undefined,
    remoteSearchApiKey: undefined,
    remoteSearchTimeoutMs: 30_000,
    memoryDir: "/tmp/engram-test",
    lanceDbPath: "/tmp/engram-test/lancedb",
    lanceEmbeddingDimension: 1536,
    meilisearchHost: "http://localhost:7700",
    meilisearchApiKey: undefined,
    meilisearchTimeoutMs: 30_000,
    meilisearchAutoIndex: false,
    oramaDbPath: "/tmp/engram-test/orama",
    oramaEmbeddingDimension: 1536,
    embeddingFallbackEnabled: false,
    embeddingFallbackProvider: "auto",
    openaiApiKey: undefined,
    localLlmEnabled: false,
    localLlmUrl: "",
    localLlmModel: "",
    localLlmApiKey: undefined,
    localLlmHeaders: undefined,
    localLlmAuthHeader: true,
    ...overrides,
  };
}

function fakeEmbedHelper(): any {
  return {
    isAvailable: () => false,
    embed: async () => null,
    embedBatch: async () => [],
    embedWithProvider: async () => null,
    embedBatchWithProvider: async () => null,
    getProviderIdentity: () => null,
  };
}

function countingEmbedHelper(): any {
  const helper = {
    embedCalls: 0,
    isAvailable: () => true,
    embed: async () => {
      helper.embedCalls++;
      return [0.1, 0.2];
    },
    embedBatch: async () => {
      helper.embedCalls++;
      return [[0.1, 0.2]];
    },
    embedWithProvider: async () => {
      helper.embedCalls++;
      return { vector: [0.1, 0.2], providerIdentity: "openai:text-embedding-3-small" };
    },
    embedBatchWithProvider: async () => {
      helper.embedCalls++;
      return {
        vectors: [[0.1, 0.2]],
        providerIdentity: "openai:text-embedding-3-small",
      };
    },
    getProviderIdentity: () => "openai:text-embedding-3-small",
  };
  return helper;
}
