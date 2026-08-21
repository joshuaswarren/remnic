/**
 * LSP edge reconciliation tests (issue #1895).
 *
 * When the LSP resolution pass re-derives edges from the CURRENT source,
 * it must retire prior lsp-provenance edges whose (src, dst, type) key it
 * no longer derives. The store's reconcileLspEdges method does this;
 * the LSP executor wires it after each file batch's upgrades are applied.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GraphStore, type FileIR } from "./graph-store.js";

const span = (startByte: number, endByte: number) => ({ startByte, endByte });

function fileIR(overrides: Partial<FileIR> & { path: string }): FileIR {
  return {
    language: "typescript",
    contentHash: `h-${overrides.path}`,
    symbols: [],
    imports: [],
    exports: [],
    callSites: [],
    routes: [],
    ...overrides,
  } as FileIR;
}

async function openTempStore(): Promise<{ store: GraphStore; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "cg-lsp-recon-"));
  const store = await GraphStore.open({ dbPath: path.join(dir, "graph.sqlite") });
  return { store, dir };
}

const HEUR = { confidence: 0.9, provenance: "heuristic" as const };
const LSP = { confidence: 1, provenance: "lsp" as const };

test("reconcile retires lsp edges no longer derived; keeps re-derived ones", async () => {
  const { store, dir } = await openTempStore();
  try {
    // Seed: greet calls format (heuristic) + helper (lsp-upgraded).
    await store.upsertFileBatch([
      {
        ...fileIR({
          path: "main.ts",
          symbols: [
            { kind: "function", name: "greet", qualifiedName: "greet", span: span(0, 70) },
            { kind: "function", name: "format", qualifiedName: "format", span: span(71, 132) },
            { kind: "function", name: "helper", qualifiedName: "helper", span: span(133, 190) },
          ],
        }),
        edges: [
          { srcQualifiedName: "greet", dstQualifiedName: "format", type: "CALLS", ...HEUR },
          { srcQualifiedName: "greet", dstQualifiedName: "helper", type: "CALLS", ...HEUR },
        ],
      },
    ]);
    // LSP upgraded both.
    await store.upsertEdges([
      { srcQualifiedName: "greet", dstQualifiedName: "format", type: "CALLS", ...LSP },
      { srcQualifiedName: "greet", dstQualifiedName: "helper", type: "CALLS", ...LSP },
    ]);

    let stats = await store.schemaStats();
    assert.ok(stats.ok);
    assert.equal(stats.stats.edges, 2, "seed: 2 lsp-upgraded CALLS edges");

    // LSP re-run derives ONLY greet->format (helper call was removed).
    // Reconcile: retire lsp edges for main.ts NOT in the new set.
    const deleted = store.reconcileLspEdges("main.ts", [
      { srcQualifiedName: "greet", dstQualifiedName: "format", type: "CALLS" },
    ]);
    assert.equal(deleted, 1, "retired the stale greet->helper lsp edge");

    stats = await store.schemaStats();
    assert.ok(stats.ok);
    assert.equal(stats.stats.edges, 1, "only the re-derived edge remains");
    assert.deepEqual(stats.stats.edgesByType, { CALLS: 1 });
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcile preserves heuristic edges and trace edges untouched", async () => {
  const { store, dir } = await openTempStore();
  try {
    await store.upsertFileBatch([
      {
        ...fileIR({
          path: "main.ts",
          symbols: [
            { kind: "function", name: "greet", qualifiedName: "greet", span: span(0, 70) },
            { kind: "function", name: "format", qualifiedName: "format", span: span(71, 132) },
          ],
        }),
        edges: [
          { srcQualifiedName: "greet", dstQualifiedName: "format", type: "CALLS", ...HEUR },
        ],
      },
    ]);
    await store.upsertEdges([
      { srcQualifiedName: "greet", dstQualifiedName: "format", type: "CALLS", ...LSP },
      { srcQualifiedName: "greet", dstQualifiedName: "format", type: "HTTP_CALLS", confidence: 1, provenance: "trace" },
    ]);

    // LSP re-run found nothing for main.ts → reconcile with empty asserted set.
    const deleted = store.reconcileLspEdges("main.ts", []);
    assert.equal(deleted, 1, "retired the lsp CALLS edge");

    const stats = await store.schemaStats();
    assert.ok(stats.ok);
    assert.deepEqual(stats.stats.edgesByType, { HTTP_CALLS: 1 }, "trace edge untouched");
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcile with no prior lsp edges is a no-op", async () => {
  const { store, dir } = await openTempStore();
  try {
    await store.upsertFileBatch([
      {
        ...fileIR({
          path: "main.ts",
          symbols: [
            { kind: "function", name: "greet", qualifiedName: "greet", span: span(0, 70) },
          ],
        }),
        edges: [],
      },
    ]);
    const deleted = store.reconcileLspEdges("main.ts", [
      { srcQualifiedName: "greet", dstQualifiedName: "missing", type: "CALLS" },
    ]);
    assert.equal(deleted, 0);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
