/**
 * openCypher read-subset accept/reject suites — issue #1552 PR3 done-when.
 *
 * Two suites, both prove-fail-before (a deliberate break of the grammar
 * or the rejection table on a scratch branch fails the suite):
 *
 *   ACCEPT: every documented form parses AND executes against a fixture
 *           graph, returning the exact expected rows.
 *   REJECT: every entry in the rejection table produces a clear tagged
 *           failure with the right code + a message naming the supported
 *           grammar.
 *
 * Fixture IR is synthetic (public-repo policy). The graph is small enough
 * that the executor's searchGraph-then-traverse compilation target is
 * deterministic — we assert exact sets, not "at least one hit".
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GraphStore,
  type EdgeIR,
  type StoreFileIR,
  type SymbolIR,
} from "../graph-store.js";
import {
  CYPHER_LABEL_TO_DB_LABEL,
  executeCypher,
  parseCypher,
  VALID_CYPHER_LABELS,
  type CypherNodeValue,
} from "./query-parser.js";

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

function edge(
  srcQualifiedName: string,
  dstQualifiedName: string,
  type = "CALLS",
  confidence = 0.9,
  provenance: EdgeIR["provenance"] = "heuristic",
): EdgeIR {
  return { srcQualifiedName, dstQualifiedName, type, confidence, provenance };
}

/**
 * The fixture graph (all in one file so node identity is unambiguous):
 *
 *   app.bootstrap (function) ──CALLS──> app.runServer (function)
 *   app.runServer (function) ──CALLS──> app.handleRequest (function)
 *   app.handleRequest (function) ──CALLS──> db.query (function)
 *   app.handleRequest (function) ──USES_TYPE──> db.QueryResult (type)
 *   app.runServer (function) ──IMPORTS──> lib.configHelper (function)
 *
 *   util.format (function) — isolated, zero inbound edges → dead code.
 */
const fixtureFile: StoreFileIR = {
  path: "src/app.ts",
  language: "typescript",
  contentHash: "h-fixture",
  symbols: [
    sym("app.bootstrap", "bootstrap", 0, 50, "function"),
    sym("app.runServer", "runServer", 50, 200, "function"),
    sym("app.handleRequest", "handleRequest", 200, 400, "function"),
    sym("db.query", "query", 400, 500, "function"),
    sym("db.QueryResult", "QueryResult", 500, 600, "type"),
    sym("lib.configHelper", "configHelper", 600, 700, "function"),
    sym("util.format", "format", 700, 800, "function"),
  ],
  edges: [
    edge("app.bootstrap", "app.runServer"),
    edge("app.runServer", "app.handleRequest"),
    edge("app.handleRequest", "db.query"),
    edge("app.handleRequest", "db.QueryResult", "USES_TYPE"),
    edge("app.runServer", "lib.configHelper", "IMPORTS"),
  ],
};

async function tempStoreWithFixture(): Promise<{
  store: GraphStore;
  dir: string;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "cypher-pr3-"));
  const store = await GraphStore.open({
    dbPath: path.join(dir, "graph.sqlite"),
    repoRoot: dir,
  });
  const r = await store.upsertFileBatch([fixtureFile]);
  assert.equal(r.ok, true, "fixture ingest must succeed");
  return { store, dir };
}

async function dispose(store: GraphStore, dir: string): Promise<void> {
  await store.close();
  await rm(dir, { recursive: true, force: true });
}

/** Convenience: execute + assert ok, returning the rows. */
async function run(
  store: GraphStore,
  query: string,
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const r = executeCypher(store, query);
  if (!r.ok) {
    assert.fail(`Query unexpectedly failed: ${r.code}: ${r.message}\n  query: ${query}`);
  }
  return { columns: r.columns, rows: r.rows };
}

/** Convenience: assert a query fails with the given code. */
function reject(
  store: GraphStore,
  query: string,
  expectedCode: string,
): void {
  const r = executeCypher(store, query);
  assert.equal(r.ok, false, `Query unexpectedly succeeded: ${query}`);
  if (r.ok) return;
  assert.equal(
    r.code,
    expectedCode,
    `Wrong failure code for ${JSON.stringify(query)}: expected ${expectedCode}, got ${r.code} (${r.message})`,
  );
}

