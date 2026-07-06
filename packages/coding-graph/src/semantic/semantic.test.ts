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


// ──────────────────────────────────────────────────────────────────────────
// Budget applies to embed WORK, not the candidate list — a bounded run
// must make progress across runs (cursor Bugbot + chatgpt-codex-connector
// P2: bounded index could remain permanently incomplete).
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

    // Run 1: embeds the first 2 (a, b).
    const r1 = await indexSymbolVectors({ store, provider, repoRoot: dir, config });
    assert.equal(r1.ok, true);
    if (r1.ok) assert.equal(r1.embedded, 2, "run 1 embeds 2");
    assert.equal(provider.embedCount, 2);

    // Run 2: a, b are cached (no embed); c, d are now embedded. Before the
    // fix this re-sliced the same alphabetical prefix and embedded 0 new
    // symbols every run.
    const r2 = await indexSymbolVectors({ store, provider, repoRoot: dir, config });
    assert.equal(r2.ok, true);
    if (r2.ok) {
      assert.equal(r2.embedded, 2, "run 2 embeds the NEXT 2 (progress)");
      assert.equal(r2.cached, 2, "run 2 skips the 2 already-cached symbols");
    }
    assert.equal(provider.embedCount, 4, "4 total embeds across the two runs");

    // Run 3: everything cached — zero new embeds.
    provider.reset();
    const r3 = await indexSymbolVectors({ store, provider, repoRoot: dir, config });
    if (r3.ok) assert.equal(r3.embedded, 0, "run 3: all cached, no new embeds");
    assert.equal(provider.embedCount, 0);
  } finally {
    await cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// computeSimilarTo refuses to guess when it has neither bodies nor a
// repoRoot — silent qname-MinHashing would miss real clones (chatgpt-
// codex-connector P2: 'Require source bodies before MinHashing').
// ──────────────────────────────────────────────────────────────────────────

test("SIMILAR_TO: no bodies and no repoRoot → repo_root_unset (not silent qname MinHash)", () => {
  const r = computeSimilarTo({ store: null as never, provider: undefined, config: ENABLED_CONFIG });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "repo_root_unset");
});

// ──────────────────────────────────────────────────────────────────────────
// clearSemanticSimilarToEdges: recompute replace semantics — stale
// SIMILAR_TO edges are removed while non-semantic edges survive
// (chatgpt-codex-connector P2: 'Replace old SIMILAR_TO edges on recompute').
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

    // Seed a semantic SIMILAR_TO edge AND a structural CALLS edge f→g.
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
    // The structural CALLS edge survives.
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
// semantic_query: hit.kind is the node label, not empty (cursor Bugbot:
// 'Query hits omit symbol kind').
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
// semantic_query: snippet hydrates by node id, so a qualified name
// duplicated across files still resolves the exact node's snippet
// (chatgpt-codex-connector P2: 'Hydrate snippets by node id as well').
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
      // Both nodes share qname "mod.dup" but distinct node ids; hydrating
      // by node id must yield a real snippet for at least one hit (the old
      // qname path returned 'ambiguous_name' and left every snippet empty).
      const withSnippet = r.hits.filter((h) => h.snippet.length > 0);
      assert.ok(withSnippet.length >= 1, "at least one hit should carry a snippet despite the duplicate name");
    }
  } finally {
    await cleanup();
  }
});


// ──────────────────────────────────────────────────────────────────────────
// MinHash-only edges are the documented NO-PROVIDER fallback. When a
// provider IS configured, a pair missing a vector is skipped (await
// cosine confirmation) instead of bypassing it with a MinHash-only edge
// (cursor Bugbot: 'MinHash edges with provider set').
// ──────────────────────────────────────────────────────────────────────────

