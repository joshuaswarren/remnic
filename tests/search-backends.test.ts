import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";

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
  };
  return helper;
}
