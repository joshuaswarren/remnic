/**
 * graph-store PR2 tests — ordered steps 4–5 of issue #1552.
 *
 * Covers the read-side primitives that land in PR2:
 *   - traverse(): iterative frontier BFS with cycle / self-edge safety,
 *     direction (outgoing/incoming/both), edge-type filter, and the
 *     half-open depth-cap boundary (depth == maxDepth INCLUDED,
 *     maxDepth+1 NOT — rule 35).
 *   - searchGraph(): label / name / file LIKE patterns + degreeMin/Max
 *     filters + limit (including the rule-27 `limit: 0` guard).
 *   - schemaStats(): aggregate counts over the whole graph.
 *   - deadCode(): exclusion constant behavior, including the load-bearing
 *     fixture that proves an exported-but-uncalled symbol is NOT reported
 *     while a private uncalled symbol IS.
 *   - snippetFor(): reads spans from disk via repoRoot; tagged failures
 *     for unset root / missing file / ambiguous name.
 *
 * Fixture IR is synthetic (public-repo policy). Tests prove-fail-before
 * by exact-set assertions — a deliberate break of the depth cap or the
 * dead-code exclusion fails the corresponding test.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openBetterSqlite3 } from "@remnic/core/runtime/better-sqlite";

import {
  DEAD_CODE_EXCLUSION,
  GraphStore,
  type EdgeIR,
  type StoreFileIR,
  type SymbolIR,
} from "./graph-store.js";

// ──────────────────────────────────────────────────────────────────────────
// Fixture helpers — synthetic IR.
// ──────────────────────────────────────────────────────────────────────────

function sym(
  qualifiedName: string,
  name: string,
  startByte: number,
  endByte: number,
  kind: SymbolIR["kind"] = "function",
): SymbolIR {
  return { qualifiedName, name, span: { startByte, endByte }, kind };
}

function exp(name: string, startByte: number, endByte: number) {
  return { name, span: { startByte, endByte } };
}

function route(
  verb: string,
  pathTemplate: string,
  handlerQualifiedName: string,
  startByte: number,
  endByte: number,
) {
  return {
    verb,
    pathTemplate,
    handlerQualifiedName,
    span: { startByte, endByte },
  };
}

function edge(
  srcQualifiedName: string,
  dstQualifiedName: string,
  type = "CALLS",
  confidence = 0.9,
  provenance: EdgeIR["provenance"] = "heuristic",
): EdgeIR {
  return { srcQualifiedName, dstQualifiedName, type, confidence, provenance };
}

/** Build a temp dir + a GraphStore opened against a fresh DB inside it. */
async function tempStore(
  options: { repoRoot?: string } = {},
): Promise<{ store: GraphStore; dir: string; repoRoot: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "coding-graph-pr2-"));
  const repoRoot = options.repoRoot ?? dir;
  const store = await GraphStore.open({
    dbPath: path.join(dir, "graph.sqlite"),
    repoRoot,
  });
  return { store, dir, repoRoot };
}

async function dispose(store: GraphStore, dir: string): Promise<void> {
  await store.close();
  await rm(dir, { recursive: true, force: true });
}

// ──────────────────────────────────────────────────────────────────────────
// Fixture: a chain a → b → c with a back-edge c → a (cycle) and a
// self-edge on b. Used to prove cycle / self-edge safety.
// ──────────────────────────────────────────────────────────────────────────

const cyclicFile: StoreFileIR = {
  path: "src/cyclic.ts",
  language: "typescript",
  contentHash: "h-cyclic",
  symbols: [
    sym("cyc.a", "a", 0, 10),
    sym("cyc.b", "b", 10, 20),
    sym("cyc.c", "c", 20, 30),
  ],
  edges: [
    edge("cyc.a", "cyc.b"),
    edge("cyc.b", "cyc.c"),
    edge("cyc.c", "cyc.a"), // back-edge: cycle a → b → c → a
    edge("cyc.b", "cyc.b"), // self-edge on b
  ],
};

// ──────────────────────────────────────────────────────────────────────────
// Fixture: a star graph for degree tests — center has degree 4, leaves
// have degree 1. Used by searchGraph's degreeMin/Max filters.
// ──────────────────────────────────────────────────────────────────────────

const starFile: StoreFileIR = {
  path: "src/star.ts",
  language: "typescript",
  contentHash: "h-star",
  symbols: [
    sym("star.center", "center", 0, 10),
    sym("star.l1", "l1", 10, 20),
    sym("star.l2", "l2", 20, 30),
    sym("star.l3", "l3", 30, 40),
    sym("star.l4", "l4", 40, 50),
  ],
  edges: [
    edge("star.center", "star.l1"),
    edge("star.center", "star.l2"),
    edge("star.center", "star.l3"),
    edge("star.center", "star.l4"),
  ],
};

// ──────────────────────────────────────────────────────────────────────────
// Fixture: dead-code scenario. Two files:
//   - lib.ts: exports `publicApi` (uncalled from inside the graph) AND
//     `privateHelper` (also uncalled). Only `publicApi` should be
//     excluded from deadCode() because it carries `is_exported=1`.
//   - entry.ts: imports lib and calls into it, providing the only
//     inbound edge on `caller`. Its path matches an entry-point pattern
//     so its symbols are excluded by the path-based rule.
// ──────────────────────────────────────────────────────────────────────────

const deadCodeLibFile: StoreFileIR = {
  path: "src/lib.ts",
  language: "typescript",
  contentHash: "h-lib",
  symbols: [
    sym("lib.publicApi", "publicApi", 0, 100),
    sym("lib.privateHelper", "privateHelper", 100, 200),
    sym("lib.alive", "alive", 200, 300),
  ],
  exports: [
    exp("publicApi", 0, 100), // publicApi is exported
    exp("alive", 200, 300),
  ],
  routes: [],
  edges: [
    // alive calls privateHelper → privateHelper has inbound edge → NOT dead.
    edge("lib.alive", "lib.privateHelper"),
    // publicApi has NO inbound edges but is exported → NOT dead.
    // privateHelper HAS an inbound edge → not a candidate at all.
    // alive has NO inbound edges and is exported → NOT dead.
  ],
};

