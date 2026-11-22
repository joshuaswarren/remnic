import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openBetterSqlite3 } from "@remnic/core/runtime/better-sqlite";

import { GraphStore, type FileIR } from "./graph-store.js";

const span = (startByte: number, endByte: number) => ({ startByte, endByte });

function twoSymbolFile(overrides?: Partial<FileIR>): FileIR {
  return {
    path: "main.ts",
    language: "typescript",
    contentHash: "hash-1",
    symbols: [
      { kind: "function", name: "greet", qualifiedName: "greet", span: span(0, 70) },
      { kind: "function", name: "format", qualifiedName: "format", span: span(71, 132) },
    ],
    imports: [],
    exports: [],
    callSites: [],
    routes: [],
    ...overrides,
  } as FileIR;
}

async function openTempStore(): Promise<{ store: GraphStore; dir: string; dbPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "cg-prov-scope-"));
  const dbPath = path.join(dir, "graph.sqlite");
  const store = await GraphStore.open({ dbPath });
  return { store, dir, dbPath };
}

/** Direct provenance read — the store has no provenance-split surface. */
function readEdgeProvenances(dbPath: string): string[] {
  const db = openBetterSqlite3(dbPath, { readonly: true });
  try {
    const rows = db.prepare("SELECT provenance FROM edges ORDER BY provenance").all() as Array<{
      provenance: string;
    }>;
    return rows.map((r) => r.provenance);
  } finally {
    db.close();
  }
}

