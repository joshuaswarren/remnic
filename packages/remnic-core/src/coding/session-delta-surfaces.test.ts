/**
 * Surface contract tests for the session-delta handler
 * (issue #1548 Track A PR 4).
 *
 * Contract under test:
 *  - Gate predicate: enabled + sessionDelta + coding context (rule 39).
 *  - get with no prior state → first_run, state initialized.
 *  - get with prior head == current → unchanged.
 *  - get with prior head ancestor → changed with capped delta.
 *  - get with unreachable prior head → tagged failure (rule 34).
 *  - State write happens AFTER compute (rule 25); failures are logged not fatal.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DELTA_SUBCOMMANDS,
  formatDeltaSubcommands,
  handleCodingDelta,
  isDeltaSubcommand,
  isSessionDeltaSurfaceEnabled,
  isSessionDeltaSurfaceVisible,
  type DeltaSurfaceContext,
  type DeltaSurfaceStorage,
} from "./session-delta-surfaces.js";
import type {
  CodingKnowledgeConfig,
  CodingContext,
} from "../types.js";
import type { SessionDeltaGitInvoker } from "./session-delta.js";

// ──────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: CodingKnowledgeConfig = {
  enabled: true,
  decisionRecords: true,
  architectureCard: true,
  sessionDelta: true,
  architectureCardLlmSummary: false,
  structuralProvider: "none",
  structuralProviderCommand: "",
  codegraphTools: false,
  codegraphDbDir: "",
};

const CODING_CONTEXT: CodingContext = {
  projectId: "origin:deadbeef",
  branch: "main",
  rootPath: "/fake/repo",
  defaultBranch: "main",
};

function makeStorage(): DeltaSurfaceStorage {
  return { memoryDir: "/fake/mem", namespace: "project-test" };
}

function makeInvoker(responses: Array<{ args: string[]; stdout: string; exitCode?: number }>): SessionDeltaGitInvoker {
  return (_cwd: string, args: string[]) => {
    const match = responses.find((r) => r.args.join(" ") === args.join(" "));
    if (!match) return { stdout: "", exitCode: 1 };
    return { stdout: match.stdout, exitCode: match.exitCode ?? 0 };
  };
}

function makeContext(overrides: Partial<DeltaSurfaceContext> = {}): DeltaSurfaceContext {
  return {
    codingKnowledge: DEFAULT_CONFIG,
    getCodingContext: () => CODING_CONTEXT,
    resolveStorage: async () => makeStorage(),
    gitInvoker: makeInvoker([]),
    throwInputError: (msg) => {
      throw new Error(msg);
    },
    ...overrides,
  };
}

// Stub the pure module's state read/write by importing the real module and
// shimming its filesystem. The handler imports readLastSeenState / writeLastSeenState
// from ./session-delta.js, which hit the real fs. We point memoryDir at a
// temp dir per-test.
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sessionDeltaStatePath } from "./session-delta.js";

async function makeTempStorage(): Promise<{ storage: DeltaSurfaceStorage; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "delta-surface-"));
  return {
    storage: { memoryDir: dir, namespace: "project-test" },
    cleanup: async () => { await rm(dir, { recursive: true, force: true }); },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Subcommand + gate helpers
// ──────────────────────────────────────────────────────────────────────────

test("subcommands: the surface exposes only `get`", () => {
  assert.deepEqual([...DELTA_SUBCOMMANDS], ["get"]);
  assert.equal(formatDeltaSubcommands(), "get");
});

test("isDeltaSubcommand: narrows valid + rejects unknown", () => {
  assert.equal(isDeltaSubcommand("get"), true);
  assert.equal(isDeltaSubcommand("refresh"), false);
  assert.equal(isDeltaSubcommand(undefined), false);
  assert.equal(isDeltaSubcommand(123), false);
});

test("gate: surface enabled when config + sessionDelta + coding context all true", () => {
  assert.equal(isSessionDeltaSurfaceEnabled(DEFAULT_CONFIG, CODING_CONTEXT), true);
});

test("gate: surface disabled when master gate off", () => {
  const config: CodingKnowledgeConfig = { ...DEFAULT_CONFIG, enabled: false };
  assert.equal(isSessionDeltaSurfaceEnabled(config, CODING_CONTEXT), false);
});

test("gate: surface disabled when sessionDelta off", () => {
  const config: CodingKnowledgeConfig = { ...DEFAULT_CONFIG, sessionDelta: false };
  assert.equal(isSessionDeltaSurfaceEnabled(config, CODING_CONTEXT), false);
});

test("gate: surface disabled when no coding context", () => {
  assert.equal(isSessionDeltaSurfaceEnabled(DEFAULT_CONFIG, null), false);
  assert.equal(isSessionDeltaSurfaceEnabled(DEFAULT_CONFIG, undefined), false);
});

test("visibility gate: config-only check mirrors full gate minus context", () => {
  assert.equal(isSessionDeltaSurfaceVisible(DEFAULT_CONFIG), true);
  assert.equal(isSessionDeltaSurfaceVisible({ ...DEFAULT_CONFIG, enabled: false }), false);
  assert.equal(isSessionDeltaSurfaceVisible({ ...DEFAULT_CONFIG, sessionDelta: false }), false);
});

// ──────────────────────────────────────────────────────────────────────────
// Handler — gate enforcement
// ──────────────────────────────────────────────────────────────────────────

test("handler: throws when gate fails (no coding context)", async () => {
  const ctx = makeContext({ getCodingContext: () => null });
  await assert.rejects(
    () => handleCodingDelta({ subcommand: "get", sessionKey: "s1" }, ctx),
    /coding_delta requires/,
  );
});

test("handler: throws when gate fails (master gate off)", async () => {
  const ctx = makeContext({
    codingKnowledge: { ...DEFAULT_CONFIG, enabled: false },
  });
  await assert.rejects(
    () => handleCodingDelta({ subcommand: "get", sessionKey: "s1" }, ctx),
    /coding_delta requires/,
  );
});

test("handler: throws when gate fails (sessionDelta off)", async () => {
  const ctx = makeContext({
    codingKnowledge: { ...DEFAULT_CONFIG, sessionDelta: false },
  });
  await assert.rejects(
    () => handleCodingDelta({ subcommand: "get", sessionKey: "s1" }, ctx),
    /coding_delta requires/,
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Handler — three-state matrix via the surface
// ──────────────────────────────────────────────────────────────────────────

test("handler/get: first run → first_run, nextState initialized", async () => {
  const { storage, cleanup } = await makeTempStorage();
  try {
    const invoker = makeInvoker([
      { args: ["rev-parse", "HEAD"], stdout: "newhead\n" },
    ]);
    const ctx = makeContext({
      resolveStorage: async () => storage,
      gitInvoker: invoker,
    });
    const result = await handleCodingDelta({ subcommand: "get", sessionKey: "s1" }, ctx);
    assert.equal(result.subcommand, "get");
    if (!("ok" in result) || !result.ok || result.kind !== "first_run") {
      assert.fail(`expected first_run, got ${JSON.stringify(result)}`);
      return;
    }
    assert.equal(result.nextState.head, "newhead");
    assert.ok(result.nextState.at);
  } finally {
    await cleanup();
  }
});

test("handler/get: unchanged head → suppressed", async () => {
  const { storage, cleanup } = await makeTempStorage();
  try {
    // Pre-seed the state file by running once.
    const invoker1 = makeInvoker([
      { args: ["rev-parse", "HEAD"], stdout: "stable\n" },
    ]);
    const ctx1 = makeContext({ resolveStorage: async () => storage, gitInvoker: invoker1 });
    await handleCodingDelta({ subcommand: "get", sessionKey: "s1" }, ctx1);

    // Second call with the same head.
    const invoker2 = makeInvoker([
      { args: ["rev-parse", "HEAD"], stdout: "stable\n" },
    ]);
    const ctx2 = makeContext({ resolveStorage: async () => storage, gitInvoker: invoker2 });
    const result = await handleCodingDelta({ subcommand: "get", sessionKey: "s1" }, ctx2);
    if (!("ok" in result) || !result.ok || result.kind !== "unchanged") {
      assert.fail(`expected unchanged, got ${JSON.stringify(result)}`);
      return;
    }
  } finally {
    await cleanup();
  }
});

test("handler/get: changed head → real delta", async () => {
  const { storage, cleanup } = await makeTempStorage();
  try {
    // Seed: first run on headA.
    const invoker1 = makeInvoker([
      { args: ["rev-parse", "HEAD"], stdout: "headA\n" },
    ]);
    await handleCodingDelta(
      { subcommand: "get", sessionKey: "s1" },
      makeContext({ resolveStorage: async () => storage, gitInvoker: invoker1 }),
    );

    // Now head moved to headB with two commits.
    const sep = "\x1f";
    const log = [
      `sha1${sep}feat: a`,
      "",
      "src/a.ts",
      "",
      `sha2${sep}fix: b`,
      "",
      "src/b.ts",
      "",
    ].join("\n");
    const invoker2 = makeInvoker([
      { args: ["rev-parse", "HEAD"], stdout: "headB\n" },
      { args: ["log", "--reverse", "--pretty=format:%H\x1f%s", "--name-only", "headA..headB"], stdout: log },
    ]);
    const result = await handleCodingDelta(
      { subcommand: "get", sessionKey: "s1" },
      makeContext({ resolveStorage: async () => storage, gitInvoker: invoker2 }),
    );
    if (!("ok" in result) || !result.ok || result.kind !== "changed") {
      assert.fail(`expected changed, got ${JSON.stringify(result)}`);
      return;
    }
    assert.equal(result.delta.commits.length, 2);
    assert.equal(result.delta.touchedFiles.length, 2);
    assert.match(result.delta.summaryLine, /2 commits, 2 files touched/);
  } finally {
    await cleanup();
  }
});

test("handler/get: unreachable prior head → tagged failure, state advances", async () => {
  const { storage, cleanup } = await makeTempStorage();
  try {
    // Seed headA.
    const invoker1 = makeInvoker([
      { args: ["rev-parse", "HEAD"], stdout: "headA\n" },
    ]);
    await handleCodingDelta(
      { subcommand: "get", sessionKey: "s1" },
      makeContext({ resolveStorage: async () => storage, gitInvoker: invoker1 }),
    );

    // Now head is headB but `git log headA..headB` fails (force-push).
    const invoker2 = makeInvoker([
      { args: ["rev-parse", "HEAD"], stdout: "headB\n" },
      { args: ["log", "--reverse", "--pretty=format:%H\x1f%s", "--name-only", "headA..headB"], stdout: "", exitCode: 128 },
    ]);
    const result = await handleCodingDelta(
      { subcommand: "get", sessionKey: "s1" },
      makeContext({ resolveStorage: async () => storage, gitInvoker: invoker2 }),
    );
    if (!("ok" in result) || result.ok || result.code !== "unreachable_head") {
      assert.fail(`expected unreachable_head, got ${JSON.stringify(result)}`);
      return;
    }
    // nextState advanced so the NEXT call sees headB as the baseline.
    assert.equal(result.nextState?.head, "headB");
  } finally {
    await cleanup();
  }
});

test("handler/get: git rev-parse failure → git_failed, no state advance", async () => {
  const { storage, cleanup } = await makeTempStorage();
  try {
    const invoker = makeInvoker([
      { args: ["rev-parse", "HEAD"], stdout: "", exitCode: 128 },
    ]);
    const result = await handleCodingDelta(
      { subcommand: "get", sessionKey: "s1" },
      makeContext({ resolveStorage: async () => storage, gitInvoker: invoker }),
    );
    if (!("ok" in result) || result.ok || result.code !== "git_failed") {
      assert.fail(`expected git_failed, got ${JSON.stringify(result)}`);
      return;
    }
    // No nextState when the head itself was unreadable.
    assert.equal(result.nextState, undefined);
  } finally {
    await cleanup();
  }
});

test("handler/get: transient git log failure (exit 127) → git_failed, state NOT advanced", async () => {
  const { storage, cleanup } = await makeTempStorage();
  try {
    // Seed headA.
    const invoker1 = makeInvoker([
      { args: ["rev-parse", "HEAD"], stdout: "headA\n" },
    ]);
    await handleCodingDelta(
      { subcommand: "get", sessionKey: "s1" },
      makeContext({ resolveStorage: async () => storage, gitInvoker: invoker1 }),
    );

    // Head is headB but git log times out (exit 127 = spawn/timeout).
    const invoker2 = makeInvoker([
      { args: ["rev-parse", "HEAD"], stdout: "headB\n" },
      { args: ["log", "--reverse", "--pretty=format:%H\x1f%s", "--name-only", "headA..headB"], stdout: "", exitCode: 127 },
    ]);
    const result = await handleCodingDelta(
      { subcommand: "get", sessionKey: "s1" },
      makeContext({ resolveStorage: async () => storage, gitInvoker: invoker2 }),
    );
    if (!("ok" in result) || result.ok || result.code !== "git_failed") {
      assert.fail(`expected git_failed, got ${JSON.stringify(result)}`);
      return;
    }
    // State marker must NOT advance — headA preserved for retry on next call.
    // Read the state file back to verify.
    const { readFile } = await import("node:fs/promises");
    const { sessionDeltaStatePath } = await import("./session-delta.js");
    const raw = await readFile(
      sessionDeltaStatePath(storage.memoryDir, storage.namespace),
      "utf8",
    );
    const persisted = JSON.parse(raw);
    assert.equal(persisted.head, "headA", "transient failure must not advance the state marker");
  } finally {
    await cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Rule 25 — state write happens AFTER compute
// ──────────────────────────────────────────────────────────────────────────

test("handler/get: state file is created after a successful first_run", async () => {
  const { storage, cleanup } = await makeTempStorage();
  try {
    const invoker = makeInvoker([
      { args: ["rev-parse", "HEAD"], stdout: "head1\n" },
    ]);
    await handleCodingDelta(
      { subcommand: "get", sessionKey: "s1" },
      makeContext({ resolveStorage: async () => storage, gitInvoker: invoker }),
    );
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(
      // The handler uses sessionDeltaStatePath(memoryDir, namespace).
      // We import and call the same helper for parity.
      (await import("./session-delta.js")).sessionDeltaStatePath(storage.memoryDir, storage.namespace),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    assert.equal(parsed.head, "head1");
    assert.ok(parsed.at);
  } finally {
    await cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Issue #1630 fix 1 — uncapped totals surface in the changed response
// ──────────────────────────────────────────────────────────────────────────

test("handler/get: changed response surfaces uncapped totals alongside capped slices (issue #1630 fix 1)", async () => {
  const { storage, cleanup } = await makeTempStorage();
  try {
    // Seed: first run on headA.
    const invoker1 = makeInvoker([
      { args: ["rev-parse", "HEAD"], stdout: "headA\n" },
    ]);
    await handleCodingDelta(
      { subcommand: "get", sessionKey: "s1" },
      makeContext({ resolveStorage: async () => storage, gitInvoker: invoker1 }),
    );

    // Now head moved to headB with 25 commits / 60 files — both exceed the
    // caps (MAX_DELTA_COMMITS=20, MAX_DELTA_FILES=50).
    const sep = "\x1f";
    const commitBlocks = Array.from({ length: 25 }, (_, i) => [
      `sha${i}${sep}fix ${i}`,
      "",
      `src/file${i}.ts`,
      "",
    ].join("\n"));
    // Add 35 more distinct files so the total crosses the file cap.
    const extraFiles = Array.from({ length: 35 }, (_, i) => `extra${i}.ts`);
    const lastBlock = [
      `shaExtra${sep}extra`,
      "",
      ...extraFiles,
      "",
    ].join("\n");
    const log = [...commitBlocks, lastBlock].join("\n");
    const invoker2 = makeInvoker([
      { args: ["rev-parse", "HEAD"], stdout: "headB\n" },
      { args: ["log", "--reverse", "--pretty=format:%H\x1f%s", "--name-only", "headA..headB"], stdout: log },
    ]);
    const result = await handleCodingDelta(
      { subcommand: "get", sessionKey: "s1" },
      makeContext({ resolveStorage: async () => storage, gitInvoker: invoker2 }),
    );
    if (!("ok" in result) || !result.ok || result.kind !== "changed") {
      assert.fail(`expected changed, got ${JSON.stringify(result)}`);
      return;
    }
    // Capped display slices.
    assert.equal(result.delta.commits.length, 20, "commits slice must be capped to MAX_DELTA_COMMITS");
    assert.equal(result.delta.touchedFiles.length, 50, "touchedFiles slice must be capped to MAX_DELTA_FILES");
    // Uncapped totals — the TRUE delta size, NOT the capped length.
    assert.equal(result.delta.totalCommits, 26, "totalCommits must report the uncapped commit count");
    assert.ok(
      result.delta.totalTouchedFiles > 50,
      `totalTouchedFiles must report the uncapped file count (got ${result.delta.totalTouchedFiles})`,
    );
  } finally {
    await cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Issue #1630 fix 2 — read-only callers do NOT advance the state marker
// ──────────────────────────────────────────────────────────────────────────

test("handler/get: read-only caller (canAdvanceState=false) does NOT advance the state marker (issue #1630 fix 2)", async () => {
  const { storage, cleanup } = await makeTempStorage();
  try {
    // Seed headA with a WRITE-capable caller (default canAdvanceState=true).
    const invoker1 = makeInvoker([
      { args: ["rev-parse", "HEAD"], stdout: "headA\n" },
    ]);
    await handleCodingDelta(
      { subcommand: "get", sessionKey: "s1" },
      makeContext({
        resolveStorage: async () => ({ ...storage, canAdvanceState: true }),
        gitInvoker: invoker1,
      }),
    );
    // Confirm the marker landed at headA.
    const statePath = sessionDeltaStatePath(storage.memoryDir, storage.namespace);
    const seeded = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(seeded.head, "headA");

    // A READ-ONLY caller (canAdvanceState=false) on headB. The delta is
    // computed and returned, but the marker MUST NOT advance.
    const sep = "\x1f";
    const log = [
      `shaRO${sep}read only commit`,
      "",
      "src/ro.ts",
      "",
    ].join("\n");
    const invoker2 = makeInvoker([
      { args: ["rev-parse", "HEAD"], stdout: "headB\n" },
      { args: ["log", "--reverse", "--pretty=format:%H\x1f%s", "--name-only", "headA..headB"], stdout: log },
    ]);
    const result = await handleCodingDelta(
      { subcommand: "get", sessionKey: "s1" },
      makeContext({
        resolveStorage: async () => ({ ...storage, canAdvanceState: false }),
        gitInvoker: invoker2,
      }),
    );
    // The delta is still computed and returned — read-only callers see the data.
    if (!("ok" in result) || !result.ok || result.kind !== "changed") {
      assert.fail(`expected changed, got ${JSON.stringify(result)}`);
      return;
    }
    assert.equal(result.delta.commits.length, 1);
    // But the persisted marker stayed at headA — read-only did not advance it.
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(persisted.head, "headA", "read-only caller must NOT advance the state marker");
  } finally {
    await cleanup();
  }
});

test("handler/get: write-capable caller (canAdvanceState=true) DOES advance the state marker (issue #1630 fix 2)", async () => {
  const { storage, cleanup } = await makeTempStorage();
  try {
    // Seed headA.
    const invoker1 = makeInvoker([
      { args: ["rev-parse", "HEAD"], stdout: "headA\n" },
    ]);
    await handleCodingDelta(
      { subcommand: "get", sessionKey: "s1" },
      makeContext({
        resolveStorage: async () => ({ ...storage, canAdvanceState: true }),
        gitInvoker: invoker1,
      }),
    );

    // A WRITE-capable caller on headB — the marker MUST advance.
    const sep = "\x1f";
    const log = [
      `shaW${sep}write commit`,
      "",
      "src/w.ts",
      "",
    ].join("\n");
    const invoker2 = makeInvoker([
      { args: ["rev-parse", "HEAD"], stdout: "headB\n" },
      { args: ["log", "--reverse", "--pretty=format:%H\x1f%s", "--name-only", "headA..headB"], stdout: log },
    ]);
    await handleCodingDelta(
      { subcommand: "get", sessionKey: "s1" },
      makeContext({
        resolveStorage: async () => ({ ...storage, canAdvanceState: true }),
        gitInvoker: invoker2,
      }),
    );
    const statePath = sessionDeltaStatePath(storage.memoryDir, storage.namespace);
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(persisted.head, "headB", "write-capable caller must advance the state marker");
  } finally {
    await cleanup();
  }
});

test("handler/get: canAdvanceState defaults to true when omitted (back-compat) (issue #1630 fix 2)", async () => {
  // Legacy callers that don't set canAdvanceState keep pre-fix behavior:
  // the marker advances. This protects the existing surface contract.
  const { storage, cleanup } = await makeTempStorage();
  try {
    const invoker = makeInvoker([
      { args: ["rev-parse", "HEAD"], stdout: "headDefault\n" },
    ]);
    await handleCodingDelta(
      { subcommand: "get", sessionKey: "s1" },
      makeContext({
        // canAdvanceState intentionally omitted.
        resolveStorage: async () => storage,
        gitInvoker: invoker,
      }),
    );
    const statePath = sessionDeltaStatePath(storage.memoryDir, storage.namespace);
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(persisted.head, "headDefault", "omitted canAdvanceState defaults to true (back-compat)");
  } finally {
    await cleanup();
  }
});