const deadCodeEntryFile: StoreFileIR = {
  path: "src/index.ts",
  language: "typescript",
  contentHash: "h-entry",
  symbols: [
    sym("entry.main", "main", 0, 50),
    sym("entry.unused", "unused", 50, 100),
  ],
  // No exports — both symbols are private.
  // Path matches ENTRY_POINT_PATH_PATTERNS, so BOTH are excluded by the
  // path rule even though `entry.unused` is uncalled.
  edges: [],
};

// Separate file proving the route-handler exclusion.
const routeHandlerFile: StoreFileIR = {
  path: "src/server.ts",
  language: "typescript",
  contentHash: "h-route",
  symbols: [
    sym("route.healthHandler", "healthHandler", 0, 100),
    sym("route.uncalledHelper", "uncalledHelper", 100, 200),
  ],
  routes: [
    route("GET", "/health", "route.healthHandler", 0, 100),
  ],
  // No exports → healthHandler relies on the route-handler flag.
  edges: [],
};

// ──────────────────────────────────────────────────────────────────────────
// traverse(): BFS depth + cycle + self-edge + direction.
// ──────────────────────────────────────────────────────────────────────────

test("traverse: cycle-safe — back-edge does not loop forever, visited set wins", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = await store.upsertFileBatch([cyclicFile]);
    assert.equal(r.ok, true);
    const out = store.traverse({ start: "cyc.a", maxDepth: 10 });
    assert.equal(out.ok, true);
    if (!out.ok) throw new Error("expected ok");
    // Three distinct nodes visited despite the cycle.
    assert.equal(out.hits.length, 3);
    const qnames = out.hits.map((h) => h.qualifiedName).sort();
    assert.deepEqual(qnames, ["cyc.a", "cyc.b", "cyc.c"]);
  } finally {
    await dispose(store, dir);
  }
});

test("traverse: self-edge never re-expands the frontier (cycle safety)", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = await store.upsertFileBatch([cyclicFile]);
    assert.equal(r.ok, true);
    const out = store.traverse({ start: "cyc.b", maxDepth: 5 });
    assert.equal(out.ok, true);
    if (!out.ok) throw new Error("expected ok");
    // Start at b: depth 0 = {b}; depth 1 = {c} (self-edge and a→b
    // both skipped because b is visited); depth 2 = {a} (c→a).
    // Total: 3 nodes.
    assert.equal(out.hits.length, 3);
  } finally {
    await dispose(store, dir);
  }
});

test("traverse: depth cap is half-open — depth==maxDepth INCLUDED, maxDepth+1 NOT (rule 35)", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = await store.upsertFileBatch([cyclicFile]);
    assert.equal(r.ok, true);

    // maxDepth 0 → just the start.
    const d0 = store.traverse({ start: "cyc.a", maxDepth: 0 });
    assert.equal(d0.ok, true);
    if (!d0.ok) throw new Error("expected ok");
    assert.equal(d0.hits.length, 1);
    assert.equal(d0.hits[0]?.qualifiedName, "cyc.a");
    assert.equal(d0.hits[0]?.depth, 0);

    // maxDepth 1 → start + direct neighbor (b).
    const d1 = store.traverse({ start: "cyc.a", maxDepth: 1 });
    assert.equal(d1.ok, true);
    if (!d1.ok) throw new Error("expected ok");
    assert.equal(d1.hits.length, 2);
    const d1Qnames = d1.hits.map((h) => h.qualifiedName).sort();
    assert.deepEqual(d1Qnames, ["cyc.a", "cyc.b"]);

    // maxDepth 2 → a (depth 0) + b (depth 1) + c (depth 2). The
    // back-edge c → a would re-visit a at depth 3 — the cap excludes
    // that (the cycle is irrelevant when the cap binds first).
    const d2 = store.traverse({ start: "cyc.a", maxDepth: 2 });
    assert.equal(d2.ok, true);
    if (!d2.ok) throw new Error("expected ok");
    assert.equal(d2.hits.length, 3);
    const depthByNode = new Map(d2.hits.map((h) => [h.qualifiedName, h.depth]));
    assert.equal(depthByNode.get("cyc.a"), 0);
    assert.equal(depthByNode.get("cyc.b"), 1);
    assert.equal(depthByNode.get("cyc.c"), 2);

    // Boundary proof: maxDepth 2 hits c at depth 2; c → a (depth 3)
    // is NOT included. If the cap were off-by-one (depth < maxDepth
    // instead of depth <= maxDepth), c would be missing here.
  } finally {
    await dispose(store, dir);
  }
});

test("traverse: direction=incoming follows edges backward", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = await store.upsertFileBatch([starFile]);
    assert.equal(r.ok, true);

    // From l1, incoming direction: who points at l1? Only center.
    const out = store.traverse({
      start: "star.l1",
      direction: "incoming",
      maxDepth: 5,
    });
    assert.equal(out.ok, true);
    if (!out.ok) throw new Error("expected ok");
    assert.equal(out.hits.length, 2);
    const qnames = out.hits.map((h) => h.qualifiedName).sort();
    assert.deepEqual(qnames, ["star.center", "star.l1"]);
    // l1 at depth 0, center at depth 1.
    const byName = new Map(out.hits.map((h) => [h.qualifiedName, h.depth]));
    assert.equal(byName.get("star.l1"), 0);
    assert.equal(byName.get("star.center"), 1);
  } finally {
    await dispose(store, dir);
  }
});

test("traverse: direction=both expands in + out per level", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = await store.upsertFileBatch([starFile]);
    assert.equal(r.ok, true);

    // From center with direction=both at depth 1: each leaf is
    // reachable outgoing. No incoming edges land on center.
    const out = store.traverse({
      start: "star.center",
      direction: "both",
      maxDepth: 1,
    });
    assert.equal(out.ok, true);
    if (!out.ok) throw new Error("expected ok");
    assert.equal(out.hits.length, 5);
    const qnames = out.hits.map((h) => h.qualifiedName).sort();
    assert.deepEqual(qnames, [
      "star.center",
      "star.l1",
      "star.l2",
      "star.l3",
      "star.l4",
    ]);
  } finally {
    await dispose(store, dir);
  }
});

