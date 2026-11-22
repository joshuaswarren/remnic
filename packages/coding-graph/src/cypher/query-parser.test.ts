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
// ──────────────────────────────────────────────────────────────────────────

test("ACCEPT: MATCH (f:Function) RETURN f — returns every function node", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { columns, rows } = await run(store, "MATCH (f:Function) RETURN f");
    assert.deepEqual(columns, ["f"]);
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
// ──────────────────────────────────────────────────────────────────────────

test("ACCEPT: (a)-[:CALLS]->(b) — direct outgoing CALLS edges", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    const { columns, rows } = await run(
      store,
      "MATCH (a:Function)-[:CALLS]->(b:Function) RETURN a.name, b.name",
    );
    assert.deepEqual(columns, ["a.name", "b.name"]);
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
// ──────────────────────────────────────────────────────────────────────────

test("ACCEPT: *1..2 reaches two hops out", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
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
// ──────────────────────────────────────────────────────────────────────────

test("ACCEPT: anonymous FIRST node — ()-[:CALLS]->(b) enumerates all starts", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
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
// ──────────────────────────────────────────────────────────────────────────

test("ACCEPT: inline name filter on a low-degree node still resolves", async () => {
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
// ──────────────────────────────────────────────────────────────────────────

test("ACCEPT: relationship target :Label is enforced (cursor Bugbot: 'Relationship node labels not enforced')", async () => {
  const { store, dir } = await tempStoreWithFixture();
  try {
    const typed = await run(
      store,
      "MATCH (a:Function)-[:USES_TYPE]->(b:Type) RETURN b.qualifiedName",
    );
    assert.deepEqual(typed.rows.map((r) => r["b.qualifiedName"]), [
      "db.QueryResult",
    ]);
    const noFn = await run(
      store,
      "MATCH (a:Function)-[:USES_TYPE]->(b:Function) RETURN b.qualifiedName",
    );
    assert.equal(noFn.rows.length, 0);
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
// ──────────────────────────────────────────────────────────────────────────

test("REJECT: unknown label produces unknown_label with validLabels", () => {
  const r = parseCypher("MATCH (a:NotALabel) RETURN a");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "unknown_label");
  assert.ok(r.validLabels, "validLabels must be present on unknown_label");
  assert.deepEqual(r.validLabels, [...VALID_CYPHER_LABELS]);
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
// ──────────────────────────────────────────────────────────────────────────

test("REJECT: bare arrow without bracket", () => {
  rejectParse("MATCH (a)-->(b) RETURN a", "parse_error");
});

test("REJECT: conflicting direction <-[...]->", () => {
  const r = parseCypher("MATCH (a)<-[:CALLS]->(b) RETURN a");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(["parse_error", "unsupported_clause", "invalid_query"].includes(r.code));
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("REJECT: closed store returns store_closed", async () => {
  const { store, dir } = await tempStoreWithFixture();
  await dispose(store, dir);
  const r = executeCypher(store, "MATCH (f:Function) RETURN f");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "store_closed");
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("INVARIANT: every documented label maps to a db label", () => {
  for (const label of VALID_CYPHER_LABELS) {
    assert.ok(
      label in CYPHER_LABEL_TO_DB_LABEL,
      `${label} missing from CYPHER_LABEL_TO_DB_LABEL`,
    );
  }
});


test("REJECT: variable-length depth above the supported cap fails with invalid_query (not a silent empty result)", async () => {
  const { store, dir } = await tempStoreWithFile(multiPathCypherFile);
  try {
    const r = executeCypher(
      store,
      'MATCH (a:Function {name: "a"})-[:CALLS*2000]->(b) RETURN b',
    );
    assert.equal(r.ok, false, "*2000 must fail, not silently return an empty success");
    if (r.ok) throw new Error("expected failure");
    assert.equal(r.code, "invalid_query");
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: truncated flag surfaces when variable-length enumeration hits the path cap (cursor Bugbot)", async () => {
  const N = 23;
  const symbols: SymbolIR[] = [];
  for (let i = 0; i < N; i += 1) {
    symbols.push(sym("cp." + i, String(i), i * 10, i * 10 + 9));
  }
  const edges: EdgeIR[] = [];
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) {
      if (i !== j) edges.push(edge("cp." + i, "cp." + j));
    }
  }
  const completeFile: StoreFileIR = {
    path: "src/complete.ts",
    language: "typescript",
    contentHash: "h-complete",
    symbols,
    edges,
  };
  const { store, dir } = await tempStoreWithFile(completeFile);
  try {
    const r = executeCypher(
      store,
      'MATCH (a:Function {name: "0"})-[:CALLS*1..3]->(b) RETURN b.qualifiedName',
    );
    assert.equal(r.ok, true, "query should succeed (partial result, not failure)");
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.truncated, true, "truncated must be true when the path cap is hit");
    assert.ok(r.rows.length > 0, "partial endpoint set is still returned");
  } finally {
    await dispose(store, dir);
  }
});

test("INVARIANT: the 13 documented labels are all present", () => {
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
//
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
    const { rows } = await run(
      store,
      'MATCH (a:Function {name: "a"})-[:CALLS*2]->(b) RETURN b.name',
    );
    const names = rows.map((r) => r["b.name"] as string).sort();
    assert.deepEqual(names, ["b", "d"]);
    const dRows = rows.filter((r) => r["b.name"] === "d");
    assert.equal(dRows.length, 1);
  } finally {
    await dispose(store, dir);
  }
});

test("ACCEPT: *N on a cyclic graph terminates (cycle safety via relationship-uniqueness)", async () => {
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
