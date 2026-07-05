/**
 * Tests for the session-delta pure differ + state persistence
 * (issue #1548 Track A PR 4).
 *
 * Contract under test (the issue's three-state matrix + edge cases):
 *  - first_run: no prior state → no delta AND nextState initialized.
 *    A first session must NOT claim "0 changes" (rule 34).
 *  - unchanged: prior head == current head → suppressed, not rendered.
 *  - changed: prior head is an ancestor of current → real delta with caps.
 *  - unreachable_head: prior head missing from repo (force-push/rebase) →
 *    tagged { ok:false, code:"unreachable_head" }, never a crash.
 *  - rule 27: slice(-n) guard against n === 0.
 *  - rule 25 / rule 54: state write is temp-file-then-rename; read-back round-trips.
 *  - parseLogOutput: handles multi-commit + multi-file + blank-line blocks.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildSummaryLine,
  capCommits,
  capFiles,
  computeSessionDelta,
  MAX_DELTA_COMMITS,
  MAX_DELTA_FILES,
  parseLogOutput,
  readLastSeenState,
  resolveSlice,
  sessionDeltaStatePath,
  writeLastSeenState,
  type GitCommit,
  type GitLogSlice,
  type LastSeenState,
  type SessionDeltaGitInvoker,
} from "./session-delta.js";

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function slice(head: string, commits: GitCommit[] = [], files: string[] = []): GitLogSlice {
  return { commits, touchedFiles: files, currentHead: head };
}

const PRIOR: LastSeenState = { head: "aaa111", at: "2026-06-01T10:00:00Z" };

// ──────────────────────────────────────────────────────────────────────────
// Three-state matrix
// ──────────────────────────────────────────────────────────────────────────

test("first_run: null prior state → no delta, nextState initialized", () => {
  const result = computeSessionDelta(null, slice("bbb222"));
  assert.equal(result.ok, true);
  if (!result.ok || result.kind !== "first_run") {
    assert.fail(`expected first_run, got ${JSON.stringify(result)}`);
    return;
  }
  assert.equal(result.nextState.head, "bbb222");
  assert.ok(result.nextState.at);
  // The first_run shape carries NO delta field — callers must suppress.
  assert.equal("delta" in result, false);
});

test("unchanged: prior head == current head → suppressed", () => {
  const result = computeSessionDelta(PRIOR, slice("aaa111"));
  assert.equal(result.ok, true);
  if (!result.ok || result.kind !== "unchanged") {
    assert.fail(`expected unchanged, got ${JSON.stringify(result)}`);
    return;
  }
  assert.equal(result.nextState.head, "aaa111");
  assert.equal("delta" in result, false);
});

test("changed: real delta returned with commits + summary", () => {
  const commits: GitCommit[] = [
    { sha: "bbb222", subject: "feat: add session delta" },
    { sha: "ccc333", subject: "fix: edge case" },
  ];
  const result = computeSessionDelta(
    PRIOR,
    slice("ccc333", commits, ["src/a.ts", "src/b.ts"]),
  );
  assert.equal(result.ok, true);
  if (!result.ok || result.kind !== "changed") {
    assert.fail(`expected changed, got ${JSON.stringify(result)}`);
    return;
  }
  assert.equal(result.delta.commits.length, 2);
  assert.equal(result.delta.touchedFiles.length, 2);
  assert.equal(result.nextState.head, "ccc333");
  // Summary line is deterministic and locale-stable.
  assert.match(result.delta.summaryLine, /^Since 2026-06-01: 2 commits, 2 files touched\.$/);
});

// ──────────────────────────────────────────────────────────────────────────
// Edge cases — rule 34 (tagged failures, never silent)
// ──────────────────────────────────────────────────────────────────────────

test("unreachable_head: head changed but zero commits → tagged failure", () => {
  const result = computeSessionDelta(PRIOR, slice("fff999", [], []));
  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail(`expected failure, got ${JSON.stringify(result)}`);
    return;
  }
  assert.equal(result.code, "unreachable_head");
  assert.match(result.detail, /aaa111/);
  assert.match(result.detail, /fff999/);
  // nextState still advances so the next call sees the new head.
  assert.equal(result.nextState.head, "fff999");
});

test("summary line uses singular form for 1 commit / 1 file", () => {
  const line = buildSummaryLine(1, 1, "2026-06-01T10:00:00Z");
  assert.equal(line, "Since 2026-06-01: 1 commit, 1 file touched.");
});

test("summary line falls back to raw timestamp when malformed", () => {
  const line = buildSummaryLine(3, 2, "not-a-date");
  assert.match(line, /not-a-date/);
});

// ──────────────────────────────────────────────────────────────────────────
// Caps — rule 27 (slice(-n) guard against n === 0)
// ──────────────────────────────────────────────────────────────────────────

test("capCommits: keeps the most-recent N commits", () => {
  const commits: GitCommit[] = Array.from({ length: 30 }, (_, i) => ({
    sha: `sha${i}`,
    subject: `subject ${i}`,
  }));
  const capped = capCommits(commits, MAX_DELTA_COMMITS);
  assert.equal(capped.length, MAX_DELTA_COMMITS);
  // Most-recent (tail) wins.
  assert.equal(capped[capped.length - 1]!.sha, "sha29");
});

test("capCommits: max=0 returns empty (rule 27 guard)", () => {
  const commits: GitCommit[] = [{ sha: "x", subject: "y" }];
  assert.equal(capCommits(commits, 0).length, 0);
  assert.equal(capCommits(commits, -1).length, 0);
});

test("capFiles: truncates to N entries preserving order", () => {
  const files = Array.from({ length: 60 }, (_, i) => `file${i}.ts`);
  const capped = capFiles(files, MAX_DELTA_FILES);
  assert.equal(capped.length, MAX_DELTA_FILES);
  assert.equal(capped[0], "file0.ts");
});

test("capFiles: max=0 returns empty (rule 27 guard)", () => {
  assert.equal(capFiles(["a", "b"], 0).length, 0);
});

test("computeSessionDelta caps a large delta to MAX constants", () => {
  const commits: GitCommit[] = Array.from({ length: 100 }, (_, i) => ({
    sha: `c${i}`,
    subject: `s ${i}`,
  }));
  const files = Array.from({ length: 200 }, (_, i) => `f${i}.ts`);
  const result = computeSessionDelta(PRIOR, slice("head", commits, files));
  if (!result.ok || result.kind !== "changed") {
    assert.fail(`expected changed, got ${JSON.stringify(result)}`);
    return;
  }
  assert.equal(result.delta.commits.length, MAX_DELTA_COMMITS);
  assert.equal(result.delta.touchedFiles.length, MAX_DELTA_FILES);
});

// ──────────────────────────────────────────────────────────────────────────
// State persistence — rule 25 (write after compute) + rule 54 (temp+rename)
// ──────────────────────────────────────────────────────────────────────────

test("state path: namespace sanitized into the filename", () => {
  const p = sessionDeltaStatePath("/mem", "project-abc");
  assert.equal(p, path.join("/mem", "state", "coding-knowledge", "project-abc.json"));
});

test("state path: unsafe namespace characters sanitized defensively", () => {
  const p = sessionDeltaStatePath("/mem", "../escape!!");
  // No path traversal — the '..' is collapsed.
  assert.ok(!p.includes("escape!!"));
  assert.ok(!p.includes("../"));
});

test("state path: empty namespace falls back to 'default'", () => {
  const p = sessionDeltaStatePath("/mem", "");
  assert.ok(p.endsWith("default.json"));
});

test("readLastSeenState: absent file returns null, never throws", async () => {
  const result = await readLastSeenState("/nonexistent/path/state.json");
  assert.equal(result, null);
});

test("writeLastSeenState + readLastSeenState round-trips", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "session-delta-"));
  try {
    const statePath = path.join(dir, "state.json");
    const state: LastSeenState = { head: "deadbeef", at: "2026-07-01T00:00:00Z" };
    await writeLastSeenState(statePath, state);
    const readBack = await readLastSeenState(statePath);
    assert.deepEqual(readBack, state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeLastSeenState: temp file cleaned up after rename (rule 54)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "session-delta-"));
  try {
    const statePath = path.join(dir, "state.json");
    await writeLastSeenState(statePath, { head: "abc", at: "2026-07-01T00:00:00Z" });
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    // Only state.json should remain — no leftover .tmp-* file.
    assert.deepEqual(entries, ["state.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readLastSeenState: malformed JSON returns null, never throws", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "session-delta-"));
  try {
    const statePath = path.join(dir, "state.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(statePath, "{not json", "utf8");
    const result = await readLastSeenState(statePath);
    assert.equal(result, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readLastSeenState: missing head or at returns null", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "session-delta-"));
  try {
    const statePath = path.join(dir, "state.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(statePath, JSON.stringify({ head: "abc" }), "utf8");
    const result = await readLastSeenState(statePath);
    assert.equal(result, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeLastSeenState: invalid state throws (rule 51)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "session-delta-"));
  try {
    const statePath = path.join(dir, "state.json");
    await assert.rejects(
      () => writeLastSeenState(statePath, { head: "", at: "2026-07-01T00:00:00Z" }),
      /invalid state/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Git invoker + slice resolution
// ──────────────────────────────────────────────────────────────────────────

function makeInvoker(responses: Array<{ args: string[]; stdout: string; exitCode?: number }>): SessionDeltaGitInvoker {
  return (_cwd: string, args: string[]) => {
    const match = responses.find((r) => r.args.join(" ") === args.join(" "));
    if (!match) return { stdout: "", exitCode: 1 };
    return { stdout: match.stdout, exitCode: match.exitCode ?? 0 };
  };
}

test("resolveSlice: first run (no prior head) returns empty slice", () => {
  const invoker = makeInvoker([
    { args: ["rev-parse", "HEAD"], stdout: "newhead\n" },
  ]);
  const result = resolveSlice("/repo", null, invoker);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.slice.commits.length, 0);
  assert.equal(result.slice.currentHead, "newhead");
});

test("resolveSlice: unchanged head short-circuits before the log call", () => {
  let logCalled = false;
  const invoker: SessionDeltaGitInvoker = (_cwd, args) => {
    if (args[0] === "log") logCalled = true;
    if (args[0] === "rev-parse") return { stdout: "samehead\n", exitCode: 0 };
    return { stdout: "", exitCode: 0 };
  };
  const result = resolveSlice("/repo", "samehead", invoker);
  assert.equal(result.ok, true);
  assert.equal(logCalled, false, "git log must not be called when head is unchanged");
});

test("resolveSlice: real delta with commits + files", () => {
  const sep = "\x1f";
  const logOutput = [
    `aaa${sep}feat: first`,
    "",
    "src/a.ts",
    "src/b.ts",
    "",
    `bbb${sep}fix: second`,
    "",
    "src/a.ts",
    "",
  ].join("\n");
  const invoker = makeInvoker([
    { args: ["rev-parse", "HEAD"], stdout: "bbb\n" },
    { args: ["log", "--pretty=format:%H\x1f%s", "--name-only", "aaa..bbb"], stdout: logOutput },
  ]);
  const result = resolveSlice("/repo", "aaa", invoker);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.slice.commits.length, 2);
  assert.equal(result.slice.commits[0]!.sha, "aaa");
  assert.equal(result.slice.commits[1]!.subject, "fix: second");
  // De-duplicated + sorted touched files.
  assert.deepEqual(result.slice.touchedFiles, ["src/a.ts", "src/b.ts"]);
});

test("resolveSlice: rev-parse failure → git_failed / no_head", () => {
  const invoker = makeInvoker([
    { args: ["rev-parse", "HEAD"], stdout: "", exitCode: 128 },
  ]);
  const result = resolveSlice("/repo", null, invoker);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "no_head");
});

test("resolveSlice: git log non-zero exit → empty slice (differ flags unreachable)", () => {
  const invoker = makeInvoker([
    { args: ["rev-parse", "HEAD"], stdout: "newhead\n" },
    { args: ["log", "--pretty=format:%H\x1f%s", "--name-only", "oldhead..newhead"], stdout: "", exitCode: 128 },
  ]);
  const result = resolveSlice("/repo", "oldhead", invoker);
  // Returns ok with empty slice; the differ converts this to unreachable_head.
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.slice.commits.length, 0);
  assert.equal(result.slice.currentHead, "newhead");
});

// ──────────────────────────────────────────────────────────────────────────
// parseLogOutput — direct unit test
// ──────────────────────────────────────────────────────────────────────────

test("parseLogOutput: handles blank-line-separated blocks", () => {
  const sep = "\x1f";
  const stdout = [
    `sha1${sep}subject one`,
    "",
    "file1.ts",
    "",
    `sha2${sep}subject two`,
    "",
    "file1.ts",
    "file2.ts",
  ].join("\n");
  const { commits, touchedFiles } = parseLogOutput(stdout, sep);
  assert.equal(commits.length, 2);
  assert.equal(commits[0]!.sha, "sha1");
  assert.equal(commits[1]!.subject, "subject two");
  // file1.ts deduplicated.
  assert.equal(touchedFiles.length, 2);
  assert.deepEqual(touchedFiles, ["file1.ts", "file2.ts"]);
});

test("parseLogOutput: empty input → empty results", () => {
  const { commits, touchedFiles } = parseLogOutput("", "\x1f");
  assert.equal(commits.length, 0);
  assert.equal(touchedFiles.length, 0);
});

// ──────────────────────────────────────────────────────────────────────────
// Read-back from disk proves the file shape on disk (rule: verify on disk)
// ──────────────────────────────────────────────────────────────────────────

test("writeLastSeenState writes JSON with head + at keys", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "session-delta-"));
  try {
    const statePath = path.join(dir, "state.json");
    await writeLastSeenState(statePath, { head: "abc123", at: "2026-07-01T00:00:00Z" });
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed, { head: "abc123", at: "2026-07-01T00:00:00Z" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
