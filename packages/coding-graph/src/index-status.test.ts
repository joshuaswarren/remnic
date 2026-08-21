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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GraphStore } from "./graph-store.js";
import { getIndexStatus } from "./index-status.js";
import { META_KEY_LAST_HEAD } from "./reindex.js";
import {
  defaultCodingGitInvoker,
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
    listTrackedFiles: () => ({ ok: true, paths: [] }),  };
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

test("index_status: repo with no commits but stored head → stale, not fresh (cursor Bugbot: 'Index status false fresh')", async () => {
  const { store, dir } = await tempStore();
  try {
    // The index was built against a real HEAD, but the repo now reports
    // no commits (unborn/reset HEAD). The index cannot match a repo with
    // no commits — it must read as stale, not fresh.
    store.writeMeta(META_KEY_LAST_HEAD, SHA_A);
    const status = getIndexStatus(store, mockGit(null), dir);
    assert.equal(status.mode, "stale");
    assert.equal(status.dirty, true);
    assert.equal(status.lastIndexedHead, SHA_A);
    assert.equal(status.currentHead, null);
  } finally {
    await dispose(store, dir);
  }
});


test("diffHunks: captures staged changes via git diff HEAD (chatgpt-codex-connector: 'Include staged hunks in diffHunks')", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "git-staged-"));
  try {
    const exec = (cmd: string) =>
      execSync(cmd, { cwd: dir, stdio: "ignore" });
    exec("git init -q");
    exec('git config user.email "t@t.t"');
    exec('git config user.name "t"');
    await import("node:fs/promises").then((fs) => fs.mkdir(path.join(dir, "src"), { recursive: true }));
    await writeFile(path.join(dir, "src/a.ts"), "export function foo() {}\n");
    exec("git add src/a.ts");
    exec('git -c commit.gpgsign=false commit -q -m init');
    // Stage a change (git add) — plain `git diff` would miss this.
    await writeFile(path.join(dir, "src/a.ts"), "export function foo() { return 1; }\n");
    exec("git add src/a.ts");
    const invoker = defaultCodingGitInvoker();
    const result = invoker.diffHunks(dir, ["src/a.ts"]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.hunks.length > 0, "staged hunks must be captured (git diff HEAD)");
  } finally {
    await rm(dir, { recursive: true, force: true });
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


// ──────────────────────────────────────────────────────────────────────────
// Round-2 review fixes — git-invoker parsers + index_status
// ──────────────────────────────────────────────────────────────────────────

test("parseLogFiles: real git layout (blank line after SHA) (chatgpt-codex-connector: 'Parse real git log records')", () => {
  const sha1 = "1".repeat(40);
  const sha2 = "2".repeat(40);
  // Real git log --format=%H --name-only emits a blank line AFTER the
  // SHA before the file names. The old blank-line block split put the SHA
  // alone in one block (zero files) and the names in the next (failed).
  const stdout = `${sha1}\n\nsrc/a.ts\nsrc/b.ts\n\n${sha2}\n\nsrc/c.ts\n`;
  const entries = parseLogFiles(stdout);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.sha, sha1);
  assert.deepEqual(entries[0]!.files, ["src/a.ts", "src/b.ts"]);
  assert.equal(entries[1]!.sha, sha2);
  assert.deepEqual(entries[1]!.files, ["src/c.ts"]);
});

test("parseHunks: deletion-only hunk (zero new-count) covers the adjacent line (chatgpt-codex-connector: 'Map deletion-only hunks')", () => {
  // `@@ -2 +1,0 @@` = delete old line 2; new side has 0 lines at line 1.
  const stdout = ["+++ b/src/a.ts", "@@ -2 +1,0 @@"].join("\n");
  const hunks = parseHunks(stdout);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0]!.newRange.startLine, 1);
  // Must be a non-empty range so it can overlap a symbol span.
  assert.ok(hunks[0]!.newRange.endLine > hunks[0]!.newRange.startLine);
});

test("index_status: pending parse failures report stale even when heads match (chatgpt-codex-connector: 'Mark pending parse retries as stale')", async () => {
  const { store, dir } = await tempStore();
  try {
    store.writeMeta(META_KEY_LAST_HEAD, SHA_A);
    store.writeMeta("pending_parse_failures", JSON.stringify(["src/broken.ts"]));
    const status = getIndexStatus(store, mockGit(SHA_A), dir);
    assert.equal(status.mode, "stale");
    assert.equal(status.dirty, true);
  } finally {
    await dispose(store, dir);
  }
});

test("revParseHead: non-git directory returns git_error, not head:null (chatgpt-codex-connector: 'Return a git failure for non-repository HEAD')", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "notgit-"));
  try {
    const invoker = defaultCodingGitInvoker();
    const result = invoker.revParseHead(dir);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "git_error");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseHunks: deleted file (+++ /dev/null) does not leak its hunks to the previous file (chatgpt-codex-connector: 'Clear hunk path for deleted files')", () => {
  // a.ts is modified, then b.ts is deleted (+++ /dev/null). A following
  // @@ hunk for b.ts must NOT be attributed to a.ts.
  const stdout = [
    "diff --git a/src/a.ts b/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1,2 @@",
    "diff --git a/src/b.ts b/src/b.ts",
    "deleted file mode 100644",
    "--- a/src/b.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
  ].join("\n");
  const hunks = parseHunks(stdout);
  // b.ts's deletion hunk followed `+++ /dev/null`, which clears
  // currentPath → the @@ hunk is dropped entirely, NOT attributed to
  // a.ts. Exactly one hunk survives: a.ts's own +1,2 hunk.
  assert.equal(hunks.length, 1, "b.ts deletion hunk dropped after /dev/null");
  assert.equal(hunks[0].path, "src/a.ts");
  assert.equal(hunks[0].newRange.startLine, 1);
  assert.equal(hunks[0].newRange.endLine, 3); // +1,2 → [1,3)
  // Defensive: no surviving hunk may carry a path that leaked from a
  // prior file across a /dev/null boundary.
  assert.ok(
    hunks.every((h) => h.path === "src/a.ts"),
    "no hunk leaked a foreign path across /dev/null",
  );
});