test("traverse: edgeTypes filter restricts the frontier", async () => {
  const { store, dir } = await tempStore();
  try {
    // Two edge types: CALLS and USES_TYPE. Restricting to USES_TYPE
    // should yield zero hops because no USES_TYPE edges exist.
    const mixed: StoreFileIR = {
      path: "src/mixed.ts",
      language: "typescript",
      contentHash: "h-mixed",
      symbols: [sym("m.a", "a", 0, 10), sym("m.b", "b", 10, 20)],
      edges: [
        edge("m.a", "m.b", "CALLS"),
        edge("m.a", "m.b", "USES_TYPE"),
      ],
    };
    const r = await store.upsertFileBatch([mixed]);
    assert.equal(r.ok, true);

    const onlyUses = store.traverse({
      start: "m.a",
      edgeTypes: ["USES_TYPE"],
      maxDepth: 5,
    });
    assert.equal(onlyUses.ok, true);
    if (!onlyUses.ok) throw new Error("expected ok");
    // USES_TYPE edge a → b exists, so we should reach b.
    assert.equal(onlyUses.hits.length, 2);

    const onlyAsync = store.traverse({
      start: "m.a",
      edgeTypes: ["ASYNC_CALLS"],
      maxDepth: 5,
    });
    assert.equal(onlyAsync.ok, true);
    if (!onlyAsync.ok) throw new Error("expected ok");
    // No ASYNC_CALLS edges → only the start node.
    assert.equal(onlyAsync.hits.length, 1);
    assert.equal(onlyAsync.hits[0]?.qualifiedName, "m.a");
  } finally {
    await dispose(store, dir);
  }
});

test("traverse: unknown start returns tagged failure (rule 34)", async () => {
  const { store, dir } = await tempStore();
  try {
    const out = store.traverse({ start: "does.not.exist", maxDepth: 3 });
    assert.equal(out.ok, false);
    if (out.ok) throw new Error("expected failure");
    assert.equal(out.code, "unknown_start");
  } finally {
    await dispose(store, dir);
  }
});

test("traverse: invalid maxDepth rejected with code 'invalid_query' (rule 51)", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = await store.upsertFileBatch([cyclicFile]);
    assert.equal(r.ok, true);

    // Negative, fractional, NaN — all rejected, not silently clamped.
    const cases: [number, string][] = [
      [-1, "negative"],
      [1.5, "fractional"],
      [Number.NaN, "NaN"],
    ];
    for (const [v, label] of cases) {
      const out = store.traverse({ start: "cyc.a", maxDepth: v });
      assert.equal(out.ok, false, `${label} should fail`);
      if (out.ok) throw new Error(`expected failure for ${label}`);
      assert.equal(out.code, "invalid_query", `${label} → invalid_query`);
    }
  } finally {
    await dispose(store, dir);
  }
});

test("traverse: ambiguous start (qualified name in two files) is rejected with 'ambiguous_start'", async () => {
  const { store, dir } = await tempStore();
  try {
    // Same qualified name declared in two files → ambiguous.
    const file1: StoreFileIR = {
      path: "src/f1.ts",
      language: "typescript",
      contentHash: "h1",
      symbols: [sym("dup.name", "name", 0, 10)],
    };
    const file2: StoreFileIR = {
      path: "src/f2.ts",
      language: "typescript",
      contentHash: "h2",
      symbols: [sym("dup.name", "name", 0, 10)],
    };
    const r = await store.upsertFileBatch([file1, file2]);
    assert.equal(r.ok, true);

    const out = store.traverse({ start: "dup.name", maxDepth: 3 });
    assert.equal(out.ok, false);
    if (out.ok) throw new Error("expected failure");
    assert.equal(out.code, "ambiguous_start");
  } finally {
    await dispose(store, dir);
  }
});

test("traverse: store_closed when the store is closed", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = await store.upsertFileBatch([cyclicFile]);
    assert.equal(r.ok, true);
    await store.close();
    const out = store.traverse({ start: "cyc.a", maxDepth: 3 });
    assert.equal(out.ok, false);
    if (out.ok) throw new Error("expected failure");
    assert.equal(out.code, "store_closed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("traverse: invalid direction rejected with code 'invalid_query' (chatgpt-codex-connector P2)", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = await store.upsertFileBatch([cyclicFile]);
    assert.equal(r.ok, true);

    // A typo like "outbound" must NOT silently return only the start
    // node — it must surface as invalid_query so the caller learns.
    const out = store.traverse({
      start: "cyc.a",
      maxDepth: 3,
      // @ts-expect-error — deliberately invalid direction at runtime
      direction: "outbound",
    });
    assert.equal(out.ok, false);
    if (out.ok) throw new Error("expected failure");
    assert.equal(out.code, "invalid_query");
  } finally {
    await dispose(store, dir);
  }
});

test("traverse: a 64-hex node id resolves by id only, never conflated with a qualified_name (cursor Bugbot: 'Traverse start conflates id and name')", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = await store.upsertFileBatch([cyclicFile]);
    assert.equal(r.ok, true);

    // Look up the actual node id for cyc.a via searchGraph.
    const search = store.searchGraph({ namePattern: "a" });
    assert.equal(search.ok, true);
    if (!search.ok) throw new Error("expected ok");
    const cycA = search.hits.find((h) => h.qualifiedName === "cyc.a");
    assert.ok(cycA, "cyc.a should be in the graph");
    // Node ids are 64-char lowercase hex (sha256).
    assert.match(cycA.nodeId, /^[0-9a-f]{64}$/);

    // Traverse by node id → resolves uniquely to cyc.a, NOT ambiguous.
    const byId = store.traverse({ start: cycA.nodeId, maxDepth: 1 });
    assert.equal(byId.ok, true);
    if (!byId.ok) throw new Error("expected ok");
    assert.equal(byId.hits.length, 2, "cyc.a + its direct neighbor at depth 1");

    // A 64-hex string that is NOT any node's id → unknown_start, even
    // though the old `WHERE id = ? OR qualified_name = ?` would have
    // returned [] here too. The point is the id path no longer falls
    // through to the qualified_name path.
    const bogusId = "0".repeat(64);
    const miss = store.traverse({ start: bogusId, maxDepth: 3 });
    assert.equal(miss.ok, false);
    if (miss.ok) throw new Error("expected failure");
    assert.equal(miss.code, "unknown_start");
  } finally {
    await dispose(store, dir);
  }
});

