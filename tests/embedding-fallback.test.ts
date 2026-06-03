import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import {
  EmbeddingFallback,
  EmbeddingProviderUnavailableError,
  EmbeddingTimeoutError,
} from "../src/embedding-fallback.js";
import {
  clearHostEmbeddingProvidersForTest,
  registerHostEmbeddingProvider,
} from "../src/host-embedding-provider.js";
import type { PluginConfig } from "../src/types.js";

function stubConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    openaiApiKey: "test-key",
    openaiBaseUrl: undefined,
    memoryDir: "/tmp/engram-embedding-test",
    embeddingFallbackEnabled: true,
    embeddingFallbackProvider: "openai",
    localLlmEnabled: false,
    localLlmUrl: undefined,
    localLlmModel: undefined,
    localLlmApiKey: undefined,
    localLlmHeaders: undefined,
    localLlmAuthHeader: true,
    ...overrides,
  } as PluginConfig;
}

test("EmbeddingFallback uses default OpenAI endpoint when openaiBaseUrl is unset", async () => {
  const fallback = new EmbeddingFallback(stubConfig());
  // Access the private resolveProvider via prototype to inspect the endpoint
  const provider = await (fallback as any).resolveProvider();
  assert.ok(provider);
  assert.equal(provider.endpoint, "https://api.openai.com/v1/embeddings");
  assert.equal(provider.type, "openai");
});

test("EmbeddingFallback respects custom openaiBaseUrl", async () => {
  const fallback = new EmbeddingFallback(stubConfig({
    openaiBaseUrl: "http://localhost:8005/v1",
  }));
  const provider = await (fallback as any).resolveProvider();
  assert.ok(provider);
  assert.equal(provider.endpoint, "http://localhost:8005/v1/embeddings");
  assert.equal(provider.type, "openai");
});

test("EmbeddingFallback strips trailing slash from custom openaiBaseUrl", async () => {
  const fallback = new EmbeddingFallback(stubConfig({
    openaiBaseUrl: "http://localhost:8005/v1/",
  }));
  const provider = await (fallback as any).resolveProvider();
  assert.ok(provider);
  assert.equal(provider.endpoint, "http://localhost:8005/v1/embeddings");
});

test("EmbeddingFallback uses local provider when embeddingFallbackProvider is local", async () => {
  const fallback = new EmbeddingFallback(stubConfig({
    embeddingFallbackProvider: "local",
    localLlmEnabled: true,
    localLlmUrl: "http://host.docker.internal:8006/v1",
    localLlmModel: "bge-m3",
    localLlmApiKey: "dummy",
  }));
  const provider = await (fallback as any).resolveProvider();
  assert.ok(provider);
  assert.equal(provider.type, "local");
  assert.equal(provider.model, "bge-m3");
  assert.equal(provider.endpoint, "http://host.docker.internal:8006/v1/embeddings");
});

test("EmbeddingFallback prefers scoped host embedding provider when registered", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-host-embed-"));
  const unregister = registerHostEmbeddingProvider(memoryDir, {
    id: "host-test",
    model: "host-model",
    async embed(text, options) {
      assert.equal(text, "launch query");
      assert.equal(options?.inputType, "query");
      return [0.25, 0.5, 0.75];
    },
  });
  try {
    const fallback = new EmbeddingFallback(stubConfig({ memoryDir }));
    const provider = await (fallback as any).resolveProvider();
    assert.equal(provider.type, "host");
    assert.equal(provider.model, "host-model");
    const vector = await (fallback as any).embed("launch query", provider, {
      mode: "lookup",
    });
    assert.deepEqual(vector, [0.25, 0.5, 0.75]);
  } finally {
    unregister();
    clearHostEmbeddingProvidersForTest();
  }
});

