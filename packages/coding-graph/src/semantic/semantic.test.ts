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

import { GraphStore, nodeIdFor } from "../graph-store.js";
import type { StoreFileIR } from "../graph-store.js";
import {
  indexSymbolVectors,
  modelIdFor,
  computeSimilarTo,
  similarEdgesToEdgeIR,
  semanticQuery,
  resolveSemanticConfig,
  DEFAULT_SIMILAR_TO_THRESHOLD,
  DEFAULT_MAX_SYMBOLS_PER_RUN,
  DEFAULT_SEMANTIC_QUERY_LIMIT,
  DEFAULT_CANONICAL_BODY_LINES,
  type SemanticConfig,
} from "./index.js";

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
    const r1 = await indexSymbolVectors({ store, provider, repoRoot: dir, config: ENABLED_CONFIG });
    assert.equal(r1.ok, true);
    if (r1.ok) {
      assert.equal(r1.embedded, 1);
      assert.equal(r1.cached, 0);
    }
    assert.equal(provider.embedCount, 1, "first index should embed once");

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
    const vecs = store.readAllSymbolVectors("stub-model-v1");
    assert.equal(vecs.length, 0, "disabled → zero vectors written");
  } finally {
    await cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────────
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
      assert.equal(r.skipped, 1);
      assert.equal(r.embedded, 0);
    }
  } finally {
    await cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────────
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
// ──────────────────────────────────────────────────────────────────────────

test("SIMILAR_TO: computeSimilarTo with gate-off returns semantic_disabled", () => {
  const r = computeSimilarTo({ store: null as never, provider: undefined, config: DISABLED_CONFIG });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "semantic_disabled");
});

test("SIMILAR_TO: similarEdgesToEdgeIR maps to EdgeIR with semantic provenance + node ids", () => {
  const edges = similarEdgesToEdgeIR([
    {
      srcNodeId: "id-a",
      dstNodeId: "id-b",
      srcQualifiedName: "mod.a",
      dstQualifiedName: "mod.b",
      confidence: 0.95,
      confirmed: true,
    },
  ]);
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.type, "SIMILAR_TO");
  assert.equal(edges[0]!.provenance, "semantic");
  assert.equal(edges[0]!.confidence, 0.95);
  assert.equal(edges[0]!.srcNodeId, "id-a");
  assert.equal(edges[0]!.dstNodeId, "id-b");
});

// ──────────────────────────────────────────────────────────────────────────
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


// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("budget: bounded run makes progress across runs (not stuck on cached prefix)", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const src = "function a() { return 1; }\nfunction b() { return 2; }\nfunction c() { return 3; }\nfunction d() { return 4; }";
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

    const r1 = await indexSymbolVectors({ store, provider, repoRoot: dir, config });
    assert.equal(r1.ok, true);
    if (r1.ok) assert.equal(r1.embedded, 2, "run 1 embeds 2");
    assert.equal(provider.embedCount, 2);

    const r2 = await indexSymbolVectors({ store, provider, repoRoot: dir, config });
    assert.equal(r2.ok, true);
    if (r2.ok) {
      assert.equal(r2.embedded, 2, "run 2 embeds the NEXT 2 (progress)");
      assert.equal(r2.cached, 2, "run 2 skips the 2 already-cached symbols");
    }
    assert.equal(provider.embedCount, 4, "4 total embeds across the two runs");

    provider.reset();
    const r3 = await indexSymbolVectors({ store, provider, repoRoot: dir, config });
    if (r3.ok) assert.equal(r3.embedded, 0, "run 3: all cached, no new embeds");
    assert.equal(provider.embedCount, 0);
  } finally {
    await cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("SIMILAR_TO: no bodies and no repoRoot → repo_root_unset (not silent qname MinHash)", () => {
  const r = computeSimilarTo({ store: null as never, provider: undefined, config: ENABLED_CONFIG });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "repo_root_unset");
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("SIMILAR_TO: clearSemanticSimilarToEdges removes only semantic SIMILAR_TO edges", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const src = "function f() { return 1; }\nfunction g() { return 2; }";
    await writeFile(path.join(dir, "a.ts"), src);
    const ir = makeFileIR("a.ts", [
      { name: "f", qname: "mod.f", kind: "function", start: 0, end: 23 },
      { name: "g", qname: "mod.g", kind: "function", start: 24, end: 47 },
    ], src);
    await store.upsertFileBatch([ir]);

    await store.upsertEdges([
      { srcQualifiedName: "mod.f", dstQualifiedName: "mod.g", type: "SIMILAR_TO", confidence: 0.93, provenance: "semantic" },
      { srcQualifiedName: "mod.f", dstQualifiedName: "mod.g", type: "CALLS", confidence: 1, provenance: "heuristic" },
    ]);

    const beforeSimilar = store.traverse({ start: "mod.f", edgeTypes: ["SIMILAR_TO"], maxDepth: 1 });
    assert.equal(beforeSimilar.ok, true);
    if (beforeSimilar.ok) {
      assert.ok(beforeSimilar.hits.some((h) => h.qualifiedName === "mod.g"), "SIMILAR_TO edge present before clear");
    }

    await store.clearSemanticSimilarToEdges();

    const afterSimilar = store.traverse({ start: "mod.f", edgeTypes: ["SIMILAR_TO"], maxDepth: 1 });
    assert.equal(afterSimilar.ok, true);
    if (afterSimilar.ok) {
      assert.ok(!afterSimilar.hits.some((h) => h.qualifiedName === "mod.g"), "SIMILAR_TO edge gone after clear");
    }
    const afterCalls = store.traverse({ start: "mod.f", edgeTypes: ["CALLS"], maxDepth: 1 });
    assert.equal(afterCalls.ok, true);
    if (afterCalls.ok) {
      assert.ok(afterCalls.hits.some((h) => h.qualifiedName === "mod.g"), "CALLS edge preserved");
    }
  } finally {
    await cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("semanticQuery: hits carry the symbol kind", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const src = "function greet(name) { return 'hi ' + name; }";
    await writeFile(path.join(dir, "a.ts"), src);
    const ir = makeFileIR("a.ts", [
      { name: "greet", qname: "mod.greet", kind: "function", start: 0, end: src.length },
    ], src);
    await store.upsertFileBatch([ir]);

    const provider = countingProvider();
    await indexSymbolVectors({ store, provider, repoRoot: dir, config: ENABLED_CONFIG });

    const r = await semanticQuery({ store, provider, repoRoot: dir, config: ENABLED_CONFIG, query: "greet" });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.ok(r.hits.length >= 1);
      assert.equal(r.hits[0]!.kind, "function", "hit.kind should be the node label, not empty");
    }
  } finally {
    await cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("semanticQuery: duplicate qualified name still hydrates a snippet (by node id)", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const srcA = "function dup() { return 1; }";
    const srcB = "function dup() { return 2; }";
    await writeFile(path.join(dir, "a.ts"), srcA);
    await writeFile(path.join(dir, "b.ts"), srcB);
    await store.upsertFileBatch([
      makeFileIR("a.ts", [{ name: "dup", qname: "mod.dup", kind: "function", start: 0, end: srcA.length }], srcA),
      makeFileIR("b.ts", [{ name: "dup", qname: "mod.dup", kind: "function", start: 0, end: srcB.length }], srcB),
    ]);

    const provider = countingProvider();
    await indexSymbolVectors({ store, provider, repoRoot: dir, config: ENABLED_CONFIG });

    const r = await semanticQuery({ store, provider, repoRoot: dir, config: ENABLED_CONFIG, query: "dup" });
    assert.equal(r.ok, true);
    if (r.ok) {
      const withSnippet = r.hits.filter((h) => h.snippet.length > 0);
      assert.ok(withSnippet.length >= 1, "at least one hit should carry a snippet despite the duplicate name");
    }
  } finally {
    await cleanup();
  }
});


// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("SIMILAR_TO: provider set + missing vectors → no MinHash-only bypass", async () => {
  const { store, cleanup } = await tempStore();
  try {
    const body = "function compute(x, y) { const z = x + y; return z * 2 + x - y; }";
    const bodies = new Map<string, { readonly qualifiedName: string; readonly body: string }>([
      ["n1", { qualifiedName: "mod.a", body }],
      ["n2", { qualifiedName: "mod.b", body }],
    ]);

    const withProvider = computeSimilarTo({
      store,
      provider: countingProvider(),
      config: ENABLED_CONFIG,
      bodies,
      vectors: new Map<string, Float32Array>(),
    });
    assert.equal(withProvider.ok, true);
    if (withProvider.ok) {
      assert.equal(withProvider.minhashOnly, 0, "provider active → no MinHash-only bypass");
      assert.equal(withProvider.edges.length, 0, "no edges when vectors missing and provider active");
    }

    const noProvider = computeSimilarTo({
      store,
      provider: undefined,
      config: ENABLED_CONFIG,
      bodies,
    });
    assert.equal(noProvider.ok, true);
    if (noProvider.ok) {
      assert.ok(noProvider.minhashOnly >= 1, "no provider → MinHash-only edges emitted");
    }
  } finally {
    await cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("semanticQuery: mismatched-dims vectors are excluded from ranking", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const src = "function a() { return 1; }\nfunction b() { return 2; }";
    await writeFile(path.join(dir, "a.ts"), src);
    const ir = makeFileIR("a.ts", [
      { name: "a", qname: "mod.a", kind: "function", start: 0, end: 23 },
      { name: "b", qname: "mod.b", kind: "function", start: 24, end: 47 },
    ], src);
    await store.upsertFileBatch([ir]);

    const provider = countingProvider();
    const modelId = modelIdFor(provider);
    const idA = nodeIdFor({ qualifiedName: "mod.a", filePath: "a.ts", label: "function" });
    const idB = nodeIdFor({ qualifiedName: "mod.b", filePath: "a.ts", label: "function" });
    await store.writeSymbolVector({ nodeId: idA, modelId, contentHash: "h".repeat(64), dims: 8, vector: new Float32Array(8) });
    await store.writeSymbolVector({ nodeId: idB, modelId, contentHash: "h".repeat(64), dims: 4, vector: new Float32Array(4) });

    const r = await semanticQuery({ store, provider, repoRoot: dir, config: ENABLED_CONFIG, query: "a" });
    assert.equal(r.ok, true);
    if (r.ok) {
      const names = r.hits.map((h) => h.qualifiedName);
      assert.ok(names.includes("mod.a"), "matching-dims hit included");
      assert.ok(!names.includes("mod.b"), "mismatched-dims hit excluded");
    }
  } finally {
    await cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("closed store: indexSymbolVectors returns store_closed (not ok with zeros)", async () => {
  const { store, dir, cleanup } = await tempStore();
  await store.close();
  const r = await indexSymbolVectors({ store, provider: countingProvider(), repoRoot: dir, config: ENABLED_CONFIG });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "store_closed");
  await cleanup();
});

test("closed store: semanticQuery returns store_closed (not no_vectors)", async () => {
  const { store, dir, cleanup } = await tempStore();
  await store.close();
  const r = await semanticQuery({ store, provider: countingProvider(), repoRoot: dir, config: ENABLED_CONFIG, query: "x" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "store_closed");
  await cleanup();
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("closed store: computeSimilarTo returns store_closed", async () => {
  const { store, dir, cleanup } = await tempStore();
  await store.close();
  const r = computeSimilarTo({
    store,
    provider: undefined,
    config: ENABLED_CONFIG,
    repoRoot: dir,
    bodies: new Map(),
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "store_closed");
  await cleanup();
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("SIMILAR_TO: cosine confirmation skips mismatched-dims pairs", async () => {
  const { store, cleanup } = await tempStore();
  try {
    const body = "function compute(x, y) { const z = x + y; return z * 2; }";
    const bodies = new Map<string, { readonly qualifiedName: string; readonly body: string }>([
      ["n1", { qualifiedName: "mod.a", body }],
      ["n2", { qualifiedName: "mod.b", body }],
    ]);
    const vectors = new Map<string, Float32Array>([
      ["n1", new Float32Array(8)],
      ["n2", new Float32Array(4)], // mismatched dims
    ]);
    const r = computeSimilarTo({
      store,
      provider: countingProvider(),
      config: ENABLED_CONFIG,
      bodies,
      vectors,
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.edges.length, 0, "mismatched-dims pair must not be cosine-confirmed");
  } finally {
    await cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("budget: degraded provider cost is bounded by maxSymbolsPerRun (attempts, not successes)", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const src = "function a() { return 1; }\nfunction b() { return 2; }\nfunction c() { return 3; }\nfunction d() { return 4; }";
    await writeFile(path.join(dir, "a.ts"), src);
    const ir = makeFileIR("a.ts", [
      { name: "a", qname: "mod.a", kind: "function", start: 0, end: 24 },
      { name: "b", qname: "mod.b", kind: "function", start: 25, end: 50 },
      { name: "c", qname: "mod.c", kind: "function", start: 51, end: 76 },
      { name: "d", qname: "mod.d", kind: "function", start: 77, end: 102 },
    ], src);
    await store.upsertFileBatch([ir]);

    const provider = countingProvider({ failMode: "throw" });
    const config = resolveSemanticConfig({ enabled: true, maxSymbolsPerRun: 2 });
    const r = await indexSymbolVectors({ store, provider, repoRoot: dir, config });
    assert.equal(r.ok, true);
    assert.ok(
      provider.embedCount <= 2,
      `degraded provider calls must be bounded by maxSymbolsPerRun, got ${provider.embedCount}`,
    );
  } finally {
    await cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("SIMILAR_TO: bodyless declarations yield no MinHash candidates", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const src = "type A = string;\ntype B = number;\ntype C = boolean;";
    await writeFile(path.join(dir, "t.ts"), src);
    const ir = makeFileIR("t.ts", [
      { name: "A", qname: "mod.A", kind: "type", start: 0, end: 16 },
      { name: "B", qname: "mod.B", kind: "type", start: 17, end: 33 },
      { name: "C", qname: "mod.C", kind: "type", start: 34, end: 51 },
    ], src);
    await store.upsertFileBatch([ir]);

    const r = computeSimilarTo({ store, provider: undefined, config: ENABLED_CONFIG, repoRoot: dir });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.candidates, 0, "bodyless declarations produce no MinHash candidates");
      assert.equal(r.edges.length, 0, "no SIMILAR_TO edges from bodyless declarations");
    }
  } finally {
    await cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("config: host enabled string 'false'/'0' coerce to false (not truthy)", () => {
  assert.equal(resolveSemanticConfig({ enabled: "false" as never }).enabled, false);
  assert.equal(resolveSemanticConfig({ enabled: "0" as never }).enabled, false);
  assert.equal(resolveSemanticConfig({ enabled: "no" as never }).enabled, false);
  assert.equal(resolveSemanticConfig({ enabled: "" as never }).enabled, false);
  assert.equal(resolveSemanticConfig({ enabled: "true" as never }).enabled, true);
  assert.equal(resolveSemanticConfig({ enabled: true }).enabled, true);
  assert.equal(resolveSemanticConfig({ enabled: false }).enabled, false);
  assert.equal(resolveSemanticConfig({}).enabled, false);
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("snippetFor: query repoRoot overrides a store opened without repoRoot", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "semroot-"));
  const dbPath = path.join(dir, "graph.db");
  const store = await GraphStore.open({ dbPath }); // NO repoRoot
  try {
    const src = "function greet(name) { return 'hi ' + name; }";
    await writeFile(path.join(dir, "a.ts"), src);
    const ir = makeFileIR("a.ts", [
      { name: "greet", qname: "mod.greet", kind: "function", start: 0, end: src.length },
    ], src);
    await store.upsertFileBatch([ir]);
    const nodeId = nodeIdFor({ qualifiedName: "mod.greet", filePath: "a.ts", label: "function" });

    const noRoot = await store.snippetFor({ nodeId });
    assert.equal(noRoot.ok, false);
    if (!noRoot.ok) assert.equal(noRoot.code, "repo_root_unset");

    const withRoot = await store.snippetFor({ nodeId, repoRoot: dir });
    assert.equal(withRoot.ok, true);
    if (withRoot.ok) assert.ok(withRoot.text.includes("greet"), "snippet hydrates from the query repoRoot");
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("writeSymbolVector: returns false on a closed store (write dropped)", async () => {
  const { store, cleanup } = await tempStore();
  await store.close();
  const persisted = await store.writeSymbolVector({
    nodeId: "deadbeef",
    modelId: "m",
    contentHash: "h".repeat(64),
    dims: 8,
    vector: new Float32Array(8),
  });
  assert.equal(persisted, false, "closed store must report the write as not persisted");
  await cleanup();
});


// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("config: unknown enabled strings fail closed to false", () => {
  assert.equal(resolveSemanticConfig({ enabled: "on" as never }).enabled, true);
  assert.equal(resolveSemanticConfig({ enabled: "yes" as never }).enabled, true);
  assert.equal(resolveSemanticConfig({ enabled: "true" as never }).enabled, true);
  assert.equal(resolveSemanticConfig({ enabled: "disabled" as never }).enabled, false);
  assert.equal(resolveSemanticConfig({ enabled: "off" as never }).enabled, false);
  assert.equal(resolveSemanticConfig({ enabled: "maybe" as never }).enabled, false);
  assert.equal(resolveSemanticConfig({ enabled: "enabled" as never }).enabled, false);
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("config: malformed host numbers fall back to default (no NaN)", () => {
  const cfg = resolveSemanticConfig({
    enabled: true,
    maxSymbolsPerRun: "abc" as never,
    similarToThreshold: "xyz" as never,
  });
  assert.equal(Number.isNaN(cfg.maxSymbolsPerRun), false, "maxSymbolsPerRun must not be NaN");
  assert.equal(Number.isNaN(cfg.similarToThreshold), false, "similarToThreshold must not be NaN");
  assert.equal(cfg.maxSymbolsPerRun, DEFAULT_MAX_SYMBOLS_PER_RUN);
  assert.equal(cfg.similarToThreshold, DEFAULT_SIMILAR_TO_THRESHOLD);
  const cfg2 = resolveSemanticConfig({ enabled: true, maxSymbolsPerRun: "5" as never });
  assert.equal(cfg2.maxSymbolsPerRun, 5);
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("cache-hit: provider without dimensions still caches on reindex", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const src = `function cached() { return 1; }`;
    await writeFile(path.join(dir, "a.ts"), src);
    const ir = makeFileIR("a.ts", [
      { name: "cached", qname: "mod.cached", kind: "function", start: 0, end: src.length },
    ], src);
    await store.upsertFileBatch([ir]);

    // Provider that does NOT declare `dimensions` (the field is optional).
    let calls = 0;
    const provider = {
      id: "nodims-embedder",
      model: "nodims-model",
      async embed() {
        calls += 1;
        return [1, 0, 0, 0, 0, 0, 0, 0];
      },
    } as unknown as HostEmbeddingProvider;

    const r1 = await indexSymbolVectors({ store, provider, repoRoot: dir, config: ENABLED_CONFIG });
    assert.equal(r1.ok, true);
    if (r1.ok) {
      assert.equal(r1.embedded, 1);
      assert.equal(r1.cached, 0);
    }
    assert.equal(calls, 1, "first index embeds once");

    const r2 = await indexSymbolVectors({ store, provider, repoRoot: dir, config: ENABLED_CONFIG });
    assert.equal(r2.ok, true);
    if (r2.ok) {
      assert.equal(r2.embedded, 0);
      assert.equal(r2.cached, 1);
    }
    assert.equal(calls, 1, "reindex must hit cache — no second embed");
  } finally {
    await cleanup();
  }
});


// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("SIMILAR_TO: duplicate qualified name across files persists by node id (issue #1677)", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const body = "function clone() { const x = 1; const y = 2; return x + y; }";
    await writeFile(path.join(dir, "a.ts"), body);
    await writeFile(path.join(dir, "b.ts"), body);
    await store.upsertFileBatch([
      makeFileIR("a.ts", [{ name: "clone", qname: "mod.clone", kind: "function", start: 0, end: body.length }], body),
      makeFileIR("b.ts", [{ name: "clone", qname: "mod.clone", kind: "function", start: 0, end: body.length }], body),
    ]);

    const idA = nodeIdFor({ qualifiedName: "mod.clone", filePath: "a.ts", label: "function" });
    const idB = nodeIdFor({ qualifiedName: "mod.clone", filePath: "b.ts", label: "function" });
    assert.notEqual(idA, idB, "same-qname symbols in different files have distinct node ids");

    const r = computeSimilarTo({ store, provider: undefined, config: ENABLED_CONFIG, repoRoot: dir });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("expected ok");
    assert.ok(r.edges.length >= 1, "a near-clone candidate is produced");

    const pair = r.edges.find((e) => e.srcNodeId === idA && e.dstNodeId === idB);
    assert.ok(pair, "emitted edge carries the content-derived node ids of both same-qname nodes");

    const edgeIRs = similarEdgesToEdgeIR(r.edges);
    const upsert = await store.upsertEdges(edgeIRs);
    assert.equal(upsert.ok, true);
    if (!upsert.ok) throw new Error("expected ok");
    assert.equal(upsert.persisted, edgeIRs.length, "all SIMILAR_TO edges persisted by node id");
    assert.equal(upsert.skipped, 0, "no edge dropped as an ambiguous qualified name");

    const t1 = store.traverse({ start: idA, edgeTypes: ["SIMILAR_TO"], maxDepth: 1 });
    assert.equal(t1.ok, true);
    if (t1.ok) {
      assert.ok(
        t1.hits.some((h) => h.nodeId === idB),
        "SIMILAR_TO edge connects the two distinct same-qname nodes",
      );
    }
  } finally {
    await cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

/**
 * Wrap a real store so one read method throws (simulates SQLITE_BUSY/CORRUPT)
 * while the rest of the surface (isClosed, etc.) keeps working. Used to prove
 * the tagged db_error wrapping (#1680) rather than an escaping throw.
 */
function throwingReadStore(
  base: GraphStore,
  method: "readAllSymbolVectors" | "readNodesForSemantic",
): GraphStore {
  return new Proxy(base as object, {
    get(target, prop, receiver) {
      if (prop === method) {
        return () => {
          throw new Error("stub: SQLITE_BUSY");
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as GraphStore;
}

// config: a negative/zero canonicalBodyLines must NOT clamp to 0 (which
// extractBodyText treats as unlimited, sending full symbol bodies to the
// remote embedder and defeating the cost/privacy cap). It falls back to the
// documented default instead (#1680).
test("config: negative/zero canonicalBodyLines falls back to default (not 0/unlimited)", () => {
  const neg = resolveSemanticConfig({ enabled: true, canonicalBodyLines: -5 });
  assert.equal(neg.canonicalBodyLines, DEFAULT_CANONICAL_BODY_LINES, "negative → default");
  const zero = resolveSemanticConfig({ enabled: true, canonicalBodyLines: 0 });
  assert.equal(zero.canonicalBodyLines, DEFAULT_CANONICAL_BODY_LINES, "zero → default");
  const ok = resolveSemanticConfig({ enabled: true, canonicalBodyLines: 7 });
  assert.equal(ok.canonicalBodyLines, 7, "positive value honored");
  const negStr = resolveSemanticConfig({ enabled: true, canonicalBodyLines: "-3" as never });
  assert.equal(negStr.canonicalBodyLines, DEFAULT_CANONICAL_BODY_LINES, "numeric-string -3 → default");
});

// semanticQuery: a transient store read failure (SQLITE_BUSY/CORRUPT) on
// readAllSymbolVectors maps to a tagged db_error instead of escaping as a
test("semanticQuery: transient store read error → db_error (tagged, not thrown)", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const throwing = throwingReadStore(store, "readAllSymbolVectors");
    const provider = countingProvider();
    const r = await semanticQuery({ store: throwing, provider, repoRoot: dir, config: ENABLED_CONFIG, query: "anything" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "db_error");
  } finally {
    await cleanup();
  }
});

test("indexSymbolVectors: transient store read error → db_error (tagged, not thrown)", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const throwing = throwingReadStore(store, "readNodesForSemantic");
    const provider = countingProvider();
    const r = await indexSymbolVectors({ store: throwing, provider, repoRoot: dir, config: ENABLED_CONFIG });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "db_error");
  } finally {
    await cleanup();
  }
});

test("semanticQuery: NaN/Infinity limit falls back to default (no empty/all slice)", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    // Index more symbols than DEFAULT_SEMANTIC_QUERY_LIMIT so the default
    // cap is observable (default=10; 12 symbols → NaN must NOT return 0 and
    // Infinity must NOT return 12).
    const src = Array.from({ length: 12 }, (_, i) => `function f${i}() { return ${i}; }`).join("\n");
    await writeFile(path.join(dir, "many.ts"), src);
    const symbols = Array.from({ length: 12 }, (_, i) => ({
      name: `f${i}`,
      qname: `mod.f${i}`,
      kind: "function",
      start: src.indexOf(`function f${i}`),
      end: src.length,
    }));
    for (let i = 0; i < symbols.length; i++) {
      symbols[i]!.end = i + 1 < symbols.length ? symbols[i + 1]!.start : src.length;
    }
    await store.upsertFileBatch([makeFileIR("many.ts", symbols, src)]);

    const provider = countingProvider();
    await indexSymbolVectors({ store, provider, repoRoot: dir, config: ENABLED_CONFIG });

    const nanR = await semanticQuery({ store, provider, repoRoot: dir, config: ENABLED_CONFIG, query: "function", limit: NaN });
    assert.equal(nanR.ok, true);
    if (nanR.ok) {
      assert.ok(nanR.hits.length > 0, `NaN limit must not return zero hits, got ${nanR.hits.length}`);
      assert.ok(nanR.hits.length <= DEFAULT_SEMANTIC_QUERY_LIMIT, `NaN limit capped to default, got ${nanR.hits.length}`);
    }
    const infR = await semanticQuery({ store, provider, repoRoot: dir, config: ENABLED_CONFIG, query: "function", limit: Infinity });
    assert.equal(infR.ok, true);
    if (infR.ok) {
      assert.ok(infR.hits.length <= DEFAULT_SEMANTIC_QUERY_LIMIT, `Infinity limit capped to default, got ${infR.hits.length}`);
    }
    const two = await semanticQuery({ store, provider, repoRoot: dir, config: ENABLED_CONFIG, query: "function", limit: 2 });
    assert.equal(two.ok, true);
    if (two.ok) assert.equal(two.hits.length, 2, "limit=2 returns exactly 2 hits");
  } finally {
    await cleanup();
  }
});


test("semanticQuery: a fractional limit between 0 and 1 returns at least 1 hit (not an empty slice)", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const src = Array.from({ length: 3 }, (_, i) => `function f${i}() { return ${i}; }`).join("\n");
    await writeFile(path.join(dir, "many.ts"), src);
    const symbols = Array.from({ length: 3 }, (_, i) => ({
      name: `f${i}`,
      qname: `mod.f${i}`,
      kind: "function",
      start: src.indexOf(`function f${i}`),
      end: src.length,
    }));
    for (let i = 0; i < symbols.length; i++) {
      symbols[i]!.end = i + 1 < symbols.length ? symbols[i + 1]!.start : src.length;
    }
    await store.upsertFileBatch([makeFileIR("many.ts", symbols, src)]);
    const provider = countingProvider();
    await indexSymbolVectors({ store, provider, repoRoot: dir, config: ENABLED_CONFIG });

    const r = await semanticQuery({ store, provider, repoRoot: dir, config: ENABLED_CONFIG, query: "function", limit: 0.5 });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.ok(r.hits.length >= 1, `fractional limit 0.5 must return at least 1 hit (clamped to 1), got ${r.hits.length}`);
    }
  } finally {
    await cleanup();
  }
});

test("SIMILAR_TO recompute: clearSemanticSimilarToEdges makes recompute replace-not-append (README example)", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    const bodyA = "function twin() { const x = 1; const y = 2; return x + y; }";
    const bodyB = "function twin() { const x = 1; const y = 2; return x + y; }";
    await writeFile(path.join(dir, "a.ts"), bodyA);
    await writeFile(path.join(dir, "b.ts"), bodyB);
    await store.upsertFileBatch([
      makeFileIR("a.ts", [{ name: "twin", qname: "mod.a", kind: "function", start: 0, end: bodyA.length }], bodyA),
      makeFileIR("b.ts", [{ name: "twin", qname: "mod.b", kind: "function", start: 0, end: bodyB.length }], bodyB),
    ]);

    const provider = countingProvider();
    await indexSymbolVectors({ store, provider, repoRoot: dir, config: ENABLED_CONFIG });
    const r1 = computeSimilarTo({ store, provider, repoRoot: dir, config: ENABLED_CONFIG });
    assert.equal(r1.ok, true);
    if (!r1.ok) throw new Error("expected ok");
    assert.ok(r1.edges.length >= 1, "first recompute finds the near-clone pair");
    await store.upsertEdges(similarEdgesToEdgeIR(r1.edges));

    const idA = nodeIdFor({ qualifiedName: "mod.a", filePath: "a.ts", label: "function" });
    const beforeClear = store.traverse({ start: idA, edgeTypes: ["SIMILAR_TO"], maxDepth: 1 });
    assert.ok(beforeClear.ok, "traverse ok before clear");
    if (beforeClear.ok) {
      assert.ok(beforeClear.hits.some((h) => h.qualifiedName === "mod.b"), "mod.b reachable via SIMILAR_TO before clear");
    }

    const r2 = computeSimilarTo({ store, provider, repoRoot: dir, config: ENABLED_CONFIG });
    assert.equal(r2.ok, true);
    if (!r2.ok) throw new Error("expected ok");

    await store.clearSemanticSimilarToEdges();
    const afterClear = store.traverse({ start: idA, edgeTypes: ["SIMILAR_TO"], maxDepth: 1 });
    assert.ok(afterClear.ok, "traverse ok after clear");
    if (afterClear.ok) {
      assert.ok(!afterClear.hits.some((h) => h.qualifiedName === "mod.b"), "SIMILAR_TO edge to mod.b gone after clear");
    }
    if (r2.edges.length >= 1) {
      await store.upsertEdges(similarEdgesToEdgeIR(r2.edges));
    }
    const final = store.traverse({ start: idA, edgeTypes: ["SIMILAR_TO"], maxDepth: 1 });
    assert.ok(final.ok, "traverse ok");
    if (final.ok) {
      assert.ok(final.hits.some((h) => h.qualifiedName === "mod.b"), "mod.b reachable again after recompute (replace worked)");
    }

    const failing = computeSimilarTo({ store, provider, repoRoot: dir, config: DISABLED_CONFIG });
    assert.equal(failing.ok, false);
    const preserved = store.traverse({ start: idA, edgeTypes: ["SIMILAR_TO"], maxDepth: 1 });
    assert.ok(preserved.ok, "traverse ok");
    if (preserved.ok) {
      assert.ok(preserved.hits.some((h) => h.qualifiedName === "mod.b"), "existing SIMILAR_TO edge preserved when recompute fails");
    }
  } finally {
    await cleanup();
  }
});
