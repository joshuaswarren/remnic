/**
 * Index-status + git-invoker parser tests (issue #1553).
 *
 * index_status: stale index with autoIndex:"manual" reports its staleness
 * (last_indexed_head + dirty flag) via index_status rather than pretending
 * freshness.
 *
 * git-invoker parsers: parseNameStatus, parseHunks, parseLogFiles — pure
 * functions tested with synthetic output strings.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GraphStore } from "./graph-store.js";
import { getIndexStatus } from "./index-status.js";
import { META_KEY_LAST_HEAD } from "./reindex.js";
import {
  parseNameStatus,
  parseHunks,
  parseLogFiles,
  type CodingGitInvoker,
} from "./git-invoker.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

async function tempStore(): Promise<{ store: GraphStore; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "index-status-test-"));
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

function mockGit(head: string | null): CodingGitInvoker {
  return {
    revParseHead: () => ({ ok: true, head }),
    isReachable: () => ({ ok: true, reachable: true }),
    diffNameStatus: () => ({ ok: true, entries: [] }),
    diffHunks: () => ({ ok: true, hunks: [] }),
    logFiles: () => ({ ok: true, entries: [] }),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// index_status
// ──────────────────────────────────────────────────────────────────────────

test("index_status: empty store → mode 'empty'", async () => {
  const { store, dir } = await tempStore();
  try {
    const status = getIndexStatus(store, mockGit(SHA_A), dir);
    assert.equal(status.mode, "empty");
    assert.equal(status.lastIndexedHead, null);
    assert.equal(status.currentHead, SHA_A);
    assert.equal(status.dirty, true);
  } finally {
    await dispose(store, dir);
  }
});

test("index_status: fresh index → mode 'fresh'", async () => {
  const { store, dir } = await tempStore();
  try {
    store.writeMeta(META_KEY_LAST_HEAD, SHA_A);
    const status = getIndexStatus(store, mockGit(SHA_A), dir);
    assert.equal(status.mode, "fresh");
    assert.equal(status.dirty, false);
  } finally {
    await dispose(store, dir);
  }
});

test("index_status: stale index → mode 'stale', dirty=true", async () => {
  const { store, dir } = await tempStore();
  try {
    store.writeMeta(META_KEY_LAST_HEAD, SHA_A);
    const status = getIndexStatus(store, mockGit(SHA_B), dir);
    assert.equal(status.mode, "stale");
    assert.equal(status.dirty, true);
    assert.equal(status.lastIndexedHead, SHA_A);
    assert.equal(status.currentHead, SHA_B);
  } finally {
    await dispose(store, dir);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// git-invoker parsers
// ──────────────────────────────────────────────────────────────────────────

test("parseNameStatus: basic add/modify/delete", () => {
  const stdout = "A\tsrc/new.ts\nM\tsrc/changed.ts\nD\tsrc/gone.ts\n";
  const entries = parseNameStatus(stdout);
  assert.equal(entries.length, 3);
  assert.equal(entries[0]!.status, "A");
  assert.equal(entries[0]!.path, "src/new.ts");
  assert.equal(entries[1]!.status, "M");
  assert.equal(entries[1]!.path, "src/changed.ts");
  assert.equal(entries[2]!.status, "D");
  assert.equal(entries[2]!.path, "src/gone.ts");
});

test("parseNameStatus: rename R100", () => {
  const stdout = "R100\tsrc/old.ts\tsrc/new.ts\n";
  const entries = parseNameStatus(stdout);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.status, "R100");
  assert.equal(entries[0]!.path, "src/new.ts");
  assert.equal(entries[0]!.oldPath, "src/old.ts");
});

test("parseNameStatus: empty output", () => {
  assert.equal(parseNameStatus("").length, 0);
  assert.equal(parseNameStatus("\n\n").length, 0);
});

test("parseHunks: basic hunk header", () => {
  const stdout = [
    "diff --git a/src/a.ts b/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -5,3 +5,4 @@",
    " context",
    "+added line",
    " context",
  ].join("\n");
  const hunks = parseHunks(stdout);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0]!.path, "src/a.ts");
  assert.equal(hunks[0]!.newRange.startLine, 5);
  assert.equal(hunks[0]!.newRange.endLine, 9); // 5 + 4
});

test("parseHunks: single-line hunk (no count)", () => {
  const stdout = [
    "+++ b/src/b.ts",
    "@@ -10 +10,1 @@",
  ].join("\n");
  const hunks = parseHunks(stdout);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0]!.path, "src/b.ts");
  assert.equal(hunks[0]!.newRange.startLine, 10);
  assert.equal(hunks[0]!.newRange.endLine, 11);
});

test("parseLogFiles: basic commits", () => {
  const sha1 = "1".repeat(40);
  const sha2 = "2".repeat(40);
  const stdout = `${sha1}\nsrc/a.ts\nsrc/b.ts\n\n${sha2}\nsrc/c.ts\n`;
  const entries = parseLogFiles(stdout);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.sha, sha1);
  assert.deepEqual(entries[0]!.files, ["src/a.ts", "src/b.ts"]);
  assert.equal(entries[1]!.sha, sha2);
  assert.deepEqual(entries[1]!.files, ["src/c.ts"]);
});

test("parseLogFiles: dedupes files within a commit", () => {
  const sha = "f".repeat(40);
  const stdout = `${sha}\nsrc/a.ts\nsrc/a.ts\nsrc/b.ts\n`;
  const entries = parseLogFiles(stdout);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.files.length, 2); // a.ts appears once after dedupe
});