test("traverse: malformed edgeTypes (non-array or non-string element) rejected with 'invalid_query' (chatgpt-codex-connector P2)", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = await store.upsertFileBatch([cyclicFile]);
    assert.equal(r.ok, true);

    // A bare string instead of an array would throw at .map() without
    // this guard. Now it surfaces as invalid_query.
    const asString = store.traverse({
      start: "cyc.a",
      maxDepth: 3,
      // @ts-expect-error — deliberately malformed at runtime
      edgeTypes: "CALLS",
    });
    assert.equal(asString.ok, false);
    if (asString.ok) throw new Error("expected failure");
    assert.equal(asString.code, "invalid_query");

    // An array with a non-string element is also rejected.
    const withNumber = store.traverse({
      start: "cyc.a",
      maxDepth: 3,
      // @ts-expect-error — deliberately malformed at runtime
      edgeTypes: ["CALLS", 42],
    });
    assert.equal(withNumber.ok, false);
    if (withNumber.ok) throw new Error("expected failure");
    assert.equal(withNumber.code, "invalid_query");
  } finally {
    await dispose(store, dir);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// searchGraph(): label / name / file patterns + degree filters + limit.
// ──────────────────────────────────────────────────────────────────────────

test("searchGraph: empty query returns every node up to the default limit", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = await store.upsertFileBatch([starFile]);
    assert.equal(r.ok, true);

    const out = store.searchGraph({});
    assert.equal(out.ok, true);
    if (!out.ok) throw new Error("expected ok");
    assert.equal(out.hits.length, 5);
  } finally {
    await dispose(store, dir);
  }
});

test("searchGraph: namePattern uses LIKE % wildcards (case-insensitive)", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = await store.upsertFileBatch([starFile]);
    assert.equal(r.ok, true);

    const out = store.searchGraph({ namePattern: "l%" });
    assert.equal(out.ok, true);
    if (!out.ok) throw new Error("expected ok");
    // l1, l2, l3, l4 — four matches.
    assert.equal(out.hits.length, 4);
    for (const h of out.hits) {
      assert.ok(h.name.startsWith("l"));
    }

    // Case-insensitive: CENTER should match `center`.
    const upper = store.searchGraph({ namePattern: "CENTER" });
    assert.equal(upper.ok, true);
    if (!upper.ok) throw new Error("expected ok");
    assert.equal(upper.hits.length, 1);
    assert.equal(upper.hits[0]?.name, "center");
  } finally {
    await dispose(store, dir);
  }
});

test("searchGraph: filePattern filters by repo-relative file path", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = await store.upsertFileBatch([starFile, cyclicFile]);
    assert.equal(r.ok, true);

    const out = store.searchGraph({ filePattern: "src/star%" });
    assert.equal(out.ok, true);
    if (!out.ok) throw new Error("expected ok");
    assert.equal(out.hits.length, 5);
    for (const h of out.hits) {
      assert.equal(h.filePath, "src/star.ts");
    }
  } finally {
    await dispose(store, dir);
  }
});

test("searchGraph: label filter restricts by symbol kind", async () => {
  const { store, dir } = await tempStore();
  try {
    const mixed: StoreFileIR = {
      path: "src/kinds.ts",
      language: "typescript",
      contentHash: "h-kinds",
      symbols: [
        sym("k.fn", "fn", 0, 10, "function"),
        sym("k.cls", "cls", 10, 20, "class"),
      ],
    };
    const r = await store.upsertFileBatch([mixed]);
    assert.equal(r.ok, true);

    const onlyFn = store.searchGraph({ label: "function" });
    assert.equal(onlyFn.ok, true);
    if (!onlyFn.ok) throw new Error("expected ok");
    assert.equal(onlyFn.hits.length, 1);
    assert.equal(onlyFn.hits[0]?.label, "function");

    const onlyClass = store.searchGraph({ label: "class" });
    assert.equal(onlyClass.ok, true);
    if (!onlyClass.ok) throw new Error("expected ok");
    assert.equal(onlyClass.hits.length, 1);
    assert.equal(onlyClass.hits[0]?.label, "class");
  } finally {
    await dispose(store, dir);
  }
});

test("searchGraph: degreeMin/Max filter on in+out edge count", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = await store.upsertFileBatch([starFile]);
    assert.equal(r.ok, true);

    // center has degree 4 (4 outbound CALLS); leaves have degree 1.
    // Note: the unique(src,dst,type) constraint means each leaf also
    // has degree 1 (one inbound edge).
    const onlyHigh = store.searchGraph({ degreeMin: 4 });
    assert.equal(onlyHigh.ok, true);
    if (!onlyHigh.ok) throw new Error("expected ok");
    assert.equal(onlyHigh.hits.length, 1);
    assert.equal(onlyHigh.hits[0]?.qualifiedName, "star.center");
    assert.equal(onlyHigh.hits[0]?.degree, 4);

    const onlyLeaves = store.searchGraph({ degreeMin: 1, degreeMax: 1 });
    assert.equal(onlyLeaves.ok, true);
    if (!onlyLeaves.ok) throw new Error("expected ok");
    assert.equal(onlyLeaves.hits.length, 4);
    for (const h of onlyLeaves.hits) {
      assert.equal(h.degree, 1);
    }
  } finally {
    await dispose(store, dir);
  }
});

