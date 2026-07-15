/**
 * Provenance-scoped stale-edge deletion (issue #1891).
 *
 * The reindex pipeline re-derives heuristic edges from every fresh parse
 * and asserts them via `StoreFileIR.edges`. Without scoping, that
 * assertion would delete OTHER provenances' edges owned by the same file
 * (trace edges from `ingest_traces`, lsp-upgraded edges) on every
 * re-ingest — destroying state the parse says nothing about (rule 25).
 *
 * Contract under test:
 *  - `assertedEdgeProvenances: ["heuristic"]` + `edges: []` deletes stale
 *    heuristic edges but PRESERVES trace/lsp edges owned by the file;
 *  - absent `assertedEdgeProvenances` keeps the legacy behavior (all
 *    stale src-owned edges deleted) so existing callers are unchanged;
 *  - `edges` undefined keeps the existing early return (no deletes at
 *    all), regardless of the new field.
 */
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
    // Seed: file with a heuristic edge asserted by ingest.
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
    // Add a trace edge owned by the same file via the standalone path.
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

    // Re-ingest: fresh parse supports NO heuristic edges (call removed),
    // asserted with provenance scoping.
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

    // Legacy caller: empty edges array, NO provenance scoping.
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

    // Bare IR re-upsert (no edges field): must not wipe anything, even
    // with the scoping field present — the early return wins.
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
    // LSP layer upgrades the same (src, dst, type) row.
    const upgraded = await store.upsertEdges([
      { ...heuristicEdge, confidence: 1, provenance: "lsp" },
    ]);
    assert.ok(upgraded.ok);

    // Reindex re-derives the same heuristic key with provenance scoping:
    // the assertion keeps the row alive but must NOT overwrite the
    // stronger out-of-scope provenance back to heuristic.
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

    // Fresh parse no longer supports the call: scoped assertion includes
    // lsp, so the upgraded row retires with its heuristic ancestor.
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
    // Two files each declaring a `greet`; the hinted edge must bind the
    // one in lib/main.ts, never the decoy.
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
      // A decoy `greet` exists in an UNRELATED file...
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
            // ...but the import pointed at ./missing, which is not indexed.
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
