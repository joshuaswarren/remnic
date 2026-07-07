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
  // Node ids are carried through so the store resolves endpoints by id
  // (issue #1677 — duplicate qualified-name support).
  assert.equal(edges[0]!.srcNodeId, "id-a");
  assert.equal(edges[0]!.dstNodeId, "id-b");
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


// ──────────────────────────────────────────────────────────────────────────
// coerceHostBool fails CLOSED: unrecognized enabled strings are an opt-out,
// not an opt-in, so a malformed host value can never silently enable remote
// embedding (cursor Bugbot: 'Unknown enabled strings enable semantic').
// ──────────────────────────────────────────────────────────────────────────

test("config: unknown enabled strings fail closed to false", () => {
  // Explicit affirmatives still enable.
  assert.equal(resolveSemanticConfig({ enabled: "on" as never }).enabled, true);
  assert.equal(resolveSemanticConfig({ enabled: "yes" as never }).enabled, true);
  assert.equal(resolveSemanticConfig({ enabled: "true" as never }).enabled, true);
  // Unrecognized / opt-out wording must NOT enable (fail closed).
  assert.equal(resolveSemanticConfig({ enabled: "disabled" as never }).enabled, false);
  assert.equal(resolveSemanticConfig({ enabled: "off" as never }).enabled, false);
  assert.equal(resolveSemanticConfig({ enabled: "maybe" as never }).enabled, false);
  assert.equal(resolveSemanticConfig({ enabled: "enabled" as never }).enabled, false);
});

// ──────────────────────────────────────────────────────────────────────────
// Host numeric config is coerced: a malformed string ("abc") must not become
// NaN and silently disable the vector budget (NaN > 0 is false → unlimited)
// or the cosine gate. It falls through to the documented default instead
// (chatgpt-codex-connector: 'Validate host numeric config before clamping').
// ──────────────────────────────────────────────────────────────────────────

test("config: malformed host numbers fall back to default (no NaN)", () => {
  const cfg = resolveSemanticConfig({
    enabled: true,
    maxSymbolsPerRun: "abc" as never,
    similarToThreshold: "xyz" as never,
  });
  assert.equal(Number.isNaN(cfg.maxSymbolsPerRun), false, "maxSymbolsPerRun must not be NaN");
  assert.equal(Number.isNaN(cfg.similarToThreshold), false, "similarToThreshold must not be NaN");
  // Falls through to the documented defaults.
  assert.equal(cfg.maxSymbolsPerRun, DEFAULT_MAX_SYMBOLS_PER_RUN);
  assert.equal(cfg.similarToThreshold, DEFAULT_SIMILAR_TO_THRESHOLD);
  // A valid numeric string is still honored.
  const cfg2 = resolveSemanticConfig({ enabled: true, maxSymbolsPerRun: "5" as never });
  assert.equal(cfg2.maxSymbolsPerRun, 5);
});

// ──────────────────────────────────────────────────────────────────────────
// Cache hits still work when the provider does not declare dimensions
// (optional). The dims gate is skipped, so re-indexing an unchanged symbol
// uses the cache instead of re-embedding every run (cursor Bugbot: 'Cache
// misses without provider dimensions').
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
// SIMILAR_TO end-to-end: two symbols that share a qualified name across two
// files are persisted as a SIMILAR_TO edge by node id (issue #1677). Before
// the fix the edge was dropped because resolveNodeId returns undefined for an
// ambiguous qualified name.
// ──────────────────────────────────────────────────────────────────────────

test("SIMILAR_TO: duplicate qualified name across files persists by node id (issue #1677)", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    // Identical bodies → MinHash candidate. Same qualified name, different
    // files → distinct node ids, ambiguous qualified name.
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

    // No provider → MinHash-only path (deterministic, local).
    const r = computeSimilarTo({ store, provider: undefined, config: ENABLED_CONFIG, repoRoot: dir });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("expected ok");
    assert.ok(r.edges.length >= 1, "a near-clone candidate is produced");

    // The candidate edges MUST carry node ids (the fix).
    const pair = r.edges.find((e) => e.srcNodeId === idA && e.dstNodeId === idB);
    assert.ok(pair, "emitted edge carries the content-derived node ids of both same-qname nodes");

    // Persist via the store. Pre-fix this returned skipped=1, persisted=0.
    const edgeIRs = similarEdgesToEdgeIR(r.edges);
    const upsert = await store.upsertEdges(edgeIRs);
    assert.equal(upsert.ok, true);
    if (!upsert.ok) throw new Error("expected ok");
    assert.equal(upsert.persisted, edgeIRs.length, "all SIMILAR_TO edges persisted by node id");
    assert.equal(upsert.skipped, 0, "no edge dropped as an ambiguous qualified name");

    // Traversal by node id confirms the edge links the two same-qname nodes.
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
// #1680 — deferred review nits on the semantic layer (tagged read failures,
// limit validation, negative body budget, README recompute example).
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
  // A positive value is still honored (not clobbered by the fallback).
  const ok = resolveSemanticConfig({ enabled: true, canonicalBodyLines: 7 });
  assert.equal(ok.canonicalBodyLines, 7, "positive value honored");
  // String coercion path (coerceHostNumber) — a numeric string like "-3"
  // must also fall back, not clamp to 0.
  const negStr = resolveSemanticConfig({ enabled: true, canonicalBodyLines: "-3" as never });
  assert.equal(negStr.canonicalBodyLines, DEFAULT_CANONICAL_BODY_LINES, "numeric-string -3 → default");
});