/** Parse-only reject (no store needed). */
function rejectParse(query: string, expectedCode: string): void {
  const r = parseCypher(query);
  assert.equal(r.ok, false, `Query unexpectedly parsed: ${query}`);
  if (r.ok) return;
  assert.equal(
    r.code,
    expectedCode,
    `Wrong parse code for ${JSON.stringify(query)}: expected ${expectedCode}, got ${r.code} (${r.message})`,
  );
}

// ──────────────────────────────────────────────────────────────────────────
// ACCEPT — single-node MATCH (compiles to searchGraph).
// ──────────────────────────────────────────────────────────────────────────

test("ACCEPT: MATCH (f:Function) RETURN f — returns every function node", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { columns, rows } = await run(store, "MATCH (f:Function) RETURN f");
    assert.deepEqual(columns, ["f"]);
    // bootstrap, runServer, handleRequest, query, configHelper, format = 6.
    assert.equal(rows.length, 6);
    const names = rows
      .map((r) => (r.f as CypherNodeValue).name)
      .sort();
    assert.deepEqual(names, [
      "bootstrap",
      "configHelper",
      "format",
      "handleRequest",
      "query",
      "runServer",
    ]);
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: label maps PascalCase → lowercase kind (Type → type)", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { rows } = await run(store, "MATCH (t:Type) RETURN t.qualifiedName");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!["t.qualifiedName"], "db.QueryResult");
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: no label returns every node (cap'd by LIMIT)", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { rows } = await run(store, "MATCH (n) RETURN n LIMIT 3");
    assert.equal(rows.length, 3);
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: inline property filter {name: \"query\"} narrows by exact name", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { rows } = await run(
      store,
      'MATCH (f:Function {name: "query"}) RETURN f.qualifiedName',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!["f.qualifiedName"], "db.query");
  } finally {
    await dispose(store, dir);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ACCEPT — WHERE clause.
// ──────────────────────────────────────────────────────────────────────────

test("ACCEPT: WHERE = string", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { rows } = await run(
      store,
      'MATCH (f:Function) WHERE f.name = "runServer" RETURN f.qualifiedName',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!["f.qualifiedName"], "app.runServer");
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: WHERE <> filters out", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { rows } = await run(
      store,
      'MATCH (f:Function) WHERE f.name <> "runServer" RETURN f.name',
    );
    assert.equal(rows.length, 5);
    assert.ok(!rows.some((r) => r["f.name"] === "runServer"));
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: WHERE OR-of-AND precedence", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    // name = bootstrap OR name = query → 2 rows (OR splits the group).
    const { rows } = await run(
      store,
      'MATCH (f:Function) WHERE f.name = "bootstrap" OR f.name = "query" RETURN f.name',
    );
    const names = rows.map((r) => r["f.name"]).sort();
    assert.deepEqual(names, ["bootstrap", "query"]);
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: WHERE AND combines within a group", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    // label = function AND name = query → exactly db.query.
    const { rows } = await run(
      store,
      'MATCH (n) WHERE n.label = "function" AND n.name = "query" RETURN n.qualifiedName',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!["n.qualifiedName"], "db.query");
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: WHERE on label property (kind alias)", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { rows } = await run(
      store,
      'MATCH (n) WHERE n.kind = "type" RETURN n.qualifiedName',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!["n.qualifiedName"], "db.QueryResult");
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: WHERE on snake_case alias file_path", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { rows } = await run(
      store,
      'MATCH (f:Function) WHERE f.file_path = "src/app.ts" RETURN f.name LIMIT 2',
    );
    assert.equal(rows.length, 2);
  } finally {
    await dispose(store, dir);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ACCEPT — single-edge relationships (compile to traverse depth==1).
// ──────────────────────────────────────────────────────────────────────────

test("ACCEPT: (a)-[:CALLS]->(b) — direct outgoing CALLS edges", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { columns, rows } = await run(
      store,
      "MATCH (a:Function)-[:CALLS]->(b:Function) RETURN a.name, b.name",
    );
    assert.deepEqual(columns, ["a.name", "b.name"]);
    // bootstrap→runServer, runServer→handleRequest, handleRequest→query.
    const pairs = rows
      .map((r) => `${r["a.name"]}→${r["b.name"]}`)
      .sort();
    assert.deepEqual(pairs, [
      "bootstrap→runServer",
      "handleRequest→query",
      "runServer→handleRequest",
    ]);
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: incoming direction <-[:CALLS]- finds what the source calls", async () => {
  // `(target)<-[:CALLS]-(src)` means src CALLS target. With src=handleRequest,
  // target = whatever handleRequest calls = db.query.
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { rows } = await run(
      store,
      'MATCH (target:Function)<-[:CALLS]-(src:Function {name: "handleRequest"}) RETURN target.name',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!["target.name"], "query");
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: undirected -[:CALLS]- matches both directions", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { rows } = await run(
      store,
      'MATCH (a:Function)-[:CALLS]-(b:Function {name: "query"}) RETURN a.name',
    );
    // query has one inbound CALLS (from handleRequest); no outbound.
    const names = rows.map((r) => r["a.name"]).sort();
    assert.deepEqual(names, ["handleRequest"]);
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: edge-type alternation -[:CALLS|USES_TYPE]->", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { rows } = await run(
      store,
      "MATCH (a:Function)-[:CALLS|USES_TYPE]->(b) RETURN b.qualifiedName",
    );
    const qnames = rows
      .map((r) => r["b.qualifiedName"] as string)
      .sort();
    // CALLS targets: runServer, handleRequest, query.
    // USES_TYPE targets: QueryResult.
    assert.deepEqual(qnames, [
      "app.handleRequest",
      "app.runServer",
      "db.QueryResult",
      "db.query",
    ]);
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: edge types not in the documented set still pass through", async () => {
  // The store has no CHECK on edge type; the Cypher layer documents the
  // 20+ set but accepts any string and returns no rows for unknown types
  // (matching traverse's behavior).
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { rows } = await run(
      store,
      "MATCH (a)-[:NOT_A_REAL_TYPE]->(b) RETURN a.name",
    );
    assert.equal(rows.length, 0);
  } finally {
    await dispose(store, dir);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ACCEPT — variable-length paths (compile to traverse depth ∈ [min,max]).
// ──────────────────────────────────────────────────────────────────────────

test("ACCEPT: *1..2 reaches two hops out", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    // From bootstrap, CALLS*1..2 reaches: runServer (1), handleRequest (2).
    const { rows } = await run(
      store,
      'MATCH (a:Function {name: "bootstrap"})-[:CALLS*1..2]->(b) RETURN b.qualifiedName',
    );
    const qnames = rows
      .map((r) => r["b.qualifiedName"] as string)
      .sort();
    assert.deepEqual(qnames, ["app.handleRequest", "app.runServer"]);
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: *2 exactly two hops (excludes depth 1)", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { rows } = await run(
      store,
      'MATCH (a:Function {name: "bootstrap"})-[:CALLS*2]->(b) RETURN b.qualifiedName',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!["b.qualifiedName"], "app.handleRequest");
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: *..3 defaults min to 1, includes 1..3 hops", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { rows } = await run(
      store,
      'MATCH (a:Function {name: "bootstrap"})-[:CALLS*..3]->(b) RETURN b.qualifiedName',
    );
    const qnames = rows
      .map((r) => r["b.qualifiedName"] as string)
      .sort();
    assert.deepEqual(qnames, [
      "app.handleRequest",
      "app.runServer",
      "db.query",
    ]);
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: multi-hop path chains (a)-[:CALLS]->(b)-[:CALLS]->(c)", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { rows } = await run(
      store,
      "MATCH (a:Function)-[:CALLS]->(b:Function)-[:CALLS]->(c:Function) RETURN a.name, c.name",
    );
    // Two 2-hop chains: bootstrap→runServer→handleRequest, runServer→handleRequest→query.
    const pairs = rows
      .map((r) => `${r["a.name"]}…${r["c.name"]}`)
      .sort();
    assert.deepEqual(pairs, [
      "bootstrap…handleRequest",
      "runServer…query",
    ]);
  } finally {
    await dispose(store, dir);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ACCEPT — anonymous nodes (cursor Bugbot: 'Anonymous nodes break path
// expansion'). An anonymous node `()` participates in the path but is not
// bound to a variable; the executor tracks the positional cursor so the
// path flows through it.
// ──────────────────────────────────────────────────────────────────────────

test("ACCEPT: anonymous FIRST node — ()-[:CALLS]->(b) enumerates all starts", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    // Every node with an outgoing CALLS edge is a valid (anon) start.
    // b = the CALLS target. Distinct b targets: runServer, handleRequest, query.
    const { rows } = await run(
      store,
      "MATCH ()-[:CALLS]->(b:Function) RETURN b.qualifiedName",
    );
    const qnames = rows
      .map((r) => r["b.qualifiedName"] as string)
      .sort();
    assert.deepEqual(qnames, [
      "app.handleRequest",
      "app.runServer",
      "db.query",
    ]);
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: anonymous MIDDLE node — path flows through ()", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    // (a)-[:CALLS]->()-[:CALLS]->(c): the middle node is anonymous but
    // the 2-hop path still resolves. Same result as the named-middle
    // chain test above.
    const { rows } = await run(
      store,
      "MATCH (a:Function)-[:CALLS]->()-[:CALLS]->(c:Function) RETURN a.name, c.name",
    );
    const pairs = rows
      .map((r) => `${r["a.name"]}…${r["c.name"]}`)
      .sort();
    assert.deepEqual(pairs, [
      "bootstrap…handleRequest",
      "runServer…query",
    ]);
  } finally {
    await dispose(store, dir);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ACCEPT — inline-property pushdown narrows the start set before the cap
// (cursor Bugbot: 'Start search truncates before filters'). A specific name
// pushes down to searchGraph's namePattern so a low-degree node is still
// found even when the graph exceeds the 1000-row cap.
// ──────────────────────────────────────────────────────────────────────────

test("ACCEPT: inline name filter on a low-degree node still resolves", async () => {
  // util.format has zero inbound edges (dead code) → degree 0, ranked last
  // by searchGraph's degree-desc ordering. Without the pushdown a graph
  // with >1000 higher-degree nodes would truncate it out; the pushdown
  // narrows by name first so it is always found.
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { rows } = await run(
      store,
      'MATCH (f:Function {name: "format"}) RETURN f.qualifiedName',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!["f.qualifiedName"], "util.format");
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: wrong-type inline literal matches nothing (standard Cypher, not a parse error)", async () => {
  // {name: 123} is valid syntax; a numeric name never equals a string name,
  // so the result is empty (no tagged failure). This is standard Cypher
  // behavior, documented in the module's rejection-table note.
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { rows } = await run(
      store,
      "MATCH (f:Function {name: 123}) RETURN f.name",
    );
    assert.equal(rows.length, 0);
  } finally {
    await dispose(store, dir);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ACCEPT — review-round-2 hardening: relationship-target :Label enforcement,
// WHERE first-variable pushdown, and LIKE-wildcard guard in the pushdown.
// ──────────────────────────────────────────────────────────────────────────

test("ACCEPT: relationship target :Label is enforced (cursor Bugbot: 'Relationship node labels not enforced')", async () => {
  // Fixture: app.handleRequest (Function) -[:USES_TYPE]-> db.QueryResult (Type).
  // Before the fix, matchesNodePattern ignored the parsed :Label on
  // relationship targets, so `...->(b:Function)` WRONGLY returned the Type
  // node for `b`. Now the parsed label is enforced.
  const { store, dir } = await tempStoreWithFixture();
  try {
    const typed = await run(
      store,
      "MATCH (a:Function)-[:USES_TYPE]->(b:Type) RETURN b.qualifiedName",
    );
    assert.deepEqual(typed.rows.map((r) => r["b.qualifiedName"]), [
      "db.QueryResult",
    ]);
    // Requiring the target to be a Function excludes the Type node —
    // before the fix this returned db.QueryResult.
    const noFn = await run(
      store,
      "MATCH (a:Function)-[:USES_TYPE]->(b:Function) RETURN b.qualifiedName",
    );
    assert.equal(noFn.rows.length, 0);
    // Symmetric on CALLS: no Type node is the target of a CALLS edge.
    const noTypeOverCalls = await run(
      store,
      "MATCH (a:Function)-[:CALLS]->(b:Type) RETURN b.qualifiedName",
    );
    assert.equal(noTypeOverCalls.rows.length, 0);
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: WHERE f.name = ... on the first var narrows before the cap (single conjunction pushdown)", async () => {
  // `MATCH (f) WHERE f.name = "x"` pushes the equality down to the index
  // when WHERE is a single conjunction (no top-level OR), so the named
  // node is found before the 1000-row cap. Parity with the inline form.
  const { store, dir } = await tempStoreWithFixture();
  try {
    const whereForm = await run(
      store,
      'MATCH (f:Function) WHERE f.name = "handleRequest" RETURN f.qualifiedName',
    );
    assert.deepEqual(whereForm.rows.map((r) => r["f.qualifiedName"]), [
      "app.handleRequest",
    ]);
    const inlineForm = await run(
      store,
      'MATCH (f:Function {name: "handleRequest"}) RETURN f.qualifiedName',
    );
    assert.deepEqual(inlineForm.rows.map((r) => r["f.qualifiedName"]), [
      "app.handleRequest",
    ]);
    // OR (multiple groups) is NOT pushed down — but still resolves
    // correctly via the post-filter, proving the conservative branch.
    const orForm = await run(
      store,
      'MATCH (f:Function) WHERE f.name = "bootstrap" OR f.name = "query" RETURN f.name',
    );
    assert.deepEqual(
      orForm.rows.map((r) => r["f.name"]).sort(),
      ["bootstrap", "query"],
    );
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: name containing a LIKE metacharacter resolves exactly (pushdown wildcard guard)", async () => {
  // A literal `_` in the value must not be pushed to searchGraph's LIKE
  // matcher (which treats `_` as a single-char wildcard). The value falls
  // back to the capped label scan + exact post-filter and still resolves
  // to the single exact match — not the wildcard neighbour.
  const dir = await mkdtemp(path.join(tmpdir(), "cypher-wild-"));
  const store = await GraphStore.open({
    dbPath: path.join(dir, "graph.sqlite"),
    repoRoot: dir,
  });
  try {
    const file: StoreFileIR = {
      path: "src/w.ts",
      language: "typescript",
      contentHash: "h-wild",
      symbols: [
        sym("w.foo_bar", "foo_bar", 0, 10, "function"),
        sym("w.foozbar", "foozbar", 10, 20, "function"),
      ],
      edges: [],
    };
    const r = await store.upsertFileBatch([file]);
    assert.equal(r.ok, true, "fixture ingest must succeed");
    const { rows } = await run(
      store,
      'MATCH (f:Function {name: "foo_bar"}) RETURN f.qualifiedName',
    );
    assert.deepEqual(rows.map((row) => row["f.qualifiedName"]), ["w.foo_bar"]);
  } finally {
    await dispose(store, dir);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ACCEPT — LIMIT.
// ──────────────────────────────────────────────────────────────────────────

test("ACCEPT: LIMIT caps the row count", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { rows } = await run(
      store,
      "MATCH (f:Function) RETURN f.name LIMIT 2",
    );
    assert.equal(rows.length, 2);
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: LIMIT 0 returns zero rows (rule 27 guard)", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { rows } = await run(
      store,
      "MATCH (f:Function) RETURN f.name LIMIT 0",
    );
    assert.equal(rows.length, 0);
  } finally {
    await dispose(store, dir);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ACCEPT — case-insensitive keywords + comments.
// ──────────────────────────────────────────────────────────────────────────

test("ACCEPT: keywords are case-insensitive", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { rows } = await run(
      store,
      'match (f:Function) where f.name = "query" return f.qualifiedName',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!["f.qualifiedName"], "db.query");
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: line and block comments are skipped", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { rows } = await run(
      store,
      'MATCH (f:Function) // find query\n/* block */ WHERE f.name = "query" RETURN f.name',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!["f.name"], "query");
  } finally {
    await dispose(store, dir);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// REJECT — write / outside clauses.
// ──────────────────────────────────────────────────────────────────────────

test("REJECT: CREATE is rejected as unsupported_clause", () => {
  rejectParse("CREATE (n:Function)", "unsupported_clause");
});

test("REJECT: MERGE is rejected as unsupported_clause", () => {
  rejectParse("MERGE (n:Function)", "unsupported_clause");
});

test("REJECT: SET is rejected as unsupported_clause", () => {
  rejectParse("MATCH (n) SET n.x = 1", "unsupported_clause");
});

test("REJECT: DELETE is rejected as unsupported_clause", () => {
  rejectParse("MATCH (n) DELETE n", "unsupported_clause");
});

test("REJECT: DETACH DELETE is rejected as unsupported_clause", () => {
  rejectParse("MATCH (n) DETACH DELETE n", "unsupported_clause");
});

test("REJECT: REMOVE is rejected as unsupported_clause", () => {
  rejectParse("MATCH (n) REMOVE n.x", "unsupported_clause");
});

test("REJECT: ORDER BY is rejected as unsupported_clause", () => {
  rejectParse("MATCH (n) RETURN n ORDER BY n.name", "unsupported_clause");
});

test("REJECT: WITH is rejected as unsupported_clause", () => {
  rejectParse("MATCH (n) WITH n RETURN n", "unsupported_clause");
});

test("REJECT: UNION is rejected as unsupported_clause", () => {
  rejectParse(
    "MATCH (n) RETURN n UNION MATCH (m) RETURN m",
    "unsupported_clause",
  );
});

test("REJECT: RETURN * is rejected (outside subset)", () => {
  rejectParse("MATCH (n) RETURN *", "unsupported_clause");
});

// ──────────────────────────────────────────────────────────────────────────
// REJECT — unbounded variable-length.
// ──────────────────────────────────────────────────────────────────────────

test("REJECT: bare * (unbounded) is rejected", () => {
  rejectParse("MATCH (a)-[:CALLS*]->(b) RETURN b", "unsupported_clause");
});

test("REJECT: *.. (unbounded max) is rejected", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    reject(store, "MATCH (a)-[:CALLS*1..]->(b) RETURN b", "unsupported_clause");
  } finally {
    await dispose(store, dir);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// REJECT — unknown labels list valid options.
// ──────────────────────────────────────────────────────────────────────────

test("REJECT: unknown label produces unknown_label with validLabels", () => {
  const r = parseCypher("MATCH (a:NotALabel) RETURN a");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "unknown_label");
  assert.ok(r.validLabels, "validLabels must be present on unknown_label");
  // The valid list is exactly the documented universe, sorted.
  assert.deepEqual(r.validLabels, [...VALID_CYPHER_LABELS]);
  // Message names the bad label and the supported grammar.
  assert.match(r.message, /NotALabel/);
});

test("REJECT: lowercase 'function' is NOT a valid Cypher label (case-sensitive labels)", () => {
  // Cypher labels are case-sensitive PascalCase identifiers. The DB
  // stores lowercase kinds; the Cypher layer maps PascalCase→lowercase
  // internally. A user writing `:function` gets unknown_label with the
  // valid (PascalCase) options listed.
  const r = parseCypher("MATCH (a:function) RETURN a");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "unknown_label");
});

// ──────────────────────────────────────────────────────────────────────────
// REJECT — structural / unbound variable.
// ──────────────────────────────────────────────────────────────────────────

test("REJECT: RETURN references unbound variable", () => {
  rejectParse("MATCH (a:Function) RETURN a, c", "unbound_variable");
});

test("REJECT: WHERE references unbound variable", () => {
  rejectParse("MATCH (a:Function) WHERE c.name = \"x\" RETURN a", "unbound_variable");
});

test("REJECT: missing RETURN", () => {
  rejectParse("MATCH (a:Function)", "parse_error");
});

test("REJECT: missing closing paren", () => {
  rejectParse("MATCH (a:Function RETURN a", "parse_error");
});

test("REJECT: empty query", () => {
  rejectParse("", "parse_error");
  rejectParse("   ", "parse_error");
});

test("REJECT: non-string query", () => {
  const r = parseCypher(undefined as unknown as string);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "invalid_query");
});

// ──────────────────────────────────────────────────────────────────────────
// REJECT — bare-arrows / malformed relationships.
// ──────────────────────────────────────────────────────────────────────────

test("REJECT: bare arrow without bracket", () => {
  rejectParse("MATCH (a)-->(b) RETURN a", "parse_error");
});

test("REJECT: conflicting direction <-[...]->", () => {
  const r = parseCypher("MATCH (a)<-[:CALLS]->(b) RETURN a");
  assert.equal(r.ok, false);
  if (r.ok) return;
  // Either parse_error or unsupported — we accept either; the contract
  // is "rejected with a clear message", not a specific code here.
  assert.ok(["parse_error", "unsupported_clause", "invalid_query"].includes(r.code));
});

// ──────────────────────────────────────────────────────────────────────────
// REJECT — closed store.
// ──────────────────────────────────────────────────────────────────────────

test("REJECT: closed store returns store_closed", async () => {
  const { store, dir } = await tempStoreWithFixture();
  await dispose(store, dir);
  // store is now closed; executeCypher must surface store_closed from
  // the underlying searchGraph call.
  const r = executeCypher(store, "MATCH (f:Function) RETURN f");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "store_closed");
});

// ──────────────────────────────────────────────────────────────────────────
// Module-level invariants.
// ──────────────────────────────────────────────────────────────────────────

test("INVARIANT: every documented label maps to a db label", () => {
  for (const label of VALID_CYPHER_LABELS) {
    assert.ok(
      label in CYPHER_LABEL_TO_DB_LABEL,
      `${label} missing from CYPHER_LABEL_TO_DB_LABEL`,
    );
  }
});

test("INVARIANT: the 13 documented labels are all present", () => {
  // Project, Package, Folder, File, Module, Class, Function, Method,
  // Interface, Enum, Type, Route, Resource (issue #1552 body).
  const expected = [
    "Class",
    "Enum",
    "File",
    "Folder",
    "Function",
    "Interface",
    "Method",
    "Module",
    "Package",
    "Project",
    "Resource",
    "Route",
    "Type",
  ];
  assert.deepEqual([...VALID_CYPHER_LABELS].sort(), expected);
});


// ──────────────────────────────────────────────────────────────────────────
// ACCEPT — variable-length path enumeration (issue #1650).
// Exact `*N` (N > 1) must include nodes reachable at BOTH a shorter and a
// length-N path. The fixture has two paths to b (a->b at len 1, a->c->b at
// len 2) and a diamond to d (a->b->d, a->c->d, both len 2).
//
//   a -> b
//   a -> c
//   c -> b
//   b -> d
//   c -> d
// ──────────────────────────────────────────────────────────────────────────

const multiPathCypherFile: StoreFileIR = {
  path: "src/mp.ts",
  language: "typescript",
  contentHash: "h-mp",
  symbols: [
    sym("mp.a", "a", 0, 10),
    sym("mp.b", "b", 10, 20),
    sym("mp.c", "c", 20, 30),
    sym("mp.d", "d", 30, 40),
  ],
  edges: [
    edge("mp.a", "mp.b"),
    edge("mp.a", "mp.c"),
    edge("mp.c", "mp.b"),
    edge("mp.b", "mp.d"),
    edge("mp.c", "mp.d"),
  ],
};

async function tempStoreWithFile(
  file: StoreFileIR,
): Promise<{ store: GraphStore; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "cypher-1650-"));
  const store = await GraphStore.open({
    dbPath: path.join(dir, "graph.sqlite"),
    repoRoot: dir,
  });
  const r = await store.upsertFileBatch([file]);
  assert.equal(r.ok, true, "fixture ingest must succeed");
  return { store, dir };
}

test("ACCEPT: *N (N>1) includes a node reachable at a shorter AND a length-N path (issue #1650)", async () => {
  const { store, dir } = await tempStoreWithFile(multiPathCypherFile);
  try {
    // b is reachable at len 1 (a->b) AND len 2 (a->c->b). Under the old
    // BFS compile target, b was visited at depth 1 and dropped by the
    // depth==2 filter; the length-2 path a->c->b now qualifies it.
    const { rows } = await run(
      store,
      'MATCH (a:Function {name: "a"})-[:CALLS*2]->(b) RETURN b.qualifiedName',
    );
    const qnames = rows.map((r) => r["b.qualifiedName"] as string).sort();
    assert.deepEqual(qnames, ["mp.b", "mp.d"]);
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: *1..N unchanged — returns reachable nodes, no regression (issue #1650)", async () => {
  const { store, dir } = await tempStoreWithFile(multiPathCypherFile);
  try {
    // *1..2 from a: b (len1), c (len1), d (len2). Endpoint-dedup keeps
    // this identical to the prior BFS shortest-depth behavior.
    const { rows } = await run(
      store,
      'MATCH (a:Function {name: "a"})-[:CALLS*1..2]->(b) RETURN b.qualifiedName',
    );
    const qnames = rows.map((r) => r["b.qualifiedName"] as string).sort();
    assert.deepEqual(qnames, ["mp.b", "mp.c", "mp.d"]);
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: diamond *2 reaches the far node via either length-2 path", async () => {
  const { store, dir } = await tempStoreWithFile(multiPathCypherFile);
  try {
    // d is reachable only via length-2 paths (a->b->d, a->c->d). It must
    // appear in *2 results (deduped to one row).
    const { rows } = await run(
      store,
      'MATCH (a:Function {name: "a"})-[:CALLS*2]->(b) RETURN b.name',
    );
    const names = rows.map((r) => r["b.name"] as string).sort();
    assert.deepEqual(names, ["b", "d"]);
    // d appears exactly once (endpoint-dedup), not once per path.
    const dRows = rows.filter((r) => r["b.name"] === "d");
    assert.equal(dRows.length, 1);
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: *N on a cyclic graph terminates (cycle safety via relationship-uniqueness)", async () => {
  // a -> b -> c -> a (cycle) plus a self-edge on b.
  const cyclicFile: StoreFileIR = {
    path: "src/cyc.ts",
    language: "typescript",
    contentHash: "h-cyc",
    symbols: [
      sym("cyc.a", "a", 0, 10),
      sym("cyc.b", "b", 10, 20),
      sym("cyc.c", "c", 20, 30),
    ],
    edges: [
      edge("cyc.a", "cyc.b"),
      edge("cyc.b", "cyc.c"),
      edge("cyc.c", "cyc.a"),
      edge("cyc.b", "cyc.b"),
    ],
  };
  const { store, dir } = await tempStoreWithFile(cyclicFile);
  try {
    // Must complete (relationship-uniqueness bounds enumeration) and
    // return only nodes in the cycle.
    const { rows } = await run(
      store,
      'MATCH (a:Function {name: "a"})-[:CALLS*1..4]->(b) RETURN b.qualifiedName',
    );
    const qnames = rows.map((r) => r["b.qualifiedName"] as string).sort();
    assert.deepEqual(qnames, ["cyc.a", "cyc.b", "cyc.c"]);
  } finally {
    await dispose(store, dir);
  }
});