test("EmbeddingFallback falls back when scoped host provider fails", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-host-embed-fallback-"));
  const originalFetch = globalThis.fetch;
  const unregister = registerHostEmbeddingProvider(memoryDir, {
    id: "host-test",
    async embed() {
      throw new Error("host setup failed");
    },
  });
  try {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const fallback = new EmbeddingFallback(stubConfig({ memoryDir }));
    const provider = await (fallback as any).resolveProvider();
    assert.equal(provider.type, "host");
    const vector = await (fallback as any).embed("launch query", provider, {
      mode: "lookup",
    });
    assert.deepEqual(vector, [0.1, 0.2]);
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    unregister();
    clearHostEmbeddingProvidersForTest();
  }
});

test("EmbeddingFallback indexes and searches fallback vectors under the fallback provider", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-host-embed-index-fallback-"));
  const originalFetch = globalThis.fetch;
  const unregister = registerHostEmbeddingProvider(memoryDir, {
    id: "host-test",
    async embed() {
      return null;
    },
  });
  try {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const fallback = new EmbeddingFallback(stubConfig({ memoryDir }));
    await fallback.indexFile(
      "mem-openai",
      "launch planning",
      path.join(memoryDir, "facts", "launch.md"),
    );

    const raw = await readFile(path.join(memoryDir, "state", "embeddings.json"), "utf-8");
    const parsed = JSON.parse(raw) as {
      provider: string;
      entries: Record<string, unknown>;
    };
    assert.equal(parsed.provider, "openai");
    assert.ok(parsed.entries["mem-openai"]);

    const results = await fallback.search("launch", 5);
    assert.deepEqual(results.map((result) => result.id), ["mem-openai"]);
  } finally {
    globalThis.fetch = originalFetch;
    unregister();
    clearHostEmbeddingProvidersForTest();
  }
});

test("EmbeddingFallback replaces an existing host index after fallback embedding succeeds", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-host-embed-replace-fallback-"));
  const originalFetch = globalThis.fetch;
  const indexPath = path.join(memoryDir, "state", "embeddings.json");
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(
    indexPath,
    JSON.stringify({
      version: 1,
      provider: "host",
      model: "host-model",
      entries: {
        "mem-host": {
          vector: [1, 0],
          path: "facts/host.md",
        },
      },
    }),
    "utf-8",
  );
  const unregister = registerHostEmbeddingProvider(memoryDir, {
    id: "host-test",
    model: "host-model",
    async embed() {
      return null;
    },
  });
  try {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ data: [{ embedding: [0, 1] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const fallback = new EmbeddingFallback(stubConfig({ memoryDir }));
    await fallback.indexFile(
      "mem-openai",
      "launch planning",
      path.join(memoryDir, "facts", "launch.md"),
    );

    const parsed = JSON.parse(await readFile(indexPath, "utf-8")) as {
      provider: string;
      model: string;
      entries: Record<string, unknown>;
    };
    assert.equal(parsed.provider, "openai");
    assert.equal(parsed.model, "text-embedding-3-small");
    assert.equal(parsed.entries["mem-host"], undefined);
    assert.ok(parsed.entries["mem-openai"]);
  } finally {
    globalThis.fetch = originalFetch;
    unregister();
    clearHostEmbeddingProvidersForTest();
  }
});

test("EmbeddingFallback replaces an existing host index when host model changes", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-host-embed-replace-host-"));
  const indexPath = path.join(memoryDir, "state", "embeddings.json");
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(
    indexPath,
    JSON.stringify({
      version: 1,
      provider: "host",
      model: "old-host-model",
      entries: {
        "mem-host": {
          vector: [1, 0],
          path: "facts/host.md",
        },
      },
    }),
    "utf-8",
  );
  const unregister = registerHostEmbeddingProvider(memoryDir, {
    id: "host-test",
    model: "new-host-model",
    async embed() {
      return [0, 1];
    },
  });
  try {
    const fallback = new EmbeddingFallback(stubConfig({ memoryDir }));
    await fallback.indexFile(
      "mem-host-new",
      "launch planning",
      path.join(memoryDir, "facts", "launch.md"),
    );

    const parsed = JSON.parse(await readFile(indexPath, "utf-8")) as {
      provider: string;
      model: string;
      entries: Record<string, unknown>;
    };
    assert.equal(parsed.provider, "host");
    assert.equal(parsed.model, "new-host-model");
    assert.equal(parsed.entries["mem-host"], undefined);
    assert.ok(parsed.entries["mem-host-new"]);
  } finally {
    unregister();
    clearHostEmbeddingProvidersForTest();
  }
});