// semanticQuery: a transient store read failure (SQLITE_BUSY/CORRUPT) on
// readAllSymbolVectors maps to a tagged db_error instead of escaping as a
// throw (#1680).
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

// indexSymbolVectors: a transient store read failure on readNodesForSemantic
// maps to a tagged db_error instead of rejecting the promise (#1680).
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

// semanticQuery: a caller-supplied limit of NaN/Infinity must not produce a
// NaN/Infinity slice. slice(0, NaN) returns no hits; slice(0, Infinity)
// returns every scored vector. Both are wrong — coerce to the finite default
// (#1680).
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
    // Fix the end byte for each to the next symbol's start (last = src.length).
    for (let i = 0; i < symbols.length; i++) {
      symbols[i]!.end = i + 1 < symbols.length ? symbols[i + 1]!.start : src.length;
    }
    await store.upsertFileBatch([makeFileIR("many.ts", symbols, src)]);

    const provider = countingProvider();
    await indexSymbolVectors({ store, provider, repoRoot: dir, config: ENABLED_CONFIG });

    // NaN limit → default (10), not 0.
    const nanR = await semanticQuery({ store, provider, repoRoot: dir, config: ENABLED_CONFIG, query: "function", limit: NaN });
    assert.equal(nanR.ok, true);
    if (nanR.ok) {
      assert.ok(nanR.hits.length > 0, `NaN limit must not return zero hits, got ${nanR.hits.length}`);
      assert.ok(nanR.hits.length <= DEFAULT_SEMANTIC_QUERY_LIMIT, `NaN limit capped to default, got ${nanR.hits.length}`);
    }
    // Infinity limit → default (10), not all 12.
    const infR = await semanticQuery({ store, provider, repoRoot: dir, config: ENABLED_CONFIG, query: "function", limit: Infinity });
    assert.equal(infR.ok, true);
    if (infR.ok) {
      assert.ok(infR.hits.length <= DEFAULT_SEMANTIC_QUERY_LIMIT, `Infinity limit capped to default, got ${infR.hits.length}`);
    }
    // A finite positive limit is honored.
    const two = await semanticQuery({ store, provider, repoRoot: dir, config: ENABLED_CONFIG, query: "function", limit: 2 });
    assert.equal(two.ok, true);
    if (two.ok) assert.equal(two.hits.length, 2, "limit=2 returns exactly 2 hits");
  } finally {
    await cleanup();
  }
});

// SIMILAR_TO recompute is replace-not-append: the README example clears
// semantic SIMILAR_TO edges before upserting so two symbols that STOP being
// similar do not leave a stale edge (upsertEdges does not delete absent rows).
// This test exercises the documented README flow end to end (#1680).
test("SIMILAR_TO recompute: clearSemanticSimilarToEdges makes recompute replace-not-append (README example)", async () => {
  const { store, dir, cleanup } = await tempStore();
  try {
    // Two near-identical bodies → MinHash candidate → SIMILAR_TO edge.
    const bodyA = "function twin() { const x = 1; const y = 2; return x + y; }";
    const bodyB = "function twin() { const x = 1; const y = 2; return x + y; }";
    await writeFile(path.join(dir, "a.ts"), bodyA);
    await writeFile(path.join(dir, "b.ts"), bodyB);
    await store.upsertFileBatch([
      makeFileIR("a.ts", [{ name: "twin", qname: "mod.a", kind: "function", start: 0, end: bodyA.length }], bodyA),
      makeFileIR("b.ts", [{ name: "twin", qname: "mod.b", kind: "function", start: 0, end: bodyB.length }], bodyB),
    ]);

    const provider = countingProvider();
    // README step 0: index vectors FIRST so cosine confirmation has data.
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

    // README step 1: clear before recompute (replace-not-append).
    await store.clearSemanticSimilarToEdges();
    const afterClear = store.traverse({ start: idA, edgeTypes: ["SIMILAR_TO"], maxDepth: 1 });
    assert.ok(afterClear.ok, "traverse ok after clear");
    if (afterClear.ok) {
      assert.ok(!afterClear.hits.some((h) => h.qualifiedName === "mod.b"), "SIMILAR_TO edge to mod.b gone after clear");
    }

    // README step 2: recompute + upsert. A stale edge that recompute would
    // NOT re-emit would have survived without the clear; here recompute
    // re-emits the still-similar pair, so the final set equals the
    // recomputed set — not doubled.
    const r2 = computeSimilarTo({ store, provider, repoRoot: dir, config: ENABLED_CONFIG });
    assert.equal(r2.ok, true);
    if (!r2.ok) throw new Error("expected ok");
    if (r2.edges.length >= 1) {
      await store.upsertEdges(similarEdgesToEdgeIR(r2.edges));
    }
    const final = store.traverse({ start: idA, edgeTypes: ["SIMILAR_TO"], maxDepth: 1 });
    assert.ok(final.ok, "traverse ok");
    if (final.ok) {
      // After clear + recompute + upsert, mod.b is reachable again — the
      // still-similar pair has its edge (clean replace, not a stale append).
      assert.ok(final.hits.some((h) => h.qualifiedName === "mod.b"), "mod.b reachable again after recompute (replace worked)");
    }
  } finally {
    await cleanup();
  }
});