test("searchGraph: limit caps the result set, 0 returns empty (rule 27)", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = await store.upsertFileBatch([starFile]);
    assert.equal(r.ok, true);

    // limit 0 → empty hits, NOT the whole graph (rule 27 guard).
    const zero = store.searchGraph({ limit: 0 });
    assert.equal(zero.ok, true);
    if (!zero.ok) throw new Error("expected ok");
    assert.equal(zero.hits.length, 0);

    const two = store.searchGraph({ limit: 2 });
    assert.equal(two.ok, true);
    if (!two.ok) throw new Error("expected ok");
    assert.equal(two.hits.length, 2);

    // Above the clamp cap (1000) → still clamped to 5 (the graph size).
    const big = store.searchGraph({ limit: 100 });
    assert.equal(big.ok, true);
    if (!big.ok) throw new Error("expected ok");
    assert.equal(big.hits.length, 5);
  } finally {
    await dispose(store, dir);
  }
});

test("searchGraph: invalid degree / limit rejected with 'invalid_query'", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = await store.upsertFileBatch([starFile]);
    assert.equal(r.ok, true);

    const badDegree = store.searchGraph({ degreeMin: -1 });
    assert.equal(badDegree.ok, false);
    if (badDegree.ok) throw new Error("expected failure");
    assert.equal(badDegree.code, "invalid_query");

    const inverted = store.searchGraph({ degreeMin: 5, degreeMax: 1 });
    assert.equal(inverted.ok, false);
    if (inverted.ok) throw new Error("expected failure");
    assert.equal(inverted.code, "invalid_query");

    const fractional = store.searchGraph({ degreeMax: 1.5 });
    assert.equal(fractional.ok, false);
    if (fractional.ok) throw new Error("expected failure");
    assert.equal(fractional.code, "invalid_query");
  } finally {
    await dispose(store, dir);
  }
});

test("searchGraph: non-string label/namePattern/filePattern rejected with 'invalid_query' (chatgpt-codex-connector P2)", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = await store.upsertFileBatch([starFile]);
    assert.equal(r.ok, true);

    // A non-string pattern (e.g. a number) must NOT be silently
    // dropped — its .length is undefined, so without this guard the
    // filter would be skipped and unrelated nodes returned as ok.
    for (const bad of [
      { namePattern: 42 },
      { label: 100 },
      { filePattern: 0 },
    ]) {
      const out = store.searchGraph(bad as unknown as Parameters<
        typeof store.searchGraph
      >[0]);
      assert.equal(out.ok, false);
      if (out.ok) throw new Error("expected failure");
      assert.equal(out.code, "invalid_query");
    }
  } finally {
    await dispose(store, dir);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// schemaStats().
// ──────────────────────────────────────────────────────────────────────────

test("schemaStats: aggregate counts over the whole graph", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = await store.upsertFileBatch([starFile, cyclicFile]);
    assert.equal(r.ok, true);

    const out = store.schemaStats();
    assert.equal(out.ok, true);
    if (!out.ok) throw new Error("expected ok");
    assert.equal(out.stats.files, 2);
    // starFile has 5 nodes; cyclicFile has 3 → 8 total.
    assert.equal(out.stats.nodes, 8);
    // starFile: 4 CALLS edges. cyclicFile: 3 CALLS + 1 self = 4.
    assert.equal(out.stats.edges, 8);
    assert.equal(out.stats.nodesByLabel.function, 8);
    assert.equal(out.stats.edgesByType.CALLS, 8);
  } finally {
    await dispose(store, dir);
  }
});

