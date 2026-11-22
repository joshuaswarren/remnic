import assert from "node:assert/strict";
import test from "node:test";

import {
  DELTA_SUBCOMMANDS,
  formatDeltaSubcommands,
  handleCodingDelta,
  isDeltaSubcommand,
  type DeltaSurfaceContext,
  type DeltaSurfaceStorage,
} from "./session-delta-surfaces.js";
import { isCodingKnowledgeFeatureEnabled, isCodingKnowledgeFeatureVisible } from "./coding-knowledge-config.js";
import type {
  CodingKnowledgeConfig,
  CodingContext,
} from "../types.js";
import type { SessionDeltaGitInvoker } from "./session-delta.js";

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
  assert.equal(isCodingKnowledgeFeatureEnabled(DEFAULT_CONFIG, "sessionDelta", CODING_CONTEXT), true);
});

test("gate: surface disabled when master gate off", () => {
  const config: CodingKnowledgeConfig = { ...DEFAULT_CONFIG, enabled: false };
  assert.equal(isCodingKnowledgeFeatureEnabled(config, "sessionDelta", CODING_CONTEXT), false);
});

test("gate: surface disabled when sessionDelta off", () => {
  const config: CodingKnowledgeConfig = { ...DEFAULT_CONFIG, sessionDelta: false };
  assert.equal(isCodingKnowledgeFeatureEnabled(config, "sessionDelta", CODING_CONTEXT), false);
});

test("gate: surface disabled when no coding context", () => {
  assert.equal(isCodingKnowledgeFeatureEnabled(DEFAULT_CONFIG, "sessionDelta", null), false);
  assert.equal(isCodingKnowledgeFeatureEnabled(DEFAULT_CONFIG, "sessionDelta", undefined), false);
});

test("visibility gate: config-only check mirrors full gate minus context", () => {
  assert.equal(isCodingKnowledgeFeatureVisible(DEFAULT_CONFIG, "sessionDelta"), true);
  assert.equal(isCodingKnowledgeFeatureVisible({ ...DEFAULT_CONFIG, enabled: false }, "sessionDelta"), false);
  assert.equal(isCodingKnowledgeFeatureVisible({ ...DEFAULT_CONFIG, sessionDelta: false }, "sessionDelta"), false);
});

// ──────────────────────────────────────────────────────────────────────────
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
    const invoker1 = makeInvoker([
      { args: ["rev-parse", "HEAD"], stdout: "stable\n" },
    ]);
    const ctx1 = makeContext({ resolveStorage: async () => storage, gitInvoker: invoker1 });
    await handleCodingDelta({ subcommand: "get", sessionKey: "s1" }, ctx1);

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
    const invoker1 = makeInvoker([
      { args: ["rev-parse", "HEAD"], stdout: "headA\n" },
    ]);
    await handleCodingDelta(
      { subcommand: "get", sessionKey: "s1" },
      makeContext({ resolveStorage: async () => storage, gitInvoker: invoker1 }),
    );

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
    const invoker1 = makeInvoker([
      { args: ["rev-parse", "HEAD"], stdout: "headA\n" },
    ]);
    await handleCodingDelta(
      { subcommand: "get", sessionKey: "s1" },
      makeContext({ resolveStorage: async () => storage, gitInvoker: invoker1 }),
    );

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

    const sep = "\x1f";
    const commitBlocks = Array.from({ length: 25 }, (_, i) => [
      `sha${i}${sep}fix ${i}`,
      "",
      `src/file${i}.ts`,
      "",
    ].join("\n"));
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
    assert.equal(result.delta.commits.length, 20, "commits slice must be capped to MAX_DELTA_COMMITS");
    assert.equal(result.delta.touchedFiles.length, 50, "touchedFiles slice must be capped to MAX_DELTA_FILES");
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
// ──────────────────────────────────────────────────────────────────────────

test("handler/get: read-only caller (canAdvanceState=false) does NOT advance the state marker (issue #1630 fix 2)", async () => {
  const { storage, cleanup } = await makeTempStorage();
  try {
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
    const statePath = sessionDeltaStatePath(storage.memoryDir, storage.namespace);
    const seeded = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(seeded.head, "headA");

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
    if (!("ok" in result) || !result.ok || result.kind !== "changed") {
      assert.fail(`expected changed, got ${JSON.stringify(result)}`);
      return;
    }
    assert.equal(result.delta.commits.length, 1);
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
  const { storage, cleanup } = await makeTempStorage();
  try {
    const invoker = makeInvoker([
      { args: ["rev-parse", "HEAD"], stdout: "headDefault\n" },
    ]);
    await handleCodingDelta(
      { subcommand: "get", sessionKey: "s1" },
      makeContext({
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
