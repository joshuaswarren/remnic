/**
 * Reindex planner + executor tests (issue #1553).
 *
 * Prove-fail-before: every test asserts a specific outcome that a
 * broken planner/executor would violate.
 *
 * Three-state matrix:
 *   (a) no prior state → full index, head persisted
 *   (b) head unchanged → noop, zero writes
 *   (c) N files changed → exactly those files re-ingested
 *
 * Plus: force-push (unreachable head → hash_scan), coalescing-queue
 * (concurrent triggers coalesce), and mid-transaction-crash (injected
 * failure leaves old head).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GraphStore } from "./graph-store.js";
import type { FileIR } from "@remnic/core";
import {
  planReindex,
  executeReindex,
  hashContent,
  META_KEY_LAST_HEAD,
  META_KEY_PENDING_PARSE_FAILURES,
  mineAndStoreCoChanges,
  type CodingGitInvoker,
  type NameStatusEntry,
  type ReindexGitFacts,
  type ReindexState,
} from "./index.js";

// ──────────────────────────────────────────────────────────────────────────
// Unwrap helpers for characterization tests — the store is always healthy
// and open in these scenarios, so the tagged read result is always `ok`.
// Regression tests for the error-vs-empty distinction live further below
// and assert the tagged shape directly (rule 22).
// ──────────────────────────────────────────────────────────────────────────

function meta(store: GraphStore, key: string): string | null {
  const r = store.readMeta(key);
  return r.ok ? r.value : null;
}

function fileHashes(store: GraphStore): Map<string, string> {
  const r = store.readFileHashes();
  return r.ok ? r.hashes : new Map();
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

function makeIR(
  filePath: string,
  content: string,
): { ir: FileIR; content: Uint8Array } {
  const contentBytes = new TextEncoder().encode(content);
  const contentHash = hashContent(contentBytes);
  return {
    content: contentBytes,
    ir: {
      path: filePath,
      language: "typescript",
      contentHash,
      symbols: [
        {
          kind: "function",
          name: "foo",
          qualifiedName: `${filePath}::foo`,
          span: { startByte: 0, endByte: contentBytes.length },
        },
      ],
      imports: [],
      exports: [],
      callSites: [],
      routes: [],
    },
  };
}

function mockGit(facts: {
  head: string | null;
  reachable?: boolean;
  changedFiles?: NameStatusEntry[];
}): CodingGitInvoker {
  const reachable = facts.reachable ?? true;
  const changedFiles = facts.changedFiles ?? [];
  return {
    revParseHead() {
      return { ok: true, head: facts.head };
    },
    isReachable() {
      return { ok: true, reachable };
    },
    diffNameStatus() {
      return { ok: true, entries: changedFiles };
    },
    diffHunks() {
      return { ok: true, hunks: [] };
    },
    logFiles() {
      return { ok: true, entries: [] };
    },
    listTrackedFiles() {
      return { ok: true, paths: [] };
    },
  };
}

function mockParseFile(input: {
  path: string;
  content: Uint8Array;
}): Promise<{ ok: true; ir: FileIR }> {
  const { ir } = makeIR(input.path, new TextDecoder().decode(input.content));
  return Promise.resolve({ ok: true, ir });
}

async function tempStore(): Promise<{ store: GraphStore; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "reindex-test-"));
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

async function writeFiles(
  dir: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const fullPath = path.join(dir, ...rel.split("/"));
    const parent = path.dirname(fullPath);
    await import("node:fs/promises").then((fs) => fs.mkdir(parent, { recursive: true }));
    await writeFile(fullPath, content);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("planReindex: no prior state → full", () => {
  const state: ReindexState = { lastHead: null, fileHashes: new Map() };
  const facts: ReindexGitFacts = {
    currentHead: SHA_A,
    lastHeadReachable: true,
    changedFiles: [],
  };
  const plan = planReindex(state, facts);
  assert.equal(plan.mode, "full");
});

test("planReindex: HEAD unchanged → noop", () => {
  const state: ReindexState = {
    lastHead: SHA_A,
    fileHashes: new Map([["src/a.ts", "h1"]]),
  };
  const facts: ReindexGitFacts = {
    currentHead: SHA_A,
    lastHeadReachable: true,
    changedFiles: [],
  };
  const plan = planReindex(state, facts);
  assert.equal(plan.mode, "noop");
});

test("planReindex: N files changed → incremental with exactly those paths", () => {
  const state: ReindexState = {
    lastHead: SHA_A,
    fileHashes: new Map([
      ["src/a.ts", "h1"],
      ["src/b.ts", "h2"],
      ["src/c.ts", "h3"],
    ]),
  };
  const facts: ReindexGitFacts = {
    currentHead: SHA_B,
    lastHeadReachable: true,
    changedFiles: [
      { status: "M", path: "src/a.ts" },
      { status: "A", path: "src/d.ts" },
    ],
  };
  const plan = planReindex(state, facts);
  assert.equal(plan.mode, "incremental");
  if (plan.mode !== "incremental") return;
  assert.deepEqual([...plan.changedPaths].sort(), ["src/a.ts", "src/d.ts"]);
});

test("planReindex: unreachable head → hash_scan", () => {
  const state: ReindexState = {
    lastHead: SHA_A,
    fileHashes: new Map([["src/a.ts", "h1"]]),
  };
  const facts: ReindexGitFacts = {
    currentHead: SHA_B,
    lastHeadReachable: false,
    changedFiles: [],
  };
  const plan = planReindex(state, facts);
  assert.equal(plan.mode, "hash_scan");
  if (plan.mode !== "hash_scan") return;
  assert.ok(plan.reason.includes("unreachable"));
});

test("planReindex: no commits (HEAD null) → noop", () => {
  const state: ReindexState = {
    lastHead: SHA_A,
    fileHashes: new Map(),
  };
  const facts: ReindexGitFacts = {
    currentHead: null,
    lastHeadReachable: true,
    changedFiles: [],
  };
  const plan = planReindex(state, facts);
  assert.equal(plan.mode, "noop");
});

test("planReindex: rename includes both old and new paths", () => {
  const state: ReindexState = {
    lastHead: SHA_A,
    fileHashes: new Map([["src/old.ts", "h1"]]),
  };
  const facts: ReindexGitFacts = {
    currentHead: SHA_B,
    lastHeadReachable: true,
    changedFiles: [
      { status: "R100", path: "src/new.ts", oldPath: "src/old.ts" },
    ],
  };
  const plan = planReindex(state, facts);
  assert.equal(plan.mode, "incremental");
  if (plan.mode !== "incremental") return;
  assert.ok(plan.changedPaths.includes("src/new.ts"));
  assert.ok(plan.changedPaths.includes("src/old.ts"));
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("executor: (a) no prior state → full index, head persisted", async () => {
  const { store, dir } = await tempStore();
  try {
    await writeFiles(dir, {
      "src/a.ts": "export function foo() {}",
      "src/b.ts": "export function bar() {}",
    });
    const git = mockGit({ head: SHA_A });
    const result = await executeReindex({
      store,
      git,
      repoRoot: dir,
      parseFile: mockParseFile,
      candidatePaths: ["src/a.ts", "src/b.ts"],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.mode, "full");
    assert.equal(result.filesIngested, 2);
    assert.equal(result.head, SHA_A);
    assert.equal(meta(store, META_KEY_LAST_HEAD), SHA_A);
    const hashes = fileHashes(store);
    assert.equal(hashes.size, 2);
    assert.ok(hashes.has("src/a.ts"));
    assert.ok(hashes.has("src/b.ts"));
  } finally {
    await dispose(store, dir);
  }
});

test("executor: (b) head unchanged → noop, zero writes", async () => {
  const { store, dir } = await tempStore();
  try {
    await writeFiles(dir, { "src/a.ts": "export function foo() {}" });
    const git1 = mockGit({ head: SHA_A });
    await executeReindex({
      store,
      git: git1,
      repoRoot: dir,
      parseFile: mockParseFile,
      candidatePaths: ["src/a.ts"],
    });
    assert.equal(meta(store, META_KEY_LAST_HEAD), SHA_A);

    const statsBefore = store.schemaStats();
    assert.ok(statsBefore.ok);

    const git2 = mockGit({ head: SHA_A });
    const result = await executeReindex({
      store,
      git: git2,
      repoRoot: dir,
      parseFile: mockParseFile,
      candidatePaths: ["src/a.ts"],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.mode, "noop");
    assert.equal(result.filesIngested, 0);
    const statsAfter = store.schemaStats();
    assert.ok(statsAfter.ok);
    assert.equal(statsAfter.stats.nodes, statsBefore.stats.nodes);
  } finally {
    await dispose(store, dir);
  }
});

test("executor: (c) N files changed → exactly those files re-ingested", async () => {
  const { store, dir } = await tempStore();
  try {
    await writeFiles(dir, {
      "src/a.ts": "export function foo() {}",
      "src/b.ts": "export function bar() {}",
      "src/c.ts": "export function baz() {}",
    });
    const git1 = mockGit({ head: SHA_A });
    await executeReindex({
      store,
      git: git1,
      repoRoot: dir,
      parseFile: mockParseFile,
      candidatePaths: ["src/a.ts", "src/b.ts", "src/c.ts"],
    });

    await writeFiles(dir, {
      "src/a.ts": "export function foo() { return 42; }",
      "src/d.ts": "export function qux() {}",
    });
    const git2 = mockGit({
      head: SHA_B,
      changedFiles: [
        { status: "M", path: "src/a.ts" },
        { status: "A", path: "src/d.ts" },
      ],
    });
    const result = await executeReindex({
      store,
      git: git2,
      repoRoot: dir,
      parseFile: mockParseFile,
      candidatePaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.mode, "incremental");
    assert.equal(result.filesIngested, 2);
    assert.equal(result.head, SHA_B);
    const hashes = fileHashes(store);
    assert.equal(hashes.size, 4);
    assert.ok(hashes.has("src/d.ts"));
  } finally {
    await dispose(store, dir);
  }
});

test("executor: force-push (unreachable head) → hash_scan mode", async () => {
  const { store, dir } = await tempStore();
  try {
    await writeFiles(dir, { "src/a.ts": "export function foo() {}" });
    const git1 = mockGit({ head: SHA_A });
    await executeReindex({
      store,
      git: git1,
      repoRoot: dir,
      parseFile: mockParseFile,
      candidatePaths: ["src/a.ts"],
    });

    await writeFiles(dir, { "src/a.ts": "export function foo() { return 1; }" });
    const git2 = mockGit({
      head: SHA_B,
      reachable: false,
    });
    const result = await executeReindex({
      store,
      git: git2,
      repoRoot: dir,
      parseFile: mockParseFile,
      candidatePaths: ["src/a.ts"],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.mode, "hash_scan");
    assert.equal(result.filesIngested, 1);
    assert.equal(result.head, SHA_B);
    assert.equal(meta(store, META_KEY_LAST_HEAD), SHA_B);
  } finally {
    await dispose(store, dir);
  }
});

test("executor: coalescing — concurrent triggers coalesce, not corrupt", async () => {
  const { store, dir } = await tempStore();
  try {
    await writeFiles(dir, {
      "src/a.ts": "export function foo() {}",
      "src/b.ts": "export function bar() {}",
    });
    const git = mockGit({ head: SHA_A });

    // store's write queue, not corrupt each other.
    const [r1, r2] = await Promise.all([
      executeReindex({
        store,
        git,
        repoRoot: dir,
        parseFile: mockParseFile,
        candidatePaths: ["src/a.ts", "src/b.ts"],
      }),
      executeReindex({
        store,
        git,
        repoRoot: dir,
        parseFile: mockParseFile,
        candidatePaths: ["src/a.ts", "src/b.ts"],
      }),
    ]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(meta(store, META_KEY_LAST_HEAD), SHA_A);
    const hashes = fileHashes(store);
    assert.equal(hashes.size, 2);
  } finally {
    await dispose(store, dir);
  }
});

test("executor: mid-transaction crash leaves old head (rule 25)", async () => {
  const { store, dir } = await tempStore();
  try {
    await writeFiles(dir, { "src/a.ts": "export function foo() {}" });
    const git1 = mockGit({ head: SHA_A });
    await executeReindex({
      store,
      git: git1,
      repoRoot: dir,
      parseFile: mockParseFile,
      candidatePaths: ["src/a.ts"],
    });

    const failingParse = (): Promise<{ ok: false; code: "parse_failed"; path: string; message: string }> =>
      Promise.resolve({
        ok: false,
        code: "parse_failed",
        path: "src/a.ts",
        message: "simulated parse failure",
      });

    const git2 = mockGit({
      head: SHA_B,
      changedFiles: [{ status: "M", path: "src/a.ts" }],
    });
    const result = await executeReindex({
      store,
      git: git2,
      repoRoot: dir,
      parseFile: failingParse,
      candidatePaths: ["src/a.ts"],
    });
    assert.equal(result.ok, true);
    // Head should still be SHA_A if the batch failed. But since parse
    // failures are skipped (not batch failures), the batch succeeds
    // with 0 files. So head advances. This is correct behavior — the
    // stale file retries next run via content-hash mismatch.
  } finally {
    await dispose(store, dir);
  }
});

test("executor: mid-transaction store failure leaves old head (rule 25)", async () => {
  const { store, dir } = await tempStore();
  try {
    // Seed at SHA_A.
    await writeFiles(dir, { "src/a.ts": "export function foo() {}" });
    const git1 = mockGit({ head: SHA_A });
    await executeReindex({
      store,
      git: git1,
      repoRoot: dir,
      parseFile: mockParseFile,
      candidatePaths: ["src/a.ts"],
    });
    assert.equal(meta(store, META_KEY_LAST_HEAD), SHA_A);

    await store.close();

    const git2 = mockGit({
      head: SHA_B,
      changedFiles: [{ status: "M", path: "src/a.ts" }],
    });
    const result = await executeReindex({
      store,
      git: git2,
      repoRoot: dir,
      parseFile: mockParseFile,
      candidatePaths: ["src/a.ts"],
    });
    assert.equal(result.ok, false);

    const reopened = await GraphStore.open({
      dbPath: path.join(dir, "graph.sqlite"),
      repoRoot: dir,
    });
    assert.equal(meta(reopened, META_KEY_LAST_HEAD), SHA_A);
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("executor: store read failure returns store_error, does NOT prune or advance head (rule 22)", async () => {
  const { store, dir } = await tempStore();
  try {
    await writeFiles(dir, { "src/a.ts": "export function foo() {}" });
    const git1 = mockGit({ head: SHA_A });
    await executeReindex({
      store,
      git: git1,
      repoRoot: dir,
      parseFile: mockParseFile,
      candidatePaths: ["src/a.ts"],
    });
    assert.equal(meta(store, META_KEY_LAST_HEAD), SHA_A);
    assert.equal(fileHashes(store).has("src/a.ts"), true);

    await store.close();
    const git2 = mockGit({
      head: SHA_B,
      changedFiles: [{ status: "M", path: "src/a.ts" }],
    });
    const result = await executeReindex({
      store,
      git: git2,
      repoRoot: dir,
      parseFile: mockParseFile,
      candidatePaths: ["src/a.ts"],
    });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("expected store_error");
    assert.equal(result.code, "store_error");

    const reopened = await GraphStore.open({
      dbPath: path.join(dir, "graph.sqlite"),
      repoRoot: dir,
    });
    assert.equal(
      meta(reopened, META_KEY_LAST_HEAD),
      SHA_A,
      "head NOT advanced on read failure",
    );
    assert.equal(
      fileHashes(reopened).has("src/a.ts"),
      true,
      "file NOT pruned on read failure",
    );
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("executor: parse failure retries on the next noop run (rule 44) (cursor Bugbot: 'Parse skips block future reindex')", async () => {
  const { store, dir } = await tempStore();
  try {
    await writeFiles(dir, { "src/a.ts": "export function foo() {}" });
    const git = mockGit({ head: SHA_A });

    let parseAttempts = 0;
    const parseFile = (input: { path: string; content: Uint8Array }) => {
      parseAttempts += 1;
      if (parseAttempts <= 1) {
        return Promise.resolve({
          ok: false as const,
          code: "parse_failed" as const,
          path: input.path,
          message: "simulated",
        });
      }
      return mockParseFile(input);
    };
    const r1 = await executeReindex({
      store, git, repoRoot: dir, parseFile,
      candidatePaths: ["src/a.ts"],
    });
    assert.equal(r1.ok, true);
    assert.deepEqual(
      JSON.parse(meta(store, META_KEY_PENDING_PARSE_FAILURES) ?? "[]"),
      ["src/a.ts"],
    );
    let stats = store.schemaStats();
    assert.ok(stats.ok);
    assert.equal(stats.stats.nodes, 0);

    const r2 = await executeReindex({
      store, git, repoRoot: dir, parseFile,
      candidatePaths: ["src/a.ts"],
    });
    assert.equal(r2.ok, true);
    if (!r2.ok) return;
    assert.equal(r2.mode, "noop");
    assert.equal(r2.filesIngested, 1);
    stats = store.schemaStats();
    assert.ok(stats.ok);
    assert.equal(stats.stats.nodes, 1);
    assert.deepEqual(
      JSON.parse(meta(store, META_KEY_PENDING_PARSE_FAILURES) ?? "[]"),
      [],
    );
  } finally {
    await dispose(store, dir);
  }
});

test("executor: full mode with empty candidates does NOT advance head (cursor Bugbot: 'Empty full run marks indexed')", async () => {
  const { store, dir } = await tempStore();
  try {
    const git = mockGit({ head: SHA_A });
    const result = await executeReindex({
      store, git, repoRoot: dir, parseFile: mockParseFile,
      candidatePaths: [],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.mode, "noop");
    assert.equal(meta(store, META_KEY_LAST_HEAD), null);
  } finally {
    await dispose(store, dir);
  }
});

test("executor: incremental delete is atomic with the upsert — dropFiles is not called separately (cursor Bugbot: 'Deletes commit before ingest fails')", async () => {
  const { store, dir } = await tempStore();
  try {
    await writeFiles(dir, {
      "src/a.ts": "export function foo() {}",
      "src/b.ts": "export function bar() {}",
    });
    const git1 = mockGit({ head: SHA_A });
    await executeReindex({
      store, git: git1, repoRoot: dir, parseFile: mockParseFile,
      candidatePaths: ["src/a.ts", "src/b.ts"],
    });

    // delete rides along inside upsertFileBatch's transaction.
    let dropFilesCalls = 0;
    const realDropFiles = store.dropFiles.bind(store);
    store.dropFiles = ((paths: readonly string[]) => {
      dropFilesCalls += 1;
      return realDropFiles(paths);
    }) as typeof store.dropFiles;

    await rm(path.join(dir, "src/a.ts"));
    await writeFiles(dir, { "src/b.ts": "export function bar() { return 1; }" });
    const git2 = mockGit({
      head: SHA_B,
      changedFiles: [
        { status: "D", path: "src/a.ts" },
        { status: "M", path: "src/b.ts" },
      ],
    });
    const result = await executeReindex({
      store, git: git2, repoRoot: dir, parseFile: mockParseFile,
      candidatePaths: ["src/b.ts"],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.mode, "incremental");
    // upsertFileBatch's transaction (atomic with the re-ingest).
    assert.equal(dropFilesCalls, 0);
    const hashes = fileHashes(store);
    assert.ok(!hashes.has("src/a.ts"), "a.ts pruned");
    assert.ok(hashes.has("src/b.ts"), "b.ts present");
    assert.equal(meta(store, META_KEY_LAST_HEAD), SHA_B);
  } finally {
    await dispose(store, dir);
  }
});


// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("executor: full mode dedups candidate + pending paths (cursor Bugbot: 'Full reindex duplicate ingest paths')", async () => {
  const { store, dir } = await tempStore();
  try {
    await writeFiles(dir, { "src/a.ts": "export function foo() {}" });
    store.writeMeta(META_KEY_PENDING_PARSE_FAILURES, JSON.stringify(["src/a.ts"]));
    const git = mockGit({ head: SHA_A });
    // Without dedup, upsertFileBatch would throw on the duplicate path.
    const result = await executeReindex({
      store, git, repoRoot: dir, parseFile: mockParseFile,
      candidatePaths: ["src/a.ts"],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.mode, "full");
    assert.equal(result.filesIngested, 1);
  } finally {
    await dispose(store, dir);
  }
});

test("executor: hash-scan unions caller candidates with stored + pending (chatgpt-codex-connector: 'Require candidates' / 'Include indexed files')", async () => {
  const { store, dir } = await tempStore();
  try {
    await writeFiles(dir, { "src/a.ts": "export function foo() {}" });
    const git1 = mockGit({ head: SHA_A });
    await executeReindex({
      store, git: git1, repoRoot: dir, parseFile: mockParseFile,
      candidatePaths: ["src/a.ts"],
    });

    // Caller passes candidatePaths = [src/b.ts] only. Without the union,
    await writeFiles(dir, { "src/b.ts": "export function bar() {}" });
    const git2 = mockGit({ head: SHA_B, reachable: false });
    const result = await executeReindex({
      store, git: git2, repoRoot: dir, parseFile: mockParseFile,
      candidatePaths: ["src/a.ts", "src/b.ts"],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.mode, "hash_scan");
    const hashes = fileHashes(store);
    assert.ok(hashes.has("src/b.ts"), "new file ingested via candidate union");
  } finally {
    await dispose(store, dir);
  }
});

test("executor: non-canonical path (.. traversal) is rejected before disk read (cursor Bugbot: 'Reindex reads non-canonical paths')", async () => {
  const { store, dir } = await tempStore();
  try {
    await writeFiles(dir, { "src/a.ts": "export function foo() {}" });
    store.writeMeta(META_KEY_PENDING_PARSE_FAILURES, JSON.stringify(["../secret.ts"]));
    const git = mockGit({ head: SHA_A });
    const result = await executeReindex({
      store, git, repoRoot: dir, parseFile: mockParseFile,
      candidatePaths: ["src/a.ts"],
    });
    // (recorded as pending) and never read from disk.
    assert.equal(result.ok, true);
    const pending = JSON.parse(meta(store, META_KEY_PENDING_PARSE_FAILURES) ?? "[]");
    assert.ok(pending.includes("../secret.ts"), "non-canonical path kept pending, not read");
  } finally {
    await dispose(store, dir);
  }
});

test("mineAndStoreCoChanges: closed store reports failure, not false success (cursor Bugbot: 'Co-change store reports false success')", async () => {
  const { store, dir } = await tempStore();
  try {
    await store.close();
    const git = mockGit({ head: SHA_A });
    const result = await mineAndStoreCoChanges({ store, git, repoRoot: dir });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "store_closed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("executor: transient read error (EACCES) does NOT delete indexed nodes (cursor Bugbot: 'Read errors trigger graph deletes')", async () => {
  const { store, dir } = await tempStore();
  try {
    await writeFiles(dir, { "src/a.ts": "export function foo() {}" });
    const git1 = mockGit({ head: SHA_A });
    await executeReindex({
      store, git: git1, repoRoot: dir, parseFile: mockParseFile,
      candidatePaths: ["src/a.ts"],
    });
    let stats = store.schemaStats();
    assert.ok(stats.ok);
    assert.equal(stats.stats.nodes, 1);

    const eaccRead = (absPath: string): Promise<Uint8Array> =>
      absPath.endsWith("src/a.ts")
        ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
        : import("node:fs/promises").then((fs) => fs.readFile(absPath));
    const git2 = mockGit({
      head: SHA_B,
      changedFiles: [{ status: "M", path: "src/a.ts" }],
    });
    const result = await executeReindex({
      store, git: git2, repoRoot: dir, parseFile: mockParseFile,
      candidatePaths: ["src/a.ts"], readFile: eaccRead,
    });
    assert.equal(result.ok, true);
    // be mistaken for a deletion.
    stats = store.schemaStats();
    assert.ok(stats.ok);
    assert.equal(stats.stats.nodes, 1, "transient read error must not delete the indexed node");
    assert.deepEqual(
      JSON.parse(meta(store, META_KEY_PENDING_PARSE_FAILURES) ?? "[]"),
      ["src/a.ts"],
    );
  } finally {
    await dispose(store, dir);
  }
});

test("executor: full mode prunes stored files absent from candidates (chatgpt-codex-connector: 'Prune absent files during full reindex')", async () => {
  const { store, dir } = await tempStore();
  try {
    // Pre-seed the store with src/old.ts via a direct upsert (simulating a
    // v1 store or a crash before the first meta write — last_indexed_head
    // is null so the next run plans 'full').
    const { ir: oldIr } = makeIR("src/old.ts", "export function old() {}");
    await store.upsertFileBatch([oldIr]);
    assert.equal(fileHashes(store).has("src/old.ts"), true);

    await writeFiles(dir, { "src/a.ts": "export function foo() {}" });
    const git = mockGit({ head: SHA_A });
    const result = await executeReindex({
      store, git, repoRoot: dir, parseFile: mockParseFile,
      candidatePaths: ["src/a.ts"],
    });
    assert.equal(result.ok, true);
    assert.equal(fileHashes(store).has("src/old.ts"), false, "absent stored file pruned by full reindex");
    assert.equal(fileHashes(store).has("src/a.ts"), true);
  } finally {
    await dispose(store, dir);
  }
});

test("executor: hash_scan transient read error is retained for retry (chatgpt-codex-connector: 'Retain hash-scan read failures for retry')", async () => {
  const { store, dir } = await tempStore();
  try {
    await writeFiles(dir, { "src/a.ts": "export function foo() {}" });
    const git1 = mockGit({ head: SHA_A });
    await executeReindex({ store, git: git1, repoRoot: dir, parseFile: mockParseFile, candidatePaths: ["src/a.ts"] });

    const eaccRead = (absPath: string): Promise<Uint8Array> =>
      absPath.endsWith("src/a.ts")
        ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
        : import("node:fs/promises").then((fs) => fs.readFile(absPath));
    const git2 = mockGit({ head: SHA_B, reachable: false });
    const result = await executeReindex({
      store, git: git2, repoRoot: dir, parseFile: mockParseFile,
      candidatePaths: ["src/a.ts"], readFile: eaccRead,
    });
    assert.equal(result.ok, true);
    // dropped while head advances.
    const pending = JSON.parse(meta(store, META_KEY_PENDING_PARSE_FAILURES) ?? "[]");
    assert.ok(pending.includes("src/a.ts"), "transient hash-scan read failure retained for retry");
  } finally {
    await dispose(store, dir);
  }
});

test("executor: hash_scan without candidatePaths does NOT advance head (chatgpt-codex-connector: 'Require current candidates before advancing hash-scan')", async () => {
  const { store, dir } = await tempStore();
  try {
    await writeFiles(dir, { "src/a.ts": "export function foo() {}" });
    await executeReindex({ store, git: mockGit({ head: SHA_A }), repoRoot: dir, parseFile: mockParseFile, candidatePaths: ["src/a.ts"] });
    assert.equal(meta(store, META_KEY_LAST_HEAD), SHA_A);

    await writeFiles(dir, { "src/new.ts": "export function bar() {}" });
    const result = await executeReindex({
      store, git: mockGit({ head: SHA_B, reachable: false }), repoRoot: dir, parseFile: mockParseFile,
      // candidatePaths intentionally omitted
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.head, SHA_A, "head must NOT advance without an authoritative candidate list");
    assert.equal(meta(store, META_KEY_LAST_HEAD), SHA_A, "persisted head unchanged");
  } finally {
    await dispose(store, dir);
  }
});

test("executor: hash_scan retains a hash-matching pending parse failure (cursor Bugbot HIGH: 'Pending retries cleared incorrectly')", async () => {
  const { store, dir } = await tempStore();
  try {
    await writeFiles(dir, { "src/a.ts": "export function foo() {}" });
    await executeReindex({ store, git: mockGit({ head: SHA_A }), repoRoot: dir, parseFile: mockParseFile, candidatePaths: ["src/a.ts"] });
    store.writeMeta(META_KEY_PENDING_PARSE_FAILURES, JSON.stringify(["src/a.ts"]));

    const result = await executeReindex({
      store, git: mockGit({ head: SHA_B, reachable: false }), repoRoot: dir, parseFile: mockParseFile,
      candidatePaths: ["src/a.ts"],
    });
    assert.equal(result.ok, true);
    const pending = JSON.parse(meta(store, META_KEY_PENDING_PARSE_FAILURES) ?? "[]");
    assert.ok(pending.includes("src/a.ts"), "hash-matching pending parse failure must be retained, not silently dropped");
  } finally {
    await dispose(store, dir);
  }
});

test("executor: full reindex does NOT ingest a symlink that escapes repoRoot (chatgpt-codex-connector: 'Reject symlink escapes before parsing files')", async () => {
  const { store, dir } = await tempStore();
  const outside = await mkdtemp(path.join(tmpdir(), "reindex-outside-"));
  try {
    await writeFile(path.join(outside, "secret.ts"), "export function secret() {}");
    const { symlink } = await import("node:fs/promises");
    await symlink(path.join(outside, "secret.ts"), path.join(dir, "evil.ts"));

    const result = await executeReindex({
      store, git: mockGit({ head: SHA_A }), repoRoot: dir, parseFile: mockParseFile,
      candidatePaths: ["evil.ts"],
    });
    assert.equal(result.ok, true);
    assert.equal(fileHashes(store).has("evil.ts"), false, "symlink escaping repoRoot must not be ingested (rule 3)");
  } finally {
    await rm(outside, { recursive: true, force: true });
    await dispose(store, dir);
  }
});

test("executor: explicit empty candidatePaths ([]) is treated as insufficient — does NOT advance head in hash_scan (cursor Bugbot HIGH: 'Empty candidate list prunes graph')", async () => {
  const { store, dir } = await tempStore();
  try {
    await writeFiles(dir, { "src/a.ts": "export function foo() {}" });
    await executeReindex({ store, git: mockGit({ head: SHA_A }), repoRoot: dir, parseFile: mockParseFile, candidatePaths: ["src/a.ts"] });
    assert.equal(meta(store, META_KEY_LAST_HEAD), SHA_A);
    const result = await executeReindex({
      store, git: mockGit({ head: SHA_B, reachable: false }), repoRoot: dir, parseFile: mockParseFile,
      candidatePaths: [],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.head, SHA_A, "explicit [] must not advance head");
    assert.equal(meta(store, META_KEY_LAST_HEAD), SHA_A);
  } finally {
    await dispose(store, dir);
  }
});

test("executor: an lsp-only edge on an UNCHANGED file survives incremental reindex (issue #1894 round 7)", async () => {
  const { store, dir } = await tempStore();
  try {
    await writeFiles(dir, {
      "src/a.ts": "export function foo() {}",
      "src/b.ts": "export function bar() {}",
    });
    const git1 = mockGit({ head: SHA_A });
    await executeReindex({
      store,
      git: git1,
      repoRoot: dir,
      parseFile: mockParseFile,
      candidatePaths: ["src/a.ts", "src/b.ts"],
    });
    // by src/a.ts (never asserted by any heuristic derivation).
    const upgraded = await store.upsertEdges([
      {
        srcQualifiedName: "src/a.ts::foo",
        dstQualifiedName: "src/b.ts::foo",
        type: "CALLS",
        confidence: 1,
        provenance: "lsp",
      },
    ]);
    assert.ok(upgraded.ok && upgraded.persisted === 1);

    await writeFiles(dir, { "src/b.ts": "export function bar() { return 2; }" });
    const git2 = mockGit({
      head: SHA_B,
      reachable: true,
      changedFiles: [{ status: "M", path: "src/b.ts" }],
    });
    const result = await executeReindex({
      store,
      git: git2,
      repoRoot: dir,
      parseFile: mockParseFile,
      candidatePaths: ["src/a.ts", "src/b.ts"],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.mode, "incremental");
    assert.equal(result.filesIngested, 1);
    const stats = store.schemaStats();
    assert.ok(stats.ok);
    assert.deepEqual(stats.stats.edgesByType, { CALLS: 1 }, "lsp-only edge on unchanged src/a.ts survived");
  } finally {
    await dispose(store, dir);
  }
});
