/**
 * Co-change mining tests (issue #1553).
 *
 * mineCoChangeEdges: pure function over commit→files entries.
 * Tests: support/confidence thresholds, idempotency, byte-stability.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GraphStore } from "./graph-store.js";
import {
  mineCoChangeEdges,
  mineAndStoreCoChanges,
  DEFAULT_CO_CHANGE_CONFIG,
  type CoChangeConfig,
} from "./co-change.js";
import type { CodingGitInvoker, LogFilesEntry } from "./git-invoker.js";

// ──────────────────────────────────────────────────────────────────────────
// Pure mining tests
// ──────────────────────────────────────────────────────────────────────────

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const COMMIT_C = "c".repeat(40);
const COMMIT_D = "d".repeat(40);

test("mineCoChangeEdges: basic — two files co-changed 3 times", () => {
  const entries: LogFilesEntry[] = [
    { sha: COMMIT_A, files: ["src/a.ts", "src/b.ts"] },
    { sha: COMMIT_B, files: ["src/a.ts", "src/b.ts"] },
    { sha: COMMIT_C, files: ["src/a.ts", "src/b.ts"] },
  ];
  const edges = mineCoChangeEdges(entries, {
    maxCommits: 500,
    minSupport: 3,
    minConfidence: 0.3,
  });
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.fileA, "src/a.ts");
  assert.equal(edges[0]!.fileB, "src/b.ts");
  assert.equal(edges[0]!.support, 3);
  assert.equal(edges[0]!.confidence, 1.0); // 3/3 = 1.0
});

test("mineCoChangeEdges: below support threshold → no edge", () => {
  const entries: LogFilesEntry[] = [
    { sha: COMMIT_A, files: ["src/a.ts", "src/b.ts"] },
    { sha: COMMIT_B, files: ["src/a.ts", "src/b.ts"] },
  ];
  const edges = mineCoChangeEdges(entries, DEFAULT_CO_CHANGE_CONFIG);
  // support=2 < minSupport=3 → no edge.
  assert.equal(edges.length, 0);
});

test("mineCoChangeEdges: below confidence threshold → no edge", () => {
  // a.ts changed 10 times, b.ts changed 10 times, co-changed 3 times.
  // confidence = 3/10 = 0.3 — exactly at threshold (minConfidence=0.3).
  // With minConfidence=0.31 → no edge.
  const entries: LogFilesEntry[] = [
    { sha: COMMIT_A, files: ["src/a.ts", "src/b.ts"] },
    { sha: COMMIT_B, files: ["src/a.ts", "src/b.ts"] },
    { sha: COMMIT_C, files: ["src/a.ts", "src/b.ts"] },
    // a.ts changed alone 7 more times.
    ...Array.from({ length: 7 }, (_, i) => ({
      sha: `${i}${"x".repeat(39)}`,
      files: ["src/a.ts"],
    })),
    // b.ts changed alone 7 more times.
    ...Array.from({ length: 7 }, (_, i) => ({
      sha: `${i + 7}${"y".repeat(39)}`,
      files: ["src/b.ts"],
    })),
  ];
  const config: CoChangeConfig = {
    maxCommits: 500,
    minSupport: 3,
    minConfidence: 0.31,
  };
  const edges = mineCoChangeEdges(entries, config);
  assert.equal(edges.length, 0);
});

test("mineCoChangeEdges: idempotent — same input, same output", () => {
  const entries: LogFilesEntry[] = [
    { sha: COMMIT_A, files: ["src/a.ts", "src/b.ts", "src/c.ts"] },
    { sha: COMMIT_B, files: ["src/a.ts", "src/b.ts"] },
    { sha: COMMIT_C, files: ["src/b.ts", "src/c.ts"] },
    { sha: COMMIT_D, files: ["src/a.ts", "src/c.ts"] },
  ];
  const e1 = mineCoChangeEdges(entries, DEFAULT_CO_CHANGE_CONFIG);
  const e2 = mineCoChangeEdges(entries, DEFAULT_CO_CHANGE_CONFIG);
  assert.deepEqual(e1, e2);
});

test("mineCoChangeEdges: byte-stable sort order", () => {
  const entries: LogFilesEntry[] = [
    { sha: COMMIT_A, files: ["src/z.ts", "src/a.ts"] },
    { sha: COMMIT_B, files: ["src/z.ts", "src/a.ts"] },
    { sha: COMMIT_C, files: ["src/z.ts", "src/a.ts"] },
  ];
  const edges = mineCoChangeEdges(entries, DEFAULT_CO_CHANGE_CONFIG);
  // Sorted by fileA then fileB — a.ts before z.ts.
  assert.equal(edges[0]!.fileA, "src/a.ts");
  assert.equal(edges[0]!.fileB, "src/z.ts");
});

test("mineCoChangeEdges: empty input → empty output", () => {
  const edges = mineCoChangeEdges([], DEFAULT_CO_CHANGE_CONFIG);
  assert.equal(edges.length, 0);
});

// ──────────────────────────────────────────────────────────────────────────
// mineAndStoreCoChanges — integration with GraphStore
// ──────────────────────────────────────────────────────────────────────────

function mockGitForLog(entries: LogFilesEntry[]): CodingGitInvoker {
  return {
    revParseHead: () => ({ ok: true, head: COMMIT_A }),
    isReachable: () => ({ ok: true, reachable: true }),
    diffNameStatus: () => ({ ok: true, entries: [] }),
    diffHunks: () => ({ ok: true, hunks: [] }),
    logFiles: () => ({ ok: true, entries }),
    listTrackedFiles: () => ({ ok: true, paths: [] }),  };
}

async function tempStore(): Promise<{ store: GraphStore; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "cochange-test-"));
  const store = await GraphStore.open({
    dbPath: path.join(dir, "graph.sqlite"),
    repoRoot: dir,
  });
  return { store, dir };
}

async function dispose(store: GraphStore, dir: string): Promise<void> {
  await store.close();
  await rm(dir, { recursive: true, force: true });
}

test("mineAndStoreCoChanges: stores edges + idempotent re-run", async () => {
  const { store, dir } = await tempStore();
  try {
    const entries: LogFilesEntry[] = [
      { sha: COMMIT_A, files: ["src/a.ts", "src/b.ts"] },
      { sha: COMMIT_B, files: ["src/a.ts", "src/b.ts"] },
      { sha: COMMIT_C, files: ["src/a.ts", "src/b.ts"] },
    ];
    const git = mockGitForLog(entries);

    const r1 = await mineAndStoreCoChanges({ store, git, repoRoot: dir });
    assert.equal(r1.ok, true);
    if (!r1.ok) return;
    assert.equal(r1.edges.length, 1);

    // Verify edges persisted.
    const coForA = store.readCoChanges("src/a.ts");
    assert.equal(coForA.ok, true);
    if (!coForA.ok) return;
    assert.equal(coForA.edges.length, 1);
    assert.equal(coForA.edges[0]!.fileB, "src/b.ts");

    // Re-run: idempotent (clear + repopulate).
    const r2 = await mineAndStoreCoChanges({ store, git, repoRoot: dir });
    assert.equal(r2.ok, true);
    const coForA2 = store.readCoChanges("src/a.ts");
    assert.equal(coForA2.ok, true);
    assert.equal(coForA2.ok ? coForA2.edges.length : -1, 1);
  } finally {
    await dispose(store, dir);
  }
});
