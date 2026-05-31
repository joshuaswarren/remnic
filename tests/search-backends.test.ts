import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";

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