test("schemaStats: empty graph returns zeros, not null", async () => {
  const { store, dir } = await tempStore();
  try {
    const out = store.schemaStats();
    assert.equal(out.ok, true);
    if (!out.ok) throw new Error("expected ok");
    assert.equal(out.stats.files, 0);
    assert.equal(out.stats.nodes, 0);
    assert.equal(out.stats.edges, 0);
    assert.deepEqual(out.stats.nodesByLabel, {});
    assert.deepEqual(out.stats.edgesByType, {});
  } finally {
    await dispose(store, dir);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// deadCode(): the load-bearing exclusion test.
// ──────────────────────────────────────────────────────────────────────────

test("deadCode: exported-but-uncalled NOT reported; private-uncalled IS reported", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = await store.upsertFileBatch([deadCodeLibFile]);
    assert.equal(r.ok, true);

    const out = store.deadCode();
    assert.equal(out.ok, true);
    if (!out.ok) throw new Error("expected ok");
    const qnames = out.hits.map((h) => h.qualifiedName).sort();

    // publicApi is uncalled but exported → NOT reported.
    // alive is uncalled but exported → NOT reported.
    // privateHelper HAS an inbound CALLS edge (alive → privateHelper)
    // → not a candidate at all.
    //
    // Therefore deadCode() should report ZERO hits from this fixture.
    assert.equal(
      qnames.length,
      0,
      `expected no dead-code hits, got: ${qnames.join(", ")}`,
    );
  } finally {
    await dispose(store, dir);
  }
});

test("deadCode: private uncalled symbol IS reported", async () => {
  const { store, dir } = await tempStore();
  try {
    // A file with one private, uncalled function. No exports, no
    // inbound edges → it should appear in deadCode().
    const file: StoreFileIR = {
      path: "src/internal.ts",
      language: "typescript",
      contentHash: "h-internal",
      symbols: [
        sym("internal.dead", "dead", 0, 50),
        sym("internal.alive", "alive", 50, 100),
      ],
      // No exports → both are private.
      edges: [],
    };
    const r = await store.upsertFileBatch([file]);
    assert.equal(r.ok, true);

    const out = store.deadCode();
    assert.equal(out.ok, true);
    if (!out.ok) throw new Error("expected ok");
    const qnames = out.hits.map((h) => h.qualifiedName).sort();
    assert.deepEqual(qnames, ["internal.alive", "internal.dead"]);
  } finally {
    await dispose(store, dir);
  }
});

test("deadCode: re-ingest that REMOVES an export re-classifies the symbol as dead", async () => {
  const { store, dir } = await tempStore();
  try {
    // First ingest: publicApi is exported → not dead.
    const r1 = await store.upsertFileBatch([deadCodeLibFile]);
    assert.equal(r1.ok, true);
    const before = store.deadCode();
    assert.equal(before.ok, true);
    if (!before.ok) throw new Error("expected ok");
    assert.equal(
      before.hits.length,
      0,
      "no dead symbols before removing the export",
    );

    // Second ingest: drop the exports array. publicApi loses its
    // is_exported flag → it should now appear in deadCode().
    const revised: StoreFileIR = {
      ...deadCodeLibFile,
      exports: [], // explicitly exports nothing
    };
    const r2 = await store.upsertFileBatch([revised]);
    assert.equal(r2.ok, true);
    const after = store.deadCode();
    assert.equal(after.ok, true);
    if (!after.ok) throw new Error("expected ok");
    const qnames = after.hits.map((h) => h.qualifiedName).sort();
    // publicApi and alive both lose their flags → both become dead.
    // privateHelper still has an inbound edge → not dead.
    assert.deepEqual(qnames, ["lib.alive", "lib.publicApi"]);
  } finally {
    await dispose(store, dir);
  }
});

test("deadCode: partial re-ingest preserves the omitted flag (cursor Bugbot + chatgpt-codex-connector P2)", async () => {
  const { store, dir } = await tempStore();
  try {
    // First ingest: healthHandler is a route handler → not dead.
    const r1 = await store.upsertFileBatch([routeHandlerFile]);
    assert.equal(r1.ok, true);
    const before = store.deadCode();
    assert.equal(before.ok, true);
    if (!before.ok) throw new Error("expected ok");
    assert.deepEqual(
      before.hits.map((h) => h.qualifiedName).sort(),
      ["route.uncalledHelper"],
      "healthHandler excluded as a route handler",
    );

    // Second ingest: provide ONLY exports (omitting routes). The
    // route-handler flag MUST be preserved — the per-field semantics
    // say an omitted field leaves existing flags untouched. The old
    // delete-then-insert wiped both columns and re-classified
    // healthHandler as dead.
    const revised: StoreFileIR = {
      path: routeHandlerFile.path,
      language: routeHandlerFile.language,
      contentHash: "h-route-v2",
      symbols: routeHandlerFile.symbols,
      exports: [], // explicitly no exports; routes OMITTED
    };
    const r2 = await store.upsertFileBatch([revised]);
    assert.equal(r2.ok, true);
    const after = store.deadCode();
    assert.equal(after.ok, true);
    if (!after.ok) throw new Error("expected ok");
    assert.deepEqual(
      after.hits.map((h) => h.qualifiedName).sort(),
      ["route.uncalledHelper"],
      "healthHandler STILL excluded — routes flag preserved across a partial re-ingest",
    );
  } finally {
    await dispose(store, dir);
  }
});

test("deadCode: route handlers excluded via the named constant", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = await store.upsertFileBatch([routeHandlerFile]);
    assert.equal(r.ok, true);
    const out = store.deadCode();
    assert.equal(out.ok, true);
    if (!out.ok) throw new Error("expected ok");
    const qnames = out.hits.map((h) => h.qualifiedName).sort();
    // healthHandler is a route handler → excluded.
    // uncalledHelper is a private uncalled function → dead.
    assert.deepEqual(qnames, ["route.uncalledHelper"]);
  } finally {
    await dispose(store, dir);
  }
});

test("deadCode: entry-point file paths excluded via the named constant", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = await store.upsertFileBatch([deadCodeEntryFile]);
    assert.equal(r.ok, true);
    const out = store.deadCode();
    assert.equal(out.ok, true);
    if (!out.ok) throw new Error("expected ok");
    // src/index.ts matches ENTRY_POINT_PATH_PATTERNS → both symbols
    // excluded even though they are private and uncalled.
    assert.equal(out.hits.length, 0);
  } finally {
    await dispose(store, dir);
  }
});

test("deadCode: test files excluded via the named constant", async () => {
  const { store, dir } = await tempStore();
  try {
    const file: StoreFileIR = {
      path: "src/foo.test.ts",
      language: "typescript",
      contentHash: "h-test",
      symbols: [sym("test.private", "private", 0, 50)],
      edges: [],
    };
    const r = await store.upsertFileBatch([file]);
    assert.equal(r.ok, true);
    const out = store.deadCode();
    assert.equal(out.ok, true);
    if (!out.ok) throw new Error("expected ok");
    // Path matches TEST_PATH_PATTERNS → excluded.
    assert.equal(out.hits.length, 0);
  } finally {
    await dispose(store, dir);
  }
});

test("DEAD_CODE_EXCLUSION: named constant is exported and stable", () => {
  // The constant is the single source of truth for exclusion criteria
  // (rule 53 analog). Asserting its shape locks the public surface so
  // a refactor cannot silently drop an exclusion category.
  assert.ok(DEAD_CODE_EXCLUSION.INBOUND_USAGE_EDGE_TYPES.includes("CALLS"));
  assert.ok(DEAD_CODE_EXCLUSION.INBOUND_USAGE_EDGE_TYPES.includes("USES_TYPE"));
  assert.ok(
    DEAD_CODE_EXCLUSION.EXCLUDED_ATTRIBUTE_FLAGS.includes("is_exported"),
  );
  assert.ok(
    DEAD_CODE_EXCLUSION.EXCLUDED_ATTRIBUTE_FLAGS.includes("is_route_handler"),
  );
  assert.ok(DEAD_CODE_EXCLUSION.TEST_PATH_PATTERNS.length > 0);
  assert.ok(DEAD_CODE_EXCLUSION.ENTRY_POINT_PATH_PATTERNS.length > 0);
});

// ──────────────────────────────────────────────────────────────────────────
// snippetFor(): read spans from disk.
// ──────────────────────────────────────────────────────────────────────────