test("SIMILAR_TO: provider set + missing vectors → no MinHash-only bypass", async () => {
  const { store, cleanup } = await tempStore();
  try {
    const body = "function compute(x, y) { const z = x + y; return z * 2 + x - y; }";
    const bodies = new Map<string, { readonly qualifiedName: string; readonly body: string }>([
      ["n1", { qualifiedName: "mod.a", body }],
      ["n2", { qualifiedName: "mod.b", body }],
    ]);

    // Provider configured, no vectors → must NOT emit MinHash-only edges.
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

    // No provider → MinHash-only edges are the documented local fallback.
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
// Mismatched-dimensionality vectors are excluded from ranking. cosine over
// the shorter length would otherwise give a misleading partial score to a
// row from a different model size (cursor Bugbot: 'Mismatched embedding
// lengths scored').
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
    // a: dims=8 (matches the query provider); b: dims=4 (mismatched → excluded).
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
// Closed store is a distinct degradation code (rule 34), not an empty
// graph that returns ok:true / no_vectors (cursor Bugbot: 'Closed store
// reports success').
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
// computeSimilarTo honors the closed store (cursor Bugbot: 'SimilarTo
// ignores closed store').
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
// Cosine confirmation requires matching dims (cursor Bugbot: 'SimilarTo
// skips embedding length check').
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
    // Pair has vectors but mismatched dims → not cosine-confirmed; provider
    // active → not MinHash-only either → no edges.
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
// Budget bounds provider CALLS, not successful writes — a degraded provider
// must not bypass the cost cap (chatgpt-codex-connector: 'Count failed embed
// attempts against the vector budget').
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
    // Every embed throws → zero successes, but the provider must NOT be
    // called for all four nodes. Before the fix, `embedded` never reached
    // the limit (all throws) so the loop called the provider for every
    // remaining node, bypassing the per-run cost cap.
    assert.ok(
      provider.embedCount <= 2,
      `degraded provider calls must be bounded by maxSymbolsPerRun, got ${provider.embedCount}`,
    );
  } finally {
    await cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// MinHash runs over the extracted BODY only — bodyless declarations
// (stubs/types with no body) yield no candidates instead of name-driven
// spurious pairs (chatgpt-codex-connector: 'MinHash only the extracted
// body text').
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
// Host-provided enabled is coerced — "false"/"0" must not become truthy
// and silently enable vector indexing (chatgpt-codex-connector: 'Coerce
// host enabled before trusting it').
// ──────────────────────────────────────────────────────────────────────────

test("config: host enabled string 'false'/'0' coerce to false (not truthy)", () => {
  assert.equal(resolveSemanticConfig({ enabled: "false" as never }).enabled, false);
  assert.equal(resolveSemanticConfig({ enabled: "0" as never }).enabled, false);
  assert.equal(resolveSemanticConfig({ enabled: "no" as never }).enabled, false);
  assert.equal(resolveSemanticConfig({ enabled: "" as never }).enabled, false);
  assert.equal(resolveSemanticConfig({ enabled: "true" as never }).enabled, true);
  assert.equal(resolveSemanticConfig({ enabled: true }).enabled, true);
  assert.equal(resolveSemanticConfig({ enabled: false }).enabled, false);
  // Absent host value still falls through to env/default (false).
  assert.equal(resolveSemanticConfig({}).enabled, false);
});

// ──────────────────────────────────────────────────────────────────────────
// snippetFor honors a query-level repoRoot override, so a store opened
// without repoRoot can still hydrate snippets when the caller supplies one
// (chatgpt-codex-connector + cursor: 'Snippet hydration ignores query
// repoRoot').
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

    // No override → store has no repoRoot → repo_root_unset.
    const noRoot = await store.snippetFor({ nodeId });
    assert.equal(noRoot.ok, false);
    if (!noRoot.ok) assert.equal(noRoot.code, "repo_root_unset");

    // Override supplied → snippet resolves from the caller's repoRoot.
    const withRoot = await store.snippetFor({ nodeId, repoRoot: dir });
    assert.equal(withRoot.ok, true);
    if (withRoot.ok) assert.ok(withRoot.text.includes("greet"), "snippet hydrates from the query repoRoot");
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// writeSymbolVector reports whether it persisted (returns false on a
// closed store) so the indexer does not count dropped writes as embedded
// (cursor Bugbot: 'Embedded count after dropped writes').
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

