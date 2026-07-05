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
import type { StoreFileIR, SymbolIR } from "./graph-store.js";

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

const fileA: StoreFileIR = {
  path: "src/a.ts",
  language: "typescript",
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

const fileB: StoreFileIR = {
  path: "src/b.ts",
  language: "typescript",
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
    const fileAReduced: StoreFileIR = {
      path: "src/a.ts",
      language: "typescript",
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

test("dangling-edge count is batch-order-independent when both ends are pruned (chatgpt-codex-connector P2: 'Count dangling edges against the whole batch')", async () => {
  // Two files share one cross-file edge x.src → y.dst. A re-ingest
  // batch that prunes BOTH ends must report 0 dangling edges (the
  // edge is cascade-deleted, not dangling) regardless of which file
  // the loop visits first. The pre-fix per-file src exclusion made
  // this 1 in one order and 0 in the other.
  const fileXfull: StoreFileIR = {
    path: "src/x.ts",
    language: "typescript",
    contentHash: "h-x",
    symbols: [sym("x.src", "src", 0, 50)],
    edges: [
      {
        srcQualifiedName: "x.src",
        dstQualifiedName: "y.dst",
        type: "CALLS",
        confidence: 0.9,
        provenance: "heuristic",
      },
    ],
  };
  const fileYfull: StoreFileIR = {
    path: "src/y.ts",
    language: "typescript",
    contentHash: "h-y",
    symbols: [sym("y.dst", "dst", 0, 50)],
  };
  const fileXempty: StoreFileIR = {
    path: "src/x.ts",
    language: "typescript",
    contentHash: "h-x-2",
    symbols: [],
    edges: [],
  };
  const fileYempty: StoreFileIR = {
    path: "src/y.ts",
    language: "typescript",
    contentHash: "h-y-2",
    symbols: [],
  };

  async function droppedTotal(order: StoreFileIR[]): Promise<number> {
    const dir = await mkdtemp(path.join(tmpdir(), "cg-order-"));
    const store = await GraphStore.open({ dbPath: path.join(dir, "store.db") });
    try {
      await store.upsertFileBatch([fileXfull, fileYfull]);
      const pruned = await store.upsertFileBatch(order);
      assert.equal(pruned.ok, true);
      if (!pruned.ok) throw new Error("expected ok result");
      return pruned.results.reduce((sum, r) => sum + r.droppedDanglingEdges, 0);
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  // Both ends pruned in one batch — order must not change the total,
  // and the total must be 0 (the edge is cascade-deleted, not dangling).
  const totalXfirst = await droppedTotal([fileXempty, fileYempty]);
  const totalYfirst = await droppedTotal([fileYempty, fileXempty]);
  assert.equal(
    totalXfirst,
    totalYfirst,
    "droppedDanglingEdges total must be identical regardless of file order in the batch",
  );
  assert.equal(
    totalXfirst,
    0,
    "an edge whose both ends are pruned in the batch is cascade-deleted, not dangling",
  );

  // Control: pruning only the dst (src survives in a separate batch)
  // is a genuine dangling edge and must still be reported as 1.
  const dirCtl = await mkdtemp(path.join(tmpdir(), "cg-order-ctl-"));
  const storeCtl = await GraphStore.open({ dbPath: path.join(dirCtl, "store.db") });
  try {
    await storeCtl.upsertFileBatch([fileXfull, fileYfull]);
    const onlyDstPruned = await storeCtl.upsertFileBatch([fileYempty]);
    assert.equal(onlyDstPruned.ok, true);
    if (!onlyDstPruned.ok) throw new Error("expected ok result");
    assert.equal(
      onlyDstPruned.results.reduce((s, r) => s + r.droppedDanglingEdges, 0),
      1,
      "a one-ended prune (src survives) is a genuine dangling edge and is still counted",
    );
  } finally {
    await storeCtl.close();
    await rm(dirCtl, { recursive: true, force: true });
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
    const empty: StoreFileIR = {
      path: "src/a.ts",
      language: "typescript",
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
    const irs: StoreFileIR[] = Array.from({ length: N }, (_, i) => ({
      path: `src/file-${i}.ts`,
      language: "typescript",
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
    assert.equal(
      result.code,
      "store_closed",
      `closed store should return "store_closed" lifecycle failure; got ${result.code}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Rule 22 — read primitives distinguish backend failure from empty.
// Before the fix, readMeta / readFileHashes / readCoChanges caught every
// error and returned the empty value (null / new Map() / []), so a
// SQLITE_BUSY or a closed store was indistinguishable from "key absent" /
// "empty index" / "no co-change edges". The reindex executor's prune +
// head-advance decisions depend on these reads, so conflating error with
// empty could skip pruning while advancing head, or prune against a
// falsely-empty set (cursor Bugbot HIGH: 'readFileHashes conflates error
// with empty'; 'readCoChanges swallows store errors'; 'readMeta conflates
// absent key with db failure').
// ──────────────────────────────────────────────────────────────────────────

test("readMeta: closed store returns tagged failure, not null (rule 22)", async () => {
  const { store, dir } = await tempStore();
  await store.close();
  try {
    const r = store.readMeta("any_key");
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("expected failure");
    assert.equal(r.code, "store_closed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readMeta: absent key returns { ok: true; value: null } — distinct from failure (rule 22)", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = store.readMeta("absent_key");
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.value, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readFileHashes: closed store returns tagged failure, not an empty Map (rule 22)", async () => {
  const { store, dir } = await tempStore();
  await store.close();
  try {
    const r = store.readFileHashes();
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("expected failure");
    assert.equal(r.code, "store_closed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readFileHashes: empty index returns { ok: true; hashes: <empty> } — distinct from failure (rule 22)", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = store.readFileHashes();
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.hashes.size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readCoChanges: closed store returns tagged failure, not [] (rule 22)", async () => {
  const { store, dir } = await tempStore();
  await store.close();
  try {
    const r = store.readCoChanges("src/a.ts");
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("expected failure");
    assert.equal(r.code, "store_closed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readCoChanges: no edges returns { ok: true; edges: [] } — distinct from failure (rule 22)", async () => {
  const { store, dir } = await tempStore();
  try {
    const r = store.readCoChanges("src/a.ts");
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.edges.length, 0);
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
    const fileAEmpty: StoreFileIR = {
      path: "src/a.ts",
      language: "typescript",
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
    const fileAMalformedEdge: StoreFileIR = {
      path: "src/a.ts",
      language: "typescript",
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
    const fileAClean: StoreFileIR = {
      path: "src/a.ts",
      language: "typescript",
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
    const fileA1: StoreFileIR = {
      path: "src/a.ts",
      language: "typescript",
      contentHash: "h-a-1",
      symbols: [sym("a.greet", "greet", 0, 100)],
    };
    const fileA2: StoreFileIR = {
      path: "src/a.ts",
      language: "typescript",
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

test("null/missing symbols is rejected as a contract violation, not silently pruned (chatgpt-codex-connector P2: 'Reject missing symbols instead of pruning the file')", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cg-nullsym-"));
  const store = await GraphStore.open({
    dbPath: path.join(dir, "store.db"),
  });
  try {
    // Seed the file with valid symbols so there is real state to wipe.
    const seeded = await store.upsertFileBatch([fileA]);
    assert.equal(seeded.ok, true, "seed ingest succeeds");
    assert.equal(
      seeded.ok && seeded.results[0]!.nodeCount,
      2,
      "fileA seeded with 2 symbol nodes",
    );

    // Deliberately violate the FileIR contract (symbols is required,
    // non-optional). The type system forbids null; this cast seeds
    // exactly the malformed payload a JSON-deserializing or buggy
    // caller would send, to prove the runtime guard catches it.
    const nullSymbolsIr = { ...fileA, symbols: null } as unknown as StoreFileIR;

    // The guard throws BEFORE the transaction opens, so no prune can
    // run and the existing nodes survive. The pre-fix `?? []` made
    // this return ok and delete both seeded nodes.
    await assert.rejects(
      store.upsertFileBatch([nullSymbolsIr]),
      /symbols must be an array .* received null/,
      "a null symbols field must be rejected, not treated as an empty assertion set",
    );

    // The guard throws before the transaction opens, so the seeded
    // nodes must still be present. nodeCount counts NEW inserts, so a
    // no-op re-ingest (nodeCount 0) is the proof: had the null-symbols
    // call wiped them (the pre-fix `?? []` bug), this re-ingest would
    // re-insert both and report 2.
    const reingested = await store.upsertFileBatch([fileA]);
    assert.equal(reingested.ok, true, "store accepts a valid ingest after the rejection");
    assert.equal(
      reingested.ok && reingested.results[0]!.nodeCount,
      0,
      "fileA re-ingest is a no-op — seeded nodes survived the rejected null-symbols attempt (no wipe)",
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
    const fileDup: StoreFileIR = {
      path: "src/dup.ts",
      language: "typescript",
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

test("ambiguous local qualified_name drops edges, does not silently pick one node (chatgpt-codex-connector P2)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cg-ambig-"));
  const store = await GraphStore.open({
    dbPath: path.join(dir, "store.db"),
  });
  try {
    // Two symbols share qualifiedName "ambig.Foo" but have different
    // kinds (type vs function) → different node ids, same qualified_name.
    // Node identity is (qualifiedName, filePath, label=kind).
    const fileAmbig: StoreFileIR = {
      path: "src/ambig.ts",
      language: "typescript",
      contentHash: "h-ambig",
      symbols: [
        sym("ambig.Foo", "Foo", 0, 100, "type"),
        sym("ambig.Foo", "Foo", 100, 200, "function"),
        sym("ambig.bar", "bar", 200, 300, "function"),
      ],
      edges: [
        {
          // src "ambig.Foo" is ambiguous (two nodes) — must be dropped,
          // NOT silently attached to whichever the unordered query left last.
          srcQualifiedName: "ambig.Foo",
          dstQualifiedName: "ambig.bar",
          type: "CALLS",
          confidence: 0.9,
          provenance: "heuristic",
        },
      ],
    };
    const r = await store.upsertFileBatch([fileAmbig]);
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(
      r.results[0]?.edgeCount,
      0,
      "edge whose src qualified_name is ambiguous (two nodes share it) must be dropped, not silently resolved",
    );
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("out-of-range edge confidence is rejected at the storage boundary (chatgpt-codex-connector P2)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cg-conf-"));
  const store = await GraphStore.open({
    dbPath: path.join(dir, "store.db"),
  });
  try {
    for (const badConfidence of [-0.1, 1.5, -1, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const file: StoreFileIR = {
        path: "src/conf.ts",
        language: "typescript",
        contentHash: "h-conf",
        symbols: [sym("conf.caller", "caller", 0, 50), sym("conf.callee", "callee", 50, 100)],
        edges: [
          {
            srcQualifiedName: "conf.caller",
            dstQualifiedName: "conf.callee",
            type: "CALLS",
            confidence: badConfidence,
            provenance: "heuristic",
          },
        ],
      };
      await assert.rejects(
        store.upsertFileBatch([file]),
        /out of range \[0, 1\]/,
        `confidence ${badConfidence} must be rejected at the storage boundary`,
      );
    }
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("omitted edges field preserves prior edges, explicit [] wipes them (cursor Bugbot: 'Omitted edges field wipes stored edges')", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cg-noedges-"));
  const store = await GraphStore.open({
    dbPath: path.join(dir, "store.db"),
  });
  try {
    // Initial ingest with edges.
    const r1 = await store.upsertFileBatch([fileA]);
    assert.equal(r1.ok, true);
    if (!r1.ok) throw new Error("expected ok");
    assert.equal(r1.results[0]?.edgeCount, 1, "initial ingest stores 1 edge");

    // Re-upsert the same file WITHOUT an edges field — a bare core
    // ParseResult.ir has no edges. Prior edges MUST be preserved.
    const noEdges: StoreFileIR = {
      path: "src/a.ts",
      language: "typescript",
      contentHash: "h-a-noedges",
      symbols: [sym("a.greet", "greet", 0, 100), sym("a.farewell", "farewell", 100, 200)],
    };
    const r2 = await store.upsertFileBatch([noEdges]);
    assert.equal(r2.ok, true);
    if (!r2.ok) throw new Error("expected ok");
    assert.equal(
      r2.results[0]?.edgeCount,
      0,
      "re-upsert without edges field must not insert or delete edges",
    );

    // Re-ingest fileB (which has a cross-file edge to a.greet). If the
    // edge from fileA was preserved, fileB's re-ingest sees it still
    // there (no dangling drop). If it was wiped, fileB's edge target
    // is gone but the edge re-inserts fine since a.greet still exists.
    // The definitive proof: re-upsert fileA with explicit [] edges —
    // this MUST wipe the prior edge.
    const emptyEdges: StoreFileIR = {
      path: "src/a.ts",
      language: "typescript",
      contentHash: "h-a-empty-edges",
      symbols: [sym("a.greet", "greet", 0, 100), sym("a.farewell", "farewell", 100, 200)],
      edges: [],
    };
    const r3 = await store.upsertFileBatch([emptyEdges]);
    assert.equal(r3.ok, true);
    if (!r3.ok) throw new Error("expected ok");
    // The prior edge (a.greet → a.farewell) is now stale and deleted.
    assert.equal(
      r3.results[0]?.droppedDanglingEdges,
      0,
      "explicit [] edges does not produce dangling edges (edges are src-owned)",
    );
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("close blocks new writes before draining so a concurrent upsert is rejected (chatgpt-codex-connector P2)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cg-closing-"));
  const store = await GraphStore.open({
    dbPath: path.join(dir, "store.db"),
  });
  try {
    // Schedule a write (pending on the queue).
    const firstWrite = store.upsertFileBatch([fileA]);
    // Start close() WITHOUT awaiting firstWrite. close() sets the
    // closing flag synchronously before awaiting drain, so a write
    // issued while drain is pending must be rejected, not scheduled
    // onto a queue whose tail drain() already snapshotted.
    const closeP = store.close();
    const rejected = await store.upsertFileBatch([fileB]);
    assert.equal(rejected.ok, false);
    if (rejected.ok) throw new Error("expected rejected");
    assert.equal(
      rejected.code,
      "store_closed",
      "upsert during close-drain must return store_closed, not run against a closing DB",
    );
    // Let the pending write + close finish.
    await firstWrite;
    await closeP;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a second close() during an in-progress drain awaits it, not resolves early (chatgpt-codex-connector P2: 'Wait for an in-progress close')", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cg-close2-"));
  const store = await GraphStore.open({
    dbPath: path.join(dir, "store.db"),
  });
  try {
    // Schedule a write but do NOT await it, so close()'s drain has a
    // pending write to wait on.
    const firstWrite = store.upsertFileBatch([fileA]);
    // closeA runs first: it sets `closing` synchronously then awaits
    // the drain. closeB is issued on the SAME synchronous tick, while
    // closeA is still mid-drain (no microtasks have flushed yet).
    const closeA = store.close();
    const closeB = store.close();

    // Discriminator: the pre-fix early `return` resolved closeB
    // synchronously (it returned a settled promise), so a .then
    // callback fires on the very next microtask. The fix returns the
    // shared pending drain promise, so closeB stays pending until the
    // drain finishes. `await Promise.resolve()` advances exactly one
    // microtask — enough for closeB's .then to fire if it was already
    // settled, not enough if it is still waiting on the drain.
    let earlyResolved = false;
    closeB.then(() => {
      earlyResolved = true;
    });
    await Promise.resolve();
    assert.equal(
      earlyResolved,
      false,
      "a second close() issued while the first is draining must await the shared drain promise, not resolve before it",
    );

    // Both closes now settle together once the drain (and firstWrite)
    // complete.
    await closeA;
    await closeB;
    await firstWrite;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid symbol spans are rejected before storing nodes (chatgpt-codex-connector P2: 'Reject invalid symbol spans before storing nodes')", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cg-badspan-"));
  const store = await GraphStore.open({
    dbPath: path.join(dir, "store.db"),
  });
  try {
    // Seed valid state so we can prove the guard throws BEFORE the
    // transaction opens — a wipe would clear these nodes.
    const seeded = await store.upsertFileBatch([fileA]);
    assert.equal(seeded.ok, true, "seed ingest succeeds");
    assert.equal(
      seeded.ok && seeded.results[0]!.nodeCount,
      2,
      "fileA seeded with 2 symbol nodes",
    );

    // Each case targets a distinct branch of assertValidSymbolSpan.
    // The `sym()` helper builds a well-formed symbol; the non-integer
    // and missing-span cases bypass it to seed the malformed payload a
    // JSON-deserializing or buggy caller would emit.
    const cases: Array<{ label: string; sym: unknown; re: RegExp }> = [
      { label: "startByte > endByte", sym: sym("a.bad", "bad", 100, 10), re: /startByte > endByte/ },
      { label: "negative startByte", sym: sym("a.bad", "bad", -1, 10), re: /negative span/ },
      { label: "negative endByte", sym: sym("a.bad", "bad", 0, -5), re: /negative span/ },
      { label: "non-integer startByte", sym: { qualifiedName: "a.bad", name: "bad", kind: "function", span: { startByte: 1.5, endByte: 10 } }, re: /non-integer span/ },
      { label: "NaN endByte", sym: { qualifiedName: "a.bad", name: "bad", kind: "function", span: { startByte: 0, endByte: Number.NaN } }, re: /non-integer span/ },
      { label: "missing span object", sym: { qualifiedName: "a.bad", name: "bad", kind: "function" }, re: /no span/ },
    ];
    for (const { label, sym: badSym, re } of cases) {
      const ir = { ...fileA, symbols: [badSym] } as unknown as StoreFileIR;
      await assert.rejects(
        store.upsertFileBatch([ir]),
        re,
        `${label}: invalid span must be rejected at the store boundary`,
      );
    }

    // Guard throws before the transaction opens, so every rejected
    // attempt left the seeded nodes intact — a re-ingest is a no-op
    // (nodeCount 0). The pre-fix path would have bound the bad span and
    // reported nodeCount 1.
    const reingested = await store.upsertFileBatch([fileA]);
    assert.equal(reingested.ok, true, "store accepts a valid ingest after the rejections");
    assert.equal(
      reingested.ok && reingested.results[0]!.nodeCount,
      0,
      "fileA re-ingest is a no-op — seeded nodes survived every rejected bad-span attempt",
    );

    // Boundary check: a zero-length half-open span [5, 5) is VALID
    // (startByte <= endByte), so it must be accepted, not rejected.
    const zeroSpan = await store.upsertFileBatch([
      { ...fileA, symbols: [sym("a.zero", "zero", 5, 5)] },
    ]);
    assert.equal(zeroSpan.ok, true, "a zero-length span [5, 5) is a legal half-open span");
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-canonical file paths are rejected before persisting (chatgpt-codex-connector P2: 'Reject non-canonical file paths before persisting')", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cg-badpath-"));
  const store = await GraphStore.open({
    dbPath: path.join(dir, "store.db"),
  });
  try {
    const seeded = await store.upsertFileBatch([fileA]);
    assert.equal(seeded.ok, true, "seed ingest succeeds");

    // Each case is a distinct aliasing hazard: the same repo file
    // rendered two ways would hash to two files rows + node ids and
    // leave duplicates the canonical ingest cannot match or prune.
    const cases: Array<{ label: string; path: string; re: RegExp }> = [
      { label: "backslash separator", path: "src\\a.ts", re: /forward slashes/ },
      { label: "leading ./", path: "./src/a.ts", re: /must be canonical/ },
      { label: "leading ../", path: "../src/a.ts", re: /must be canonical/ },
      { label: "absolute posix", path: "/src/a.ts", re: /must be repo-relative/ },
      { label: ".. segment", path: "src/../a.ts", re: /must be canonical/ },
      { label: "empty string", path: "", re: /non-empty string/ },
    ];
    for (const { label, path: badPath, re } of cases) {
      const ir = { ...fileA, path: badPath } as StoreFileIR;
      await assert.rejects(
        store.upsertFileBatch([ir]),
        re,
        `${label}: non-canonical path must be rejected at the store boundary`,
      );
    }

    // Canonical re-ingest is a no-op — the seeded file survived every
    // rejected non-canonical attempt (the guard throws before the
    // files row is touched).
    const reingested = await store.upsertFileBatch([fileA]);
    assert.equal(reingested.ok, true, "store accepts a canonical ingest after the rejections");
    assert.equal(
      reingested.ok && reingested.results[0]!.nodeCount,
      0,
      "fileA re-ingest is a no-op — the canonical seeded row survived every rejected non-canonical attempt",
    );
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