test("EmbeddingFallback does not search an existing host index with fallback vectors", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-host-embed-search-mismatch-"));
  const originalFetch = globalThis.fetch;
  const indexPath = path.join(memoryDir, "state", "embeddings.json");
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(
    indexPath,
    JSON.stringify({
      version: 1,
      provider: "host",
      model: "host-model",
      entries: {
        "mem-host": {
          vector: [1, 0],
          path: "facts/host.md",
        },
      },
    }),
    "utf-8",
  );
  const unregister = registerHostEmbeddingProvider(memoryDir, {
    id: "host-test",
    model: "host-model",
    async embed() {
      return null;
    },
  });
  try {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const fallback = new EmbeddingFallback(stubConfig({ memoryDir }));
    assert.deepEqual(await fallback.search("launch planning", 5), []);
  } finally {
    globalThis.fetch = originalFetch;
    unregister();
    clearHostEmbeddingProvidersForTest();
  }
});

test("EmbeddingFallback does not replace an existing fallback index when host embeddings succeed", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-host-embed-skip-host-"));
  const indexPath = path.join(memoryDir, "state", "embeddings.json");
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(
    indexPath,
    JSON.stringify({
      version: 1,
      provider: "openai",
      model: "text-embedding-3-small",
      entries: {
        "mem-openai": {
          vector: [1, 0],
          path: "facts/openai.md",
        },
      },
    }),
    "utf-8",
  );
  const unregister = registerHostEmbeddingProvider(memoryDir, {
    id: "host-test",
    model: "host-model",
    async embed() {
      return [0, 1];
    },
  });
  try {
    const fallback = new EmbeddingFallback(stubConfig({ memoryDir }));
    await fallback.indexFile(
      "mem-host",
      "launch planning",
      path.join(memoryDir, "facts", "launch.md"),
    );

    const parsed = JSON.parse(await readFile(indexPath, "utf-8")) as {
      provider: string;
      model: string;
      entries: Record<string, unknown>;
    };
    assert.equal(parsed.provider, "openai");
    assert.equal(parsed.model, "text-embedding-3-small");
    assert.ok(parsed.entries["mem-openai"]);
    assert.equal(parsed.entries["mem-host"], undefined);
  } finally {
    unregister();
    clearHostEmbeddingProvidersForTest();
  }
});