test("snippetFor: reads the exact span from disk via repoRoot", async () => {
  const { store, dir, repoRoot } = await tempStore();
  try {
    // Write a real source file under repoRoot so snippetFor can read it.
    // The span [4, 18) covers "function greet()" in the source.
    // 0:'a' 1:'=' 2:'1' 3:';' 4:'f' 5:'u' ... → "function greet()".
    const src = "a=1;function greet(){return 1;}\n";
    // Find the byte offsets for `function greet()`.
    const start = src.indexOf("function greet()");
    const end = start + "function greet()".length;
    await mkdir(path.dirname(path.join(repoRoot, "src/snippet.ts")), {
      recursive: true,
    });
    await writeFile(path.join(repoRoot, "src/snippet.ts"), src);

    const file: StoreFileIR = {
      path: "src/snippet.ts",
      language: "typescript",
      contentHash: "h-snippet",
      symbols: [sym("snip.greet", "greet", start, end)],
    };
    const r = await store.upsertFileBatch([file]);
    assert.equal(r.ok, true);

    const out = await store.snippetFor({ qualifiedName: "snip.greet" });
    assert.equal(out.ok, true);
    if (!out.ok) throw new Error("expected ok");
    assert.equal(out.text, "function greet()");
    assert.equal(out.startByte, start);
    assert.equal(out.endByte, end);
    assert.equal(out.filePath, "src/snippet.ts");
    assert.equal(out.lang, "typescript");
    assert.ok(path.isAbsolute(out.absolutePath));
  } finally {
    await dispose(store, dir);
  }
});

test("snippetFor: contextLines expands line-aligned", async () => {
  const { store, dir, repoRoot } = await tempStore();
  try {
    const lines = ["line one\n", "line two\n", "line three\n", "line four\n"];
    const src = lines.join("");
    // span covers all of "line two" (line index 1).
    const start = src.indexOf("line two");
    const end = start + "line two".length;
    await mkdir(path.dirname(path.join(repoRoot, "src/ctx.ts")), {
      recursive: true,
    });
    await writeFile(path.join(repoRoot, "src/ctx.ts"), src);

    const file: StoreFileIR = {
      path: "src/ctx.ts",
      language: "typescript",
      contentHash: "h-ctx",
      symbols: [sym("ctx.fn", "fn", start, end)],
    };
    const r = await store.upsertFileBatch([file]);
    assert.equal(r.ok, true);

    // contextLines: 1 → expand one line before + one line after.
    const out = await store.snippetFor({
      qualifiedName: "ctx.fn",
      contextLines: 1,
    });
    assert.equal(out.ok, true);
    if (!out.ok) throw new Error("expected ok");
    // Expected to include "line one\nline two\nline three\n".
    assert.equal(out.text, "line one\nline two\nline three\n");
  } finally {
    await dispose(store, dir);
  }
});

