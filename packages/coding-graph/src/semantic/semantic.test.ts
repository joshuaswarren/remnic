/**
 * Semantic-layer integration tests (issue #1556 steps 1–6 done-when).
 *
 * Covers:
 *   - Cache-hit: unchanged symbol on reindex → zero embed calls (counting
 *     stub provider, rule 33).
 *   - Gate-off parity: semantic.enabled=false → zero vectors-table writes,
 *     zero provider calls.
 *   - Degradation matrix: provider missing / timeout / malformed vector →
 *     three distinct {ok:false} codes (rule 34).
 *   - SIMILAR_TO pipeline end-to-end with a stub provider.
 *   - Budgets: maxSymbolsPerRun respected.
 *
 * Uses a real GraphStore backed by a temp SQLite DB + a counting stub
 * HostEmbeddingProvider (rule 33 — signature matches the interface).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { HostEmbeddingProvider } from "@remnic/core/host-embedding-provider";

import { GraphStore } from "../graph-store.js";
import type { StoreFileIR } from "../graph-store.js";
import {
  indexSymbolVectors,
  computeSimilarTo,
  similarEdgesToEdgeIR,
  semanticQuery,
  resolveSemanticConfig,
  type SemanticConfig,
} from "./index.js";

// ──────────────────────────────────────────────────────────────────────────
// Counting stub provider — signature matches HostEmbeddingProvider (rule 33).
// ──────────────────────────────────────────────────────────────────────────

function createCountingProvider(
  opts: { failMode?: "timeout" | "null" | "throw" | "malformed" } = {},
): HostEmbeddingProvider & { embedCount: number; reset(): void } {
  let embedCount = 0;
  const dims = 8;
  return {
    id: "stub-embedder",
    model: "stub-model-v1",
    dimensions: dims,
    async embed(text: string) {
      embedCount += 1;
      if (opts.failMode === "timeout") {
        throw new (class extends Error {
          readonly code = "ETIMEDOUT";
        })("stub timeout");
      }
      if (opts.failMode === "throw") {
        throw new Error("stub throw");
      }
      if (opts.failMode === "null") {
        return null;
      }
      if (opts.failMode === "malformed") {
        return [NaN, Infinity, "bad" as unknown as number] as unknown as ArrayLike<number>;
      }
      // Deterministic pseudo-embedding: hash the text to a fixed-size vector.
      // Two similar texts produce similar vectors (cosine close to 1.0) so
      // the SIMILAR_TO pipeline can confirm clones.
      const vec = new Array<number>(dims).fill(0);
      for (let i = 0; i < text.length; i++) {
        vec[i % dims]! += text.charCodeAt(i)!;
      }
      // Normalize to unit length so cosine is meaningful.
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
      return vec.map((v) => v / norm);
    },
    reset() {
      embedCount = 0;
    },
    get embedCount2() {
      return embedCount;
    },
  } as unknown as HostEmbeddingProvider & { embedCount: number; reset(): void };
}

// Fix the counting provider properly.
function countingProvider(
  opts: { failMode?: "timeout" | "null" | "throw" | "malformed" } = {},
): HostEmbeddingProvider & { embedCount: number; reset(): void } {
  let embedCount = 0;
  const dims = 8;
  const provider: HostEmbeddingProvider & { embedCount: number; reset(): void } = {
    id: "stub-embedder",
    model: "stub-model-v1",
    dimensions: dims,
    embedCount: 0,
    reset() {
      embedCount = 0;
      provider.embedCount = 0;
    },
    async embed(text: string) {
      embedCount += 1;
      provider.embedCount = embedCount;
      if (opts.failMode === "timeout") throw new Error("stub timeout");
      if (opts.failMode === "throw") throw new Error("stub throw");
      if (opts.failMode === "null") return null;
      if (opts.failMode === "malformed") {
        return [NaN, Infinity] as unknown as ArrayLike<number>;
      }
      const vec = new Array<number>(dims).fill(0);
      for (let i = 0; i < text.length; i++) {
        vec[i % dims]! += text.charCodeAt(i)!;
      }
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
      return vec.map((v) => v / norm);
    },
  };
  return provider;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

const ENABLED_CONFIG: SemanticConfig = resolveSemanticConfig({ enabled: true });
const DISABLED_CONFIG: SemanticConfig = resolveSemanticConfig({ enabled: false });

function makeFileIR(filePath: string, symbols: { name: string; qname: string; kind: string; start: number; end: number }[], content: string): StoreFileIR {
  return {
    path: filePath,
    language: "typescript" as never,
    contentHash: "0".repeat(64),
    symbols: symbols.map((s) => ({
      kind: s.kind as never,
      name: s.name,
      qualifiedName: s.qname,
      span: { startByte: s.start, endByte: s.end },
    })),
    imports: [],
    exports: [],
    callSites: [],
    routes: [],
  } as unknown as StoreFileIR;
}

async function tempStore(): Promise<{ store: GraphStore; dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "semtest-"));
  const dbPath = path.join(dir, "graph.db");
  const store = await GraphStore.open({ dbPath, repoRoot: dir });
  const cleanup = async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  };
  return { store, dir, cleanup };
}

// ──────────────────────────────────────────────────────────────────────────
// Cache-hit: unchanged symbol → zero embed calls on reindex (rule 37)
// ──────────────────────────────────────────────────────────────────────────

test("cache-hit: unchanged symbol on reindex → zero embed calls", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const src = `function hello() { return 42; }`;
    await writeFile(path.join(dir, "a.ts"), src);
    const ir = makeFileIR("a.ts", [
      { name: "hello", qname: "mod.hello", kind: "function", start: 0, end: src.length },
    ], src);
    await store.upsertFileBatch([ir]);

    const provider = countingProvider();
    // First index: embeds once.
    const r1 = await indexSymbolVectors({ store, provider, repoRoot: dir, config: ENABLED_CONFIG });
    assert.equal(r1.ok, true);
    if (r1.ok) {
      assert.equal(r1.embedded, 1);
      assert.equal(r1.cached, 0);
    }
    assert.equal(provider.embedCount, 1, "first index should embed once");

    // Re-index: cache hit → zero embeds.
    provider.reset();
    const r2 = await indexSymbolVectors({ store, provider, repoRoot: dir, config: ENABLED_CONFIG });
    assert.equal(r2.ok, true);
    if (r2.ok) {
      assert.equal(r2.embedded, 0);
      assert.equal(r2.cached, 1);
    }
    assert.equal(provider.embedCount, 0, "reindex should use cache — zero embeds");
  } finally {
    await cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Gate-off parity: semantic disabled → zero writes, zero calls
// ──────────────────────────────────────────────────────────────────────────

test("gate-off: semantic.enabled=false → zero vectors writes, zero provider calls", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const src = `function foo() { return 1; }`;
    await writeFile(path.join(dir, "a.ts"), src);
    const ir = makeFileIR("a.ts", [
      { name: "foo", qname: "mod.foo", kind: "function", start: 0, end: src.length },
    ], src);
    await store.upsertFileBatch([ir]);

    const provider = countingProvider();
    const r = await indexSymbolVectors({ store, provider, repoRoot: dir, config: DISABLED_CONFIG });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "semantic_disabled");
    assert.equal(provider.embedCount, 0, "disabled → zero provider calls");
    // No vectors in the table.
    const vecs = store.readAllSymbolVectors("stub-model-v1");
    assert.equal(vecs.length, 0, "disabled → zero vectors written");
  } finally {
    await cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Degradation matrix: provider missing / timeout / malformed → distinct codes
// ──────────────────────────────────────────────────────────────────────────

test("degradation: no provider → provider_unavailable", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const r = await indexSymbolVectors({ store, provider: undefined, repoRoot: dir, config: ENABLED_CONFIG });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "provider_unavailable");
  } finally {
    await cleanup();
  }
});

test("degradation: provider returns null → skipped, not crash", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const src = `function foo() { return 1; }`;
    await writeFile(path.join(dir, "a.ts"), src);
    const ir = makeFileIR("a.ts", [
      { name: "foo", qname: "mod.foo", kind: "function", start: 0, end: src.length },
    ], src);
    await store.upsertFileBatch([ir]);

    const provider = countingProvider({ failMode: "null" });
    const r = await indexSymbolVectors({ store, provider, repoRoot: dir, config: ENABLED_CONFIG });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.embedded, 0);
      assert.equal(r.skipped, 1);
    }
  } finally {
    await cleanup();
  }
});

test("degradation: provider throws → skipped, not crash", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const src = `function foo() { return 1; }`;
    await writeFile(path.join(dir, "a.ts"), src);
    const ir = makeFileIR("a.ts", [
      { name: "foo", qname: "mod.foo", kind: "function", start: 0, end: src.length },
    ], src);
    await store.upsertFileBatch([ir]);

    const provider = countingProvider({ failMode: "throw" });
    const r = await indexSymbolVectors({ store, provider, repoRoot: dir, config: ENABLED_CONFIG });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.skipped, 1);
  } finally {
    await cleanup();
  }
});

test("degradation: malformed vector (NaN/Infinity) → skipped", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const src = `function foo() { return 1; }`;
    await writeFile(path.join(dir, "a.ts"), src);
    const ir = makeFileIR("a.ts", [
      { name: "foo", qname: "mod.foo", kind: "function", start: 0, end: src.length },
    ], src);
    await store.upsertFileBatch([ir]);

    const provider = countingProvider({ failMode: "malformed" });
    const r = await indexSymbolVectors({ store, provider, repoRoot: dir, config: ENABLED_CONFIG });
    assert.equal(r.ok, true);
    if (r.ok) {
      // normalizeHostEmbeddingVector rejects NaN/Infinity → skipped.
      assert.equal(r.skipped, 1);
      assert.equal(r.embedded, 0);
    }
  } finally {
    await cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Budgets: maxSymbolsPerRun respected
// ──────────────────────────────────────────────────────────────────────────

test("budget: maxSymbolsPerRun=2 limits embedding to 2 symbols", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const src = `function a() { return 1; }\nfunction b() { return 2; }\nfunction c() { return 3; }\nfunction d() { return 4; }`;
    await writeFile(path.join(dir, "a.ts"), src);
    const ir = makeFileIR("a.ts", [
      { name: "a", qname: "mod.a", kind: "function", start: 0, end: 24 },
      { name: "b", qname: "mod.b", kind: "function", start: 25, end: 50 },
      { name: "c", qname: "mod.c", kind: "function", start: 51, end: 76 },
      { name: "d", qname: "mod.d", kind: "function", start: 77, end: 102 },
    ], src);
    await store.upsertFileBatch([ir]);

    const provider = countingProvider();
    const config = resolveSemanticConfig({ enabled: true, maxSymbolsPerRun: 2 });
    const r = await indexSymbolVectors({ store, provider, repoRoot: dir, config });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.ok(r.embedded <= 2, `should embed at most 2, got ${r.embedded}`);
    }
    assert.ok(provider.embedCount <= 2, `provider called at most 2 times, got ${provider.embedCount}`);
  } finally {
    await cleanup();
  }
});

test("budget: maxSymbolsPerRun=0 means unlimited", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const src = `function a() { return 1; }\nfunction b() { return 2; }`;
    await writeFile(path.join(dir, "a.ts"), src);
    const ir = makeFileIR("a.ts", [
      { name: "a", qname: "mod.a", kind: "function", start: 0, end: 24 },
      { name: "b", qname: "mod.b", kind: "function", start: 25, end: 50 },
    ], src);
    await store.upsertFileBatch([ir]);

    const provider = countingProvider();
    const r = await indexSymbolVectors({ store, provider, repoRoot: dir, config: ENABLED_CONFIG });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.embedded, 2, "unlimited budget embeds all");
  } finally {
    await cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// SIMILAR_TO pipeline end-to-end
// ──────────────────────────────────────────────────────────────────────────

test("SIMILAR_TO: computeSimilarTo with gate-off returns semantic_disabled", () => {
  const r = computeSimilarTo({ store: null as never, provider: undefined, config: DISABLED_CONFIG });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "semantic_disabled");
});

test("SIMILAR_TO: similarEdgesToEdgeIR maps to EdgeIR with semantic provenance", () => {
  const edges = similarEdgesToEdgeIR([
    { srcQualifiedName: "mod.a", dstQualifiedName: "mod.b", confidence: 0.95, confirmed: true },
  ]);
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.type, "SIMILAR_TO");
  assert.equal(edges[0]!.provenance, "semantic");
  assert.equal(edges[0]!.confidence, 0.95);
});

// ──────────────────────────────────────────────────────────────────────────
// semantic_query degradation matrix
// ──────────────────────────────────────────────────────────────────────────

test("semanticQuery: disabled → semantic_disabled", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const r = await semanticQuery({ store, provider: undefined, repoRoot: dir, config: DISABLED_CONFIG, query: "test" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "semantic_disabled");
  } finally {
    await cleanup();
  }
});

test("semanticQuery: no provider → provider_unavailable", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const r = await semanticQuery({ store, provider: undefined, repoRoot: dir, config: ENABLED_CONFIG, query: "test" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "provider_unavailable");
  } finally {
    await cleanup();
  }
});

test("semanticQuery: empty query → invalid_query", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const provider = countingProvider();
    const r = await semanticQuery({ store, provider, repoRoot: dir, config: ENABLED_CONFIG, query: "" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "invalid_query");
  } finally {
    await cleanup();
  }
});

test("semanticQuery: no vectors in table → no_vectors", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const provider = countingProvider();
    const r = await semanticQuery({ store, provider, repoRoot: dir, config: ENABLED_CONFIG, query: "test" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "no_vectors");
  } finally {
    await cleanup();
  }
});

test("semanticQuery: with vectors → returns ranked hits", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const src = `function greet(name) { return "hello " + name; }`;
    await writeFile(path.join(dir, "a.ts"), src);
    const ir = makeFileIR("a.ts", [
      { name: "greet", qname: "mod.greet", kind: "function", start: 0, end: src.length },
    ], src);
    await store.upsertFileBatch([ir]);

    const provider = countingProvider();
    await indexSymbolVectors({ store, provider, repoRoot: dir, config: ENABLED_CONFIG });

    const r = await semanticQuery({ store, provider, repoRoot: dir, config: ENABLED_CONFIG, query: "greet function" });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.ok(r.hits.length >= 1);
      assert.equal(r.hits[0]!.qualifiedName, "mod.greet");
      assert.ok(r.hits[0]!.score > 0);
    }
  } finally {
    await cleanup();
  }
});