test("scoped assertion preserves trace edges while deleting stale heuristic edges", async () => {
  const { store, dir } = await openTempStore();
  try {
    const seeded = await store.upsertFileBatch([
      {
        ...twoSymbolFile(),
        edges: [
          {
            srcQualifiedName: "greet",
            dstQualifiedName: "format",
            type: "CALLS",
            confidence: 0.9,
            provenance: "heuristic",
          },
        ],
      },
    ]);
    assert.ok(seeded.ok);
    const traced = await store.upsertEdges([
      {
        srcQualifiedName: "greet",
        dstQualifiedName: "format",
        type: "HTTP_CALLS",
        confidence: 1,
        provenance: "trace",
      },
    ]);
    assert.ok(traced.ok && traced.persisted === 1);

    let stats = await store.schemaStats();
    assert.ok(stats.ok);
    assert.equal(stats.stats.edges, 2, "seed state: heuristic CALLS + trace HTTP_CALLS");

    const reingested = await store.upsertFileBatch([
      {
        ...twoSymbolFile({ contentHash: "hash-2" }),
        edges: [],
        assertedEdgeProvenances: ["heuristic"],
      },
    ]);
    assert.ok(reingested.ok);

    stats = await store.schemaStats();
    assert.ok(stats.ok);
    assert.equal(stats.stats.edges, 1, "heuristic edge deleted, trace edge preserved");
    assert.deepEqual(stats.stats.edgesByType, { HTTP_CALLS: 1 });
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("scoped re-assertion keeps the still-supported heuristic edge (no churn)", async () => {
  const { store, dir } = await openTempStore();
  try {
    const edge = {
      srcQualifiedName: "greet",
      dstQualifiedName: "format",
      type: "CALLS",
      confidence: 0.9,
      provenance: "heuristic" as const,
    };
    const first = await store.upsertFileBatch([{ ...twoSymbolFile(), edges: [edge] }]);
    assert.ok(first.ok);
    const second = await store.upsertFileBatch([
      {
        ...twoSymbolFile({ contentHash: "hash-2" }),
        edges: [edge],
        assertedEdgeProvenances: ["heuristic"],
      },
    ]);
    assert.ok(second.ok);
    const stats = await store.schemaStats();
    assert.ok(stats.ok);
    assert.deepEqual(stats.stats.edgesByType, { CALLS: 1 });
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy behavior unchanged: absent assertedEdgeProvenances deletes all stale src-owned edges", async () => {
  const { store, dir } = await openTempStore();
  try {
    const seeded = await store.upsertFileBatch([
      {
        ...twoSymbolFile(),
        edges: [
          {
            srcQualifiedName: "greet",
            dstQualifiedName: "format",
            type: "CALLS",
            confidence: 0.9,
            provenance: "heuristic",
          },
        ],
      },
    ]);
    assert.ok(seeded.ok);
    const traced = await store.upsertEdges([
      {
        srcQualifiedName: "greet",
        dstQualifiedName: "format",
        type: "HTTP_CALLS",
        confidence: 1,
        provenance: "trace",
      },
    ]);
    assert.ok(traced.ok);

    const reingested = await store.upsertFileBatch([
      { ...twoSymbolFile({ contentHash: "hash-2" }), edges: [] },
    ]);
    assert.ok(reingested.ok);

    const stats = await store.schemaStats();
    assert.ok(stats.ok);
    assert.equal(stats.stats.edges, 0, "legacy: every stale src-owned edge deleted");
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("edges undefined still preserves all prior edges (early return)", async () => {
  const { store, dir } = await openTempStore();
  try {
    const seeded = await store.upsertFileBatch([
      {
        ...twoSymbolFile(),
        edges: [
          {
            srcQualifiedName: "greet",
            dstQualifiedName: "format",
            type: "CALLS",
            confidence: 0.9,
            provenance: "heuristic",
          },
        ],
      },
    ]);
    assert.ok(seeded.ok);

    const reingested = await store.upsertFileBatch([
      { ...twoSymbolFile({ contentHash: "hash-2" }), assertedEdgeProvenances: ["heuristic"] },
    ]);
    assert.ok(reingested.ok);

    const stats = await store.schemaStats();
    assert.ok(stats.ok);
    assert.deepEqual(stats.stats.edgesByType, { CALLS: 1 });
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("scoped re-assertion never downgrades an lsp-upgraded row on the same key", async () => {
  const { store, dir, dbPath } = await openTempStore();
  try {
    const heuristicEdge = {
      srcQualifiedName: "greet",
      dstQualifiedName: "format",
      type: "CALLS",
      confidence: 0.9,
      provenance: "heuristic" as const,
    };
    const seeded = await store.upsertFileBatch([{ ...twoSymbolFile(), edges: [heuristicEdge] }]);
    assert.ok(seeded.ok);
    const upgraded = await store.upsertEdges([
      { ...heuristicEdge, confidence: 1, provenance: "lsp" },
    ]);
    assert.ok(upgraded.ok);

    const reingested = await store.upsertFileBatch([
      {
        ...twoSymbolFile({ contentHash: "hash-2" }),
        edges: [heuristicEdge],
        assertedEdgeProvenances: ["heuristic", "lsp"],
      },
    ]);
    assert.ok(reingested.ok);

    const stats = await store.schemaStats();
    assert.ok(stats.ok);
    assert.deepEqual(stats.stats.edgesByType, { CALLS: 1 });
    // Provenance must still be lsp: read it directly from the DB (the
    // store exposes no provenance-split read surface, and an indirect
    // probe would conflate this with the retire-on-vanish behavior).
    assert.deepEqual(readEdgeProvenances(dbPath), ["lsp"]);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an lsp row is retired when the call disappears from the parse (codex review)", async () => {
  const { store, dir } = await openTempStore();
  try {
    const heuristicEdge = {
      srcQualifiedName: "greet",
      dstQualifiedName: "format",
      type: "CALLS",
      confidence: 0.9,
      provenance: "heuristic" as const,
    };
    const seeded = await store.upsertFileBatch([{ ...twoSymbolFile(), edges: [heuristicEdge] }]);
    assert.ok(seeded.ok);
    const upgraded = await store.upsertEdges([
      { ...heuristicEdge, confidence: 1, provenance: "lsp" },
    ]);
    assert.ok(upgraded.ok);

    const reingested = await store.upsertFileBatch([
      {
        ...twoSymbolFile({ contentHash: "hash-2" }),
        edges: [],
        assertedEdgeProvenances: ["heuristic", "lsp"],
      },
    ]);
    assert.ok(reingested.ok);
    const stats = await store.schemaStats();
    assert.ok(stats.ok);
    assert.equal(stats.stats.edges, 0, "vanished call retires the lsp-upgraded row too");
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a path-hinted edge binds only inside its declared target file", async () => {
  const { store, dir } = await openTempStore();
  try {
    const seeded = await store.upsertFileBatch([
      twoSymbolFile(),
      {
        ...twoSymbolFile({ path: "lib/main.ts", contentHash: "hash-lib" }),
        symbols: [
          { kind: "function", name: "helper", qualifiedName: "lib.helper", span: span(0, 40) },
        ],
      },
      {
        ...twoSymbolFile({ path: "util.ts", contentHash: "hash-util" }),
        symbols: [
          { kind: "function", name: "shout", qualifiedName: "shout", span: span(0, 40) },
        ],
        edges: [
          {
            srcQualifiedName: "shout",
            dstQualifiedName: "greet",
            type: "CALLS",
            confidence: 0.8,
            provenance: "heuristic",
            dstPathHint: "main",
          },
        ],
      },
    ]);
    assert.ok(seeded.ok);
    const stats = await store.schemaStats();
    assert.ok(stats.ok);
    assert.deepEqual(stats.stats.edgesByType, { CALLS: 1 }, "hint matched main.ts");
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a path-hinted edge whose target file is not indexed is dropped, never globally resolved", async () => {
  const { store, dir } = await openTempStore();
  try {
    const seeded = await store.upsertFileBatch([
      twoSymbolFile(),
      {
        ...twoSymbolFile({ path: "util.ts", contentHash: "hash-util" }),
        symbols: [
          { kind: "function", name: "shout", qualifiedName: "shout", span: span(0, 40) },
        ],
        edges: [
          {
            srcQualifiedName: "shout",
            dstQualifiedName: "greet",
            type: "CALLS",
            confidence: 0.8,
            provenance: "heuristic",
            dstPathHint: "missing",
          },
        ],
      },
    ]);
    assert.ok(seeded.ok);
    const stats = await store.schemaStats();
    assert.ok(stats.ok);
    assert.equal(stats.stats.edges, 0, "hinted edge dropped instead of binding the decoy");
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a path hint never matches test/declaration filename variants (codex review)", async () => {
  const { store, dir } = await openTempStore();
  try {
    const seeded = await store.upsertFileBatch([
      {
        ...twoSymbolFile({ path: "main.test.ts", contentHash: "hash-test" }),
        symbols: [
          { kind: "function", name: "greet", qualifiedName: "greet", span: span(0, 40) },
        ],
      },
      twoSymbolFile(),
      {
        ...twoSymbolFile({ path: "util.ts", contentHash: "hash-util" }),
        symbols: [
          { kind: "function", name: "shout", qualifiedName: "shout", span: span(0, 40) },
        ],
        edges: [
          {
            srcQualifiedName: "shout",
            dstQualifiedName: "greet",
            type: "CALLS",
            confidence: 0.8,
            provenance: "heuristic",
            dstPathHint: "main",
          },
        ],
      },
    ]);
    assert.ok(seeded.ok);
    const stats = await store.schemaStats();
    assert.ok(stats.ok);
    assert.deepEqual(
      stats.stats.edgesByType,
      { CALLS: 1 },
      "bound main.ts despite the main.test.ts decoy (not ambiguous-dropped)",
    );
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an empty assertedEdgeProvenances array behaves like an absent one (cursor review round 9)", async () => {
  const { store, dir } = await openTempStore();
  try {
    const seeded = await store.upsertFileBatch([
      {
        ...twoSymbolFile(),
        edges: [
          {
            srcQualifiedName: "greet",
            dstQualifiedName: "format",
            type: "CALLS",
            confidence: 0.9,
            provenance: "heuristic",
          },
        ],
      },
    ]);
    assert.ok(seeded.ok);
    const reingested = await store.upsertFileBatch([
      { ...twoSymbolFile({ contentHash: "hash-2" }), edges: [], assertedEdgeProvenances: [] },
    ]);
    assert.ok(reingested.ok);
    const stats = await store.schemaStats();
    assert.ok(stats.ok);
    assert.equal(stats.stats.edges, 0, "empty scope = legacy delete-all-stale, not protect-all");
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
