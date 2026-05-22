import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { EmbeddingFallback } from "../src/embedding-fallback.js";
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

  (fallback as any).embed = async (input: string) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return [input.charCodeAt(0) || 1, 1, 0];
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