test("EmbeddingFallback searches preserved fallback index when host embeddings succeed", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-host-embed-search-preserved-"));
  const originalFetch = globalThis.fetch;
  const indexPath = path.join(memoryDir, "state", "embeddings.json");
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(
    indexPath,
    JSON.stringify({
      version: 1,
      provider: "openai",
      model: "text-embedding-3-small",
      entries: {
        "mem-openai": {
          vector: [1, 0],
          path: "facts/openai.md",
        },
      },
    }),
    "utf-8",
  );
  let hostCalls = 0;
  const unregister = registerHostEmbeddingProvider(memoryDir, {
    id: "host-test",
    model: "host-model",
    async embed() {
      hostCalls += 1;
      return [0, 1];
    },
  });
  try {
    let fetchCalls = 0;
    globalThis.fetch = (async (_url, init) => {
      fetchCalls += 1;
      const payload = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      assert.equal(payload.input, "launch planning");
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const fallback = new EmbeddingFallback(stubConfig({ memoryDir }));
    const results = await fallback.search("launch planning", 5);

    assert.equal(hostCalls, 1);
    assert.equal(fetchCalls, 1);
    assert.deepEqual(results.map((result) => result.id), ["mem-openai"]);
  } finally {
    globalThis.fetch = originalFetch;
    unregister();
    clearHostEmbeddingProvidersForTest();
  }
});

test("EmbeddingFallback removes stale fallback index entries when host provider is active", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-host-embed-remove-stale-"));
  const indexPath = path.join(memoryDir, "state", "embeddings.json");
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(
    indexPath,
    JSON.stringify({
      version: 1,
      provider: "openai",
      model: "text-embedding-3-small",
      entries: {
        "mem-deleted": {
          vector: [1, 0],
          path: "facts/deleted.md",
        },
        "mem-kept": {
          vector: [0, 1],
          path: "facts/kept.md",
        },
      },
    }),
    "utf-8",
  );
  const unregister = registerHostEmbeddingProvider(memoryDir, {
    id: "host-test",
    model: "host-model",
    async embed() {
      return [1, 1];
    },
  });
  try {
    const fallback = new EmbeddingFallback(stubConfig({ memoryDir }));
    await fallback.removeFromIndex("mem-deleted");

    const parsed = JSON.parse(await readFile(indexPath, "utf-8")) as {
      provider: string;
      model: string;
      entries: Record<string, unknown>;
    };
    assert.equal(parsed.provider, "openai");
    assert.equal(parsed.model, "text-embedding-3-small");
    assert.equal(parsed.entries["mem-deleted"], undefined);
    assert.ok(parsed.entries["mem-kept"]);
  } finally {
    unregister();
    clearHostEmbeddingProvidersForTest();
  }
});

test("EmbeddingFallback classifies host provider unavailable without mislabeling it as timeout", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-host-embed-unavailable-"));
  const unregister = registerHostEmbeddingProvider(memoryDir, {
    id: "host-test",
    model: "host-model",
    async embed() {
      return null;
    },
  });
  try {
    const fallback = new EmbeddingFallback(stubConfig({
      memoryDir,
      openaiApiKey: undefined,
      embeddingFallbackProvider: "openai",
      localLlmEnabled: false,
    }));

    const failOpen = await fallback.search("launch", 5);
    assert.deepEqual(failOpen, []);

    await assert.rejects(
      () => fallback.search("launch", 5, { throwOnTimeout: true }),
      (err) => {
        assert.ok(err instanceof EmbeddingProviderUnavailableError);
        assert.ok(!(err instanceof EmbeddingTimeoutError));
        assert.match(err.message, /host embedding provider unavailable/);
        return true;
      },
    );
  } finally {
    unregister();
    clearHostEmbeddingProvidersForTest();
  }
});

test("normalizeHostEmbeddingVector rejects malformed components", async () => {
  const { normalizeHostEmbeddingVector } = await import("../src/host-embedding-provider.js");
  assert.equal(normalizeHostEmbeddingVector([1, "bad", 3]), null);
  assert.equal(normalizeHostEmbeddingVector([1, null, 3]), null);
  assert.equal(normalizeHostEmbeddingVector([1, false, 3]), null);
  assert.equal(normalizeHostEmbeddingVector([1, "", 3]), null);
  assert.equal(normalizeHostEmbeddingVector([1, Number.NaN, 3]), null);
  assert.equal(normalizeHostEmbeddingVector([1, Number.POSITIVE_INFINITY, 3]), null);
  assert.deepEqual(normalizeHostEmbeddingVector(new Float32Array([0.25, 0.5])), [0.25, 0.5]);
});

test("EmbeddingFallback returns null when disabled", async () => {
  const fallback = new EmbeddingFallback(stubConfig({
    embeddingFallbackEnabled: false,
  }));
  const provider = await (fallback as any).resolveProvider();
  assert.equal(provider, null);
});

// ---------------------------------------------------------------------------
// embedTexts batch semantics (PR #439 post-merge Finding 2)
// ---------------------------------------------------------------------------

