/**
 * graph-store tests — ordered steps 2–3 of issue #1552 PR1.
 *
 * Cover:
 *   - upsertFileBatch: ingest counts (exact node + edge counts from hand-
 *     written fixture IR)
 *   - idempotency: re-ingesting the same IR yields identical state
 *   - dangling-edge handling: cross-file edges whose destination was
 *     deleted are DROPPED (per the PR1 policy documented in graph-schema)
 *     and surfaced via droppedDanglingEdges
 *   - node-id determinism: nodeIdFor is pure (sorted key material sha256)
 *   - write queue serialization (rule 40)
 *   - tagged failure shape on a closed store (rule 34)
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  openBetterSqlite3,
  type BetterSqlite3Database,
} from "@remnic/core/runtime/better-sqlite";
import { GraphStore, nodeIdFor } from "./graph-store.js";
import type { FileIR, SymbolIR } from "./graph-store.js";

// ──────────────────────────────────────────────────────────────────────────
// Fixture IR — synthetic code only (public-repo policy).
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

const fileA: FileIR = {
  path: "src/a.ts",
  language: "ts",
  contentHash: "h-a",
  symbols: [
    sym("a.greet", "greet", 0, 100),
    sym("a.farewell", "farewell", 100, 200),
  ],
  edges: [
    {
      srcQualifiedName: "a.greet",
      dstQualifiedName: "a.farewell",
      type: "CALLS",
      confidence: 0.95,
      provenance: "heuristic",
    },
  ],
};

const fileB: FileIR = {
  path: "src/b.ts",
  language: "ts",
  contentHash: "h-b",
  symbols: [
    sym("b.run", "run", 0, 50),
    sym("b.helper", "helper", 50, 150),
  ],
  edges: [
    {
      srcQualifiedName: "b.run",
      dstQualifiedName: "b.helper",
      type: "CALLS",
      confidence: 0.9,
      provenance: "heuristic",
    },
    {
      // Cross-file edge — destination lives in fileA.
      srcQualifiedName: "b.run",
      dstQualifiedName: "a.greet",
      type: "CALLS",
      confidence: 0.6,
      provenance: "heuristic",
    },
  ],
};

async function tempStore(): Promise<{ store: GraphStore; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "coding-graph-store-"));
  const store = await GraphStore.open({
    dbPath: path.join(dir, "graph.sqlite"),
  });
  return { store, dir };
}

test("upsertFileBatch: ingest two-file fixture yields exact node + edge counts", async () => {
  const { store, dir } = await tempStore();
  try {
    assert.equal(store.schemaVersion(), 1);

    const result = await store.upsertFileBatch([fileA, fileB]);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("expected ok result");
    assert.equal(result.results.length, 2);

    const a = result.results.find((r) => r.path === "src/a.ts");
    const b = result.results.find((r) => r.path === "src/b.ts");
    assert.ok(a, "expected result for fileA");
    assert.ok(b, "expected result for fileB");
    assert.equal(a?.nodeCount, 2, "fileA: 2 symbols");
    assert.equal(a?.edgeCount, 1, "fileA: 1 intra-file edge");
    assert.equal(b?.nodeCount, 2, "fileB: 2 symbols");
    assert.equal(b?.edgeCount, 2, "fileB: 1 intra + 1 cross-file edge");
    assert.equal(a?.droppedDanglingEdges, 0, "no dangling edges on first ingest");
    assert.equal(b?.droppedDanglingEdges, 0);

    // Re-open and verify the rows persisted.
    await store.close();
    const reopened = await GraphStore.open({
      dbPath: path.join(dir, "graph.sqlite"),
    });
    assert.equal(reopened.schemaVersion(), 1);
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("idempotency: re-ingesting the same IR is a no-op (counts and ids unchanged)", async () => {
  const { store, dir } = await tempStore();
  try {
    const first = await store.upsertFileBatch([fileA, fileB]);
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("expected ok result");

    // Compute the expected ids deterministically.
    const expectedA1 = nodeIdFor({
      qualifiedName: "a.greet",
      filePath: "src/a.ts",
      label: "function",
    });
    const expectedB1 = nodeIdFor({
      qualifiedName: "b.run",
      filePath: "src/b.ts",
      label: "function",
    });

    // Second ingest — same IR — must not change row counts nor ids.
    const second = await store.upsertFileBatch([fileA, fileB]);
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error("expected ok result");
    for (const r of second.results) {
      assert.equal(r.nodeCount, 0, "no new nodes when ids collide on PK");
      assert.equal(r.edgeCount, 0, "no new edges when (src,dst,type) collides");
      assert.equal(r.droppedDanglingEdges, 0);
    }

    // The rows still hash to the same deterministic ids.
    assert.equal(expectedA1.length, 64, "sha256 hex digest length");
    assert.equal(expectedB1.length, 64);
    assert.notEqual(expectedA1, expectedB1, "different symbols → different ids");
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("dangling-edge policy: cross-file edges whose dst is dropped are counted, not kept", async () => {
  const { store, dir } = await tempStore();
  try {
    // Initial batch — cross-file edge b.run → a.greet is fine.
    const r1 = await store.upsertFileBatch([fileA, fileB]);
    assert.equal(r1.ok, true);
    if (!r1.ok) throw new Error("expected ok result");

    // Re-ingest fileA only with a stripped symbol set: a.greet is gone, so
    // the cross-file edge from b.run → a.greet becomes dangling.
    const fileAReduced: FileIR = {
      path: "src/a.ts",
      language: "ts",
      contentHash: "h-a-2",
      symbols: [sym("a.farewell", "farewell", 100, 200)],
      // No edges — keeps the test focused on the dangling count.
      edges: [],
    };
    const r2 = await store.upsertFileBatch([fileAReduced]);
    assert.equal(r2.ok, true);
    if (!r2.ok) throw new Error("expected ok result");
    assert.equal(r2.results.length, 1);
    const a = r2.results[0]!;
    assert.equal(a.path, "src/a.ts");
    assert.equal(a.droppedDanglingEdges, 1, "one cross-file edge pointed at a.greet");
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("fts_index: maps FTS rowid → node id so PR2 can JOIN hits back to nodes", async () => {
  const { store, dir } = await tempStore();
  let peekDb: BetterSqlite3Database | undefined;
  try {
    const r = await store.upsertFileBatch([fileA]);
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("expected ok");

    // Re-open the same file with a raw connection (after the store
    // closed its transaction) to peek at the fts_index mapping.
    await store.close();
    peekDb = openBetterSqlite3(path.join(dir, "graph.sqlite"));

    // Hit nodes_fts with the symbol name and JOIN to fts_index to
    // recover the node id — exactly the read path PR2 will use.
    type FtsHit = { node_id: string };
    const hits: FtsHit[] = peekDb
      .prepare(
        `SELECT fts_index.node_id AS node_id
           FROM nodes_fts
           JOIN fts_index ON fts_index.fts_rowid = nodes_fts.rowid
          WHERE nodes_fts MATCH ?`,
      )
      .all("greet") as FtsHit[];
    assert.equal(hits.length, 1, "one MATCH hit for 'greet'");
    const expected = nodeIdFor({
      qualifiedName: "a.greet",
      filePath: "src/a.ts",
      label: "function",
    });
    assert.equal(hits[0]?.node_id, expected);

    // The forward mapping (node id → fts_rowid) is the deterministic
    // hash slice used by the write path. Verify it round-trips.
    type IndexRow = { fts_rowid: number };
    const fwd: IndexRow[] = peekDb
      .prepare(
        "SELECT fts_rowid FROM fts_index WHERE node_id = ?",
      )
      .all(expected) as IndexRow[];
    assert.equal(fwd.length, 1);
  } finally {
    peekDb?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("fts_index: prunes the mapping when a node is removed by re-ingest", async () => {
  const { store, dir } = await tempStore();
  let peekDb: BetterSqlite3Database | undefined;
  try {
    const r1 = await store.upsertFileBatch([fileA]);
    assert.equal(r1.ok, true);
    if (!r1.ok) throw new Error("expected ok");

    // Re-ingest fileA with an empty symbol set — every node is
    // pruned, so every fts_index row must follow.
    const empty: FileIR = {
      path: "src/a.ts",
      language: "ts",
      contentHash: "h-a-empty",
      symbols: [],
      edges: [],
    };
    const r2 = await store.upsertFileBatch([empty]);
    assert.equal(r2.ok, true);
    if (!r2.ok) throw new Error("expected ok");

    await store.close();
    peekDb = openBetterSqlite3(path.join(dir, "graph.sqlite"));

    type CountRow = { c: number };
    const ftsCount: CountRow[] = peekDb
      .prepare("SELECT COUNT(*) AS c FROM nodes_fts")
      .all() as CountRow[];
    const idxCount: CountRow[] = peekDb
      .prepare("SELECT COUNT(*) AS c FROM fts_index")
      .all() as CountRow[];
    assert.equal(ftsCount[0]?.c, 0, "no FTS rows survive the prune");
    assert.equal(idxCount[0]?.c, 0, "no fts_index rows survive the prune");
  } finally {
    peekDb?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("nodeIdFor is pure and order-stable (rule 23/38)", () => {
  const a1 = nodeIdFor({
    qualifiedName: "mod.fn",
    filePath: "x.ts",
    label: "function",
  });
  const a2 = nodeIdFor({
    qualifiedName: "mod.fn",
    filePath: "x.ts",
    label: "function",
  });
  assert.equal(a1, a2, "same input → same id");

  // Different label → different id.
  const b = nodeIdFor({
    qualifiedName: "mod.fn",
    filePath: "x.ts",
    label: "method",
  });
  assert.notEqual(a1, b);

  // Different qualified name → different id.
  const c = nodeIdFor({
    qualifiedName: "mod.other",
    filePath: "x.ts",
    label: "function",
  });
  assert.notEqual(a1, c);

  // Different file path → different id.
  const d = nodeIdFor({
    qualifiedName: "mod.fn",
    filePath: "y.ts",
    label: "function",
  });
  assert.notEqual(a1, d);
});

test("nodeIdFor uses sha256 (64 hex chars)", () => {
  const id = nodeIdFor({
    qualifiedName: "x",
    filePath: "y",
    label: "z",
  });
  assert.equal(id.length, 64);
  assert.match(id, /^[0-9a-f]{64}$/);
});

test("write queue serializes concurrent upserts (rule 40)", async () => {
  const { store, dir } = await tempStore();
  try {
    // Fire N batches in parallel — the queue must execute them one after
    // the other without raising and without losing rows.
    const N = 8;
    const irs: FileIR[] = Array.from({ length: N }, (_, i) => ({
      path: `src/file-${i}.ts`,
      language: "ts",
      contentHash: `h-${i}`,
      symbols: [sym(`f-${i}.run`, "run", 0, 10)],
      edges: [],
    }));
    const settled = await Promise.all(
      irs.map((ir) => store.upsertFileBatch([ir])),
    );
    for (const r of settled) {
      assert.equal(r.ok, true, "every concurrent upsert must succeed");
      if (r.ok) {
        assert.equal(r.results[0]?.nodeCount, 1);
      }
    }

    // drain() resolves cleanly after all queued writes settle.
    await store.drain();
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("closed store returns tagged failure, never throws (rule 34)", async () => {
  const { store, dir } = await tempStore();
  await store.close();
  try {
    const result = await store.upsertFileBatch([fileA]);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("expected failure");
    assert.ok(
      result.code === "db_corrupt" || result.code === "db_locked",
      `closed store should return tagged failure; got ${result.code}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("node-id ingestion: file-level delete cascades prior nodes + owned edges", async () => {
  const { store, dir } = await tempStore();
  try {
    const r1 = await store.upsertFileBatch([fileA]);
    assert.equal(r1.ok, true);
    if (!r1.ok) throw new Error("expected ok");

    // Re-ingest fileA with empty symbols — deletes both nodes.
    const fileAEmpty: FileIR = {
      path: "src/a.ts",
      language: "ts",
      contentHash: "h-a-empty",
      symbols: [],
      edges: [],
    };
    const r2 = await store.upsertFileBatch([fileAEmpty]);
    assert.equal(r2.ok, true);
    if (!r2.ok) throw new Error("expected ok");
    assert.equal(r2.results[0]?.nodeCount, 0);
    assert.equal(r2.results[0]?.edgeCount, 0);

    // Re-ingesting fileB should now see a cross-file edge b.run → a.greet
    // as a fresh insert (the prior dangling drop is gone since a.greet no
    // longer exists to receive the edge; the edge is skipped at insert time
    // because the dst cannot be resolved).
    const r3 = await store.upsertFileBatch([fileB]);
    assert.equal(r3.ok, true);
    if (!r3.ok) throw new Error("expected ok");
    // fileB has 2 symbols + 2 edges declared, but the cross-file edge's
    // dst (a.greet) is missing → 1 edge kept (intra-file).
    assert.equal(r3.results[0]?.nodeCount, 2);
    assert.equal(r3.results[0]?.edgeCount, 1);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("absolute dbPath is required", async () => {
  // Path.resolve would also produce absolute; we need a deliberately
  // relative path so the validator throws — the previous version of this
  // test composed off mkdtemp, which always returned absolute, so the
  // assertion could never fire.
  const relative = `relative-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
  await assert.rejects(
    () =>
      GraphStore.open({
        dbPath: relative,
      }),
    /dbPath must be absolute/,
  );
});

test("edge src validation: cross-file edge src is rejected, not cross-owned (chatgpt-codex-connector P2)", async () => {
  const { store, dir } = await tempStore();
  try {
    // Seed fileB first so b.run exists in the DB.
    const r1 = await store.upsertFileBatch([fileB]);
    assert.equal(r1.ok, true);
    if (!r1.ok) throw new Error("expected ok");

    // Ingest fileA with an edge whose srcQualifiedName is "b.run" —
    // a symbol that lives in fileB, NOT fileA. The edge must be
    // DROPPED: a FileIR may only assert edges whose src is a symbol
    // in the same file. Without this guard the edge would be silently
    // cross-owned by fileB and survive fileA re-ingests.
    const fileAMalformedEdge: FileIR = {
      path: "src/a.ts",
      language: "ts",
      contentHash: "h-a-malformed",
      symbols: [sym("a.greet", "greet", 0, 100)],
      edges: [
        {
          srcQualifiedName: "b.run",
          dstQualifiedName: "a.greet",
          type: "CALLS",
          confidence: 0.5,
          provenance: "heuristic",
        },
      ],
    };
    const r2 = await store.upsertFileBatch([fileAMalformedEdge]);
    assert.equal(r2.ok, true);
    if (!r2.ok) throw new Error("expected ok");
    assert.equal(
      r2.results[0]?.edgeCount,
      0,
      "cross-file edge src must be rejected — no edges inserted",
    );

    // Verify no edge exists in the DB at all for this assertion.
    // The store exposes no public query API yet, so we go through
    // the re-ingest path: re-ingest fileA with no edges and confirm
    // no cross-owned edge was left behind.
    const fileAClean: FileIR = {
      path: "src/a.ts",
      language: "ts",
      contentHash: "h-a-clean",
      symbols: [sym("a.greet", "greet", 0, 100)],
      edges: [],
    };
    const r3 = await store.upsertFileBatch([fileAClean]);
    assert.equal(r3.ok, true);
    if (!r3.ok) throw new Error("expected ok");
    // If the cross-owned edge had been created, re-ingesting fileA
    // (which only deletes edges whose src is in fileA) would leave
    // it behind. But since the edge was never created, there is
    // nothing to clean up — edgeCount is 0.
    assert.equal(r3.results[0]?.edgeCount, 0);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("duplicate paths in one batch throw (cursor Bugbot: 'Duplicate paths corrupt edge pass')", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cg-dup-"));
  const store = await GraphStore.open({
    dbPath: path.join(dir, "store.db"),
  });
  try {
    const fileA1: FileIR = {
      path: "src/a.ts",
      language: "ts",
      contentHash: "h-a-1",
      symbols: [sym("a.greet", "greet", 0, 100)],
    };
    const fileA2: FileIR = {
      path: "src/a.ts",
      language: "ts",
      contentHash: "h-a-2",
      symbols: [sym("a.farewell", "farewell", 0, 100)],
    };
    await assert.rejects(
      store.upsertFileBatch([fileA1, fileA2]),
      /duplicate path 'src\/a\.ts' in batch/,
      "duplicate paths in one batch must throw, not silently corrupt the edge pass",
    );
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("duplicate (src,dst,type) edges keep first metadata, do not inflate edgeCount (cursor Bugbot #28876d4c)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cg-dupedge-"));
  const store = await GraphStore.open({
    dbPath: path.join(dir, "store.db"),
  });
  try {
    const fileDup: FileIR = {
      path: "src/dup.ts",
      language: "ts",
      contentHash: "h-dup",
      symbols: [sym("dup.caller", "caller", 0, 50), sym("dup.callee", "callee", 50, 100)],
      edges: [
        {
          srcQualifiedName: "dup.caller",
          dstQualifiedName: "dup.callee",
          type: "CALLS",
          confidence: 0.95,
          provenance: "heuristic",
        },
        {
          // Same (src, dst, type) — differing metadata. First edge wins;
          // this duplicate must NOT inflate edgeCount to 2.
          srcQualifiedName: "dup.caller",
          dstQualifiedName: "dup.callee",
          type: "CALLS",
          confidence: 0.4,
          provenance: "lsp",
        },
      ],
    };
    const r = await store.upsertFileBatch([fileDup]);
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(
      r.results[0]?.edgeCount,
      1,
      "duplicate edge triples must dedupe to a single insert — edgeCount must not be inflated",
    );

    // Re-ingest the same file to prove the persisted edge kept the
    // FIRST duplicate's metadata (confidence 0.95): a no-op re-upsert
    // (changes=0) means the stored row matches the first edge exactly.
    const r2 = await store.upsertFileBatch([fileDup]);
    assert.equal(r2.ok, true);
    if (!r2.ok) throw new Error("expected ok");
    assert.equal(
      r2.results[0]?.edgeCount,
      0,
      "re-ingest with identical first-edge metadata must be a no-op (changes=0)",
    );
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