test("snippetFor: returns 'repo_root_unset' when repoRoot was not provided", async () => {
  // tempStore with no repoRoot passed → store carries the temp dir as
  // repoRoot. Override by opening directly with no repoRoot.
  const dir = await mkdtemp(path.join(tmpdir(), "coding-graph-pr2-noroot-"));
  try {
    const store = await GraphStore.open({
      dbPath: path.join(dir, "graph.sqlite"),
      // No repoRoot.
    });
    const file: StoreFileIR = {
      path: "src/x.ts",
      language: "typescript",
      contentHash: "h-x",
      symbols: [sym("x.fn", "fn", 0, 10)],
    };
    const r = await store.upsertFileBatch([file]);
    assert.equal(r.ok, true);

    const out = await store.snippetFor({ qualifiedName: "x.fn" });
    assert.equal(out.ok, false);
    if (out.ok) throw new Error("expected failure");
    assert.equal(out.code, "repo_root_unset");
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snippetFor: returns 'not_found' for unknown qualifiedName", async () => {
  const { store, dir } = await tempStore();
  try {
    const out = await store.snippetFor({ qualifiedName: "no.such.symbol" });
    assert.equal(out.ok, false);
    if (out.ok) throw new Error("expected failure");
    assert.equal(out.code, "not_found");
  } finally {
    await dispose(store, dir);
  }
});

test("snippetFor: returns 'read_failed' when the on-disk file is missing", async () => {
  const { store, dir, repoRoot } = await tempStore();
  try {
    const file: StoreFileIR = {
      path: "src/missing.ts",
      language: "typescript",
      contentHash: "h-missing",
      symbols: [sym("m.fn", "fn", 0, 10)],
    };
    const r = await store.upsertFileBatch([file]);
    assert.equal(r.ok, true);
    // Note: the file is NOT created on disk under repoRoot.

    const out = await store.snippetFor({ qualifiedName: "m.fn" });
    assert.equal(out.ok, false);
    if (out.ok) throw new Error("expected failure");
    assert.equal(out.code, "read_failed");
  } finally {
    await dispose(store, dir);
  }
});

test("snippetFor: 'ambiguous_name' when qualifiedName exists in two files", async () => {
  const { store, dir } = await tempStore();
  try {
    const f1: StoreFileIR = {
      path: "src/a1.ts",
      language: "typescript",
      contentHash: "h1",
      symbols: [sym("amb.fn", "fn", 0, 10)],
    };
    const f2: StoreFileIR = {
      path: "src/a2.ts",
      language: "typescript",
      contentHash: "h2",
      symbols: [sym("amb.fn", "fn", 0, 10)],
    };
    const r = await store.upsertFileBatch([f1, f2]);
    assert.equal(r.ok, true);

    const out = await store.snippetFor({ qualifiedName: "amb.fn" });
    assert.equal(out.ok, false);
    if (out.ok) throw new Error("expected failure");
    assert.equal(out.code, "ambiguous_name");
  } finally {
    await dispose(store, dir);
  }
});

test("snippetFor: returns 'store_closed' when the store is closed (cursor Bugbot + chatgpt-codex-connector P2)", async () => {
  const { store, dir, repoRoot } = await tempStore();
  try {
    const file: StoreFileIR = {
      path: "src/closed.ts",
      language: "typescript",
      contentHash: "h-closed",
      symbols: [sym("closed.fn", "fn", 0, 10)],
    };
    const r = await store.upsertFileBatch([file]);
    await mkdir(path.dirname(path.join(repoRoot, "src/closed.ts")), {
      recursive: true,
    });
    await writeFile(path.join(repoRoot, "src/closed.ts"), "function fn() {}\n");

    await store.close();
    const out = await store.snippetFor({ qualifiedName: "closed.fn" });
    assert.equal(out.ok, false);
    if (out.ok) throw new Error("expected failure");
    // Must be store_closed (the store is closed), NOT repo_root_unset
    // (repoRoot IS set) — callers need to distinguish the two.
    assert.equal(out.code, "store_closed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// deadCode(): self-edge must not count as inbound usage
// (chatgpt-codex-connector P2: 'Ignore self-edges in dead-code
// reachability').
// ──────────────────────────────────────────────────────────────────────────

test("deadCode: a private recursive helper whose only edge is a self-call IS reported as dead", async () => {
  // recurse.ts defines `run` whose only edge is run → run. Nothing
  // outside reaches it, so it is dead code; the self-call must NOT
  // count as external inbound usage.
  const { store, dir } = await tempStore();
  try {
    const file: StoreFileIR = {
      path: "src/recurse.ts",
      language: "typescript",
      contentHash: "h-recurse",
      symbols: [sym("recurse.run", "run", 0, 10)],
      edges: [edge("recurse.run", "recurse.run")],
    };
    const res = await store.upsertFileBatch([file]);
    if (!res.ok) throw new Error(`expected ok upsert; got ${res.code}`);
    const dead = store.deadCode();
    if (!dead.ok) throw new Error(`expected ok deadCode; got ${dead.code}`);
    const names = dead.hits.map((h) => h.name);
    assert.ok(
      names.includes("run"),
      `self-only-recursive symbol must be reported as dead; got ${JSON.stringify(names)}`,
    );
  } finally {
    await dispose(store, dir);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// upsertFileBatch: malformed (non-array) exports / routes are rejected
// at the boundary so they cannot wipe existing attribute flags
// (chatgpt-codex-connector P2: 'Validate attribute arrays before
// clearing flags').
// ──────────────────────────────────────────────────────────────────────────

test("upsertFileBatch: non-array exports rejected before wiping flags", async () => {
  const { store, dir } = await tempStore();
  try {
    const file = {
      path: "src/bad.ts",
      language: "typescript",
      contentHash: "h-bad",
      symbols: [sym("bad.fn", "fn", 0, 10)],
      // A JSON caller bypassing types could pass a bare string; this
      // is iterable char-by-char and would otherwise wipe flags.
      exports: "publicApi",
      edges: [],
    } as unknown as StoreFileIR;
    await assert.rejects(
      store.upsertFileBatch([file]),
      /exports must be an array when present/,
      "a non-array exports field must be rejected, not silently wipe is_exported",
    );
  } finally {
    await dispose(store, dir);
  }
});

test("upsertFileBatch: non-array routes rejected before wiping flags", async () => {
  const { store, dir } = await tempStore();
  try {
    const file = {
      path: "src/badr.ts",
      language: "typescript",
      contentHash: "h-badr",
      symbols: [sym("badr.fn", "fn", 0, 10)],
      routes: "GET /x",
      edges: [],
    } as unknown as StoreFileIR;
    await assert.rejects(
      store.upsertFileBatch([file]),
      /routes must be an array when present/,
      "a non-array routes field must be rejected, not silently wipe is_route_handler",
    );
  } finally {
    await dispose(store, dir);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Read APIs honor the tagged-failure contract: an unexpected SQLite
// error returns { ok:false, code:"db_error" } instead of throwing, so
// callers that exhaustively switch on result.code never crash
// (cursor Bugbot: 'Read APIs rethrow SQLite errors';
// chatgpt-codex-connector P2: 'Return tagged failures from read
// queries').
// ──────────────────────────────────────────────────────────────────────────

test("read APIs return 'db_error' instead of throwing on an unexpected SQLite failure", async () => {
  const { store, dir } = await tempStore();
  const dbPath = path.join(dir, "graph.sqlite");
  try {
    const file: StoreFileIR = {
      path: "src/n.ts",
      language: "typescript",
      contentHash: "h-n",
      symbols: [sym("n.a", "a", 0, 10)],
      edges: [],
    };
    const res = await store.upsertFileBatch([file]);
    if (!res.ok) throw new Error(`expected ok upsert; got ${res.code}`);
    // Sabotage: drop the edges table via a second connection so the
    // next traverse() edges query fails with "no such table" — a
    // non-lock, non-corrupt error that previously escaped as a throw.
    const sabotage = openBetterSqlite3(dbPath);
    sabotage.exec("DROP TABLE edges");
    sabotage.close();
    const out = store.traverse({ start: "n.a", maxDepth: 1 });
    assert.equal(out.ok, false, "traverse must not throw on a DB error");
    if (!out.ok) {
      assert.equal(
        out.code,
        "db_error",
        `unexpected SQLite error must map to db_error, not throw; got ${out.code}`,
      );
    }
  } finally {
    await dispose(store, dir);
  }
});

test("traverse: non-string start rejected with 'invalid_query' before binding (chatgpt-codex-connector P2)", async () => {
  const { store, dir } = await tempStore();
  try {
    for (const bad of [
      42,
      null,
      undefined,
      { name: "x" },
      [1, 2],
      "",
    ] as unknown[]) {
      const out = store.traverse({
        start: bad as never,
        maxDepth: 1,
      });
      assert.equal(out.ok, false, `non-string start ${JSON.stringify(bad)} must not succeed`);
      if (!out.ok) {
        assert.equal(
          out.code,
          "invalid_query",
          `non-string start must return invalid_query, not ${out.code}`,
        );
      }
    }
  } finally {
    await dispose(store, dir);
  }
});