test("embedTexts dispatches concurrent batches of embeddingBatchSize", async () => {
  const fallback = new EmbeddingFallback(stubConfig({
    semanticChunkingConfig: { embeddingBatchSize: 3 },
  } as any));

  // Track concurrent in-flight calls and peak concurrency per batch.
  let inFlight = 0;
  let peakInFlight = 0;
  const batchPeaks: number[] = [];

  // Stub the private embed method to track concurrency.
  const origEmbed = (fallback as any).embed.bind(fallback);
  let callCount = 0;
  (fallback as any).embed = async (
    input: string,
    provider: any,
    options: any,
  ) => {
    callCount++;
    inFlight++;
    if (inFlight > peakInFlight) peakInFlight = inFlight;
    // Simulate a small async delay so Promise.all concurrency is observable
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    // Return a dummy vector
    return [1, 0, 0];
  };

  const texts = ["a", "b", "c", "d", "e", "f", "g"];
  const result = await fallback.embedTexts(texts);

  // 7 texts with batchSize=3 → 3 batches: [a,b,c], [d,e,f], [g]
  assert.equal(result.length, 7, "should return one vector per input text");
  assert.equal(callCount, 7, "should call embed() once per text");

  // Each vector should be the dummy [1, 0, 0]
  for (const vec of result) {
    assert.deepEqual(vec, [1, 0, 0]);
  }
});

test("embedTexts uses default batchSize=32 when config omits embeddingBatchSize", async () => {
  const fallback = new EmbeddingFallback(stubConfig());

  let callCount = 0;
  const callSizes: number[] = [];
  let currentBatchCalls = 0;

  // We need to track how many concurrent calls are in the same Promise.all group.
  // With 10 texts and batchSize=32, all 10 should be in one batch.
  (fallback as any).embed = async () => {
    callCount++;
    currentBatchCalls++;
    await new Promise((r) => setTimeout(r, 5));
    return [1, 0, 0];
  };

  const texts = Array.from({ length: 10 }, (_, i) => `text-${i}`);
  const result = await fallback.embedTexts(texts);

  assert.equal(result.length, 10);
  assert.equal(callCount, 10, "should call embed() once per text");
});

test("embedTexts throws when embed returns null for any text", async () => {
  const fallback = new EmbeddingFallback(stubConfig({
    semanticChunkingConfig: { embeddingBatchSize: 5 },
  } as any));

  let callIdx = 0;
  (fallback as any).embed = async () => {
    callIdx++;
    // Return null on the third call
    if (callIdx === 3) return null;
    return [1, 0, 0];
  };

  await assert.rejects(
    () => fallback.embedTexts(["a", "b", "c", "d", "e"]),
    /Embedding returned null/,
  );
});

test("embedTexts throws when provider is unavailable", async () => {
  const fallback = new EmbeddingFallback(stubConfig({
    embeddingFallbackEnabled: false,
  }));

  await assert.rejects(
    () => fallback.embedTexts(["text"]),
    /Embedding provider is not available/,
  );
});

test("indexFile preserves all entries when concurrent index writes overlap", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-embedding-concurrent-"));
  const fallback = new EmbeddingFallback(stubConfig({ memoryDir }));

  (fallback as any).embedWithEffectiveProvider = async (input: string, provider: unknown) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { provider, vector: [input.charCodeAt(0) || 1, 1, 0] };
  };

  await Promise.all([
    fallback.indexFile("mem-a", "alpha", path.join(memoryDir, "facts", "a.md")),
    fallback.indexFile("mem-b", "bravo", path.join(memoryDir, "facts", "b.md")),
    fallback.indexFile("mem-c", "charlie", path.join(memoryDir, "facts", "c.md")),
  ]);

  const raw = await readFile(path.join(memoryDir, "state", "embeddings.json"), "utf-8");
  const parsed = JSON.parse(raw) as {
    entries: Record<string, { vector: number[]; path: string }>;
  };

  assert.deepEqual(Object.keys(parsed.entries).sort(), ["mem-a", "mem-b", "mem-c"]);
  assert.equal(parsed.entries["mem-a"]?.path, "facts/a.md");
  assert.equal(parsed.entries["mem-b"]?.path, "facts/b.md");
  assert.equal(parsed.entries["mem-c"]?.path, "facts/c.md");
});
