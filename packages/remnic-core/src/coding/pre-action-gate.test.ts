import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import {
  readCausalTrajectoryRecordsStrict,
  recordCausalTrajectory,
  type ActionStrategyId,
  validateCausalTrajectoryRecord,
} from "../causal-trajectory.js";
import {
  normalizeActionIntent,
  PreActionFailureGate,
  PRE_ACTION_FINGERPRINT_VERSION,
  PRE_ACTION_WARNING_VERSION,
  sanitizePayloadString,
} from "./pre-action-gate.js";
import type { CodingContext } from "../types.js";

const codingContext: CodingContext = {
  projectId: "proj-test",
  branch: "main",
  rootPath: "/work/project",
  defaultBranch: null,
};

function fingerprint(
  intent: Parameters<typeof normalizeActionIntent>[0],
  strategyId: ActionStrategyId,
  context: CodingContext = codingContext,
): string {
  return normalizeActionIntent(intent, strategyId, context).fingerprint;
}

function request(memoryDir: string, overrides: Record<string, unknown> = {}) {
  return {
    memoryDir,
    sessionKey: "session-test",
    strategyId: "RUN_CHECK" as const,
    codingContext,
    intent: { kind: "command" as const, command: "pnpm test" },
    ...overrides,
  };
}

test("normalizes typed command slots while preserving case-significant literals", () => {
  const normalized = normalizeActionIntent(
    {
      kind: "command",
      command: "Tool",
      args: [
        "42",
        "550e8400-e29b-41d4-a716-446655440000",
        "deadbeef",
        "2026-07-29T12:00:00Z",
        "250ms",
        "CaseSensitive",
        "/work/project/tmp/result.tmp",
      ],
    },
    "RUN_CHECK",
    codingContext,
  );
  assert.match(normalized.fingerprint, /^v1:sha256:[a-f0-9]{64}$/);
  const lowerCaseLiteral = normalizeActionIntent(
    { kind: "command", command: "Tool", args: ["casesensitive"] },
    "RUN_CHECK",
    codingContext,
  );
  assert.notEqual(normalized.fingerprint, lowerCaseLiteral.fingerprint);

  const secretA = normalizeActionIntent(
    { kind: "command", command: "Tool", args: ["--token", "alpha"] },
    "RUN_CHECK",
    codingContext,
  );
  const secretB = normalizeActionIntent(
    { kind: "command", command: "Tool", args: ["--token", "beta"] },
    "RUN_CHECK",
    codingContext,
  );
  assert.equal(secretA.fingerprint, secretB.fingerprint);

  const inlineA = normalizeActionIntent(
    { kind: "command", command: "Tool", args: ["--password=alpha"] },
    "RUN_CHECK",
    codingContext,
  );
  const inlineB = normalizeActionIntent(
    { kind: "command", command: "Tool", args: ["--password=beta"] },
    "RUN_CHECK",
    codingContext,
  );
  assert.equal(inlineA.fingerprint, inlineB.fingerprint);

  const absoluteTemp = normalizeActionIntent(
    { kind: "command", command: "Tool", args: ["/work/project/tmp/result.tmp"] },
    "RUN_CHECK",
    codingContext,
  );
  const relativeTemp = normalizeActionIntent(
    { kind: "command", command: "Tool", args: ["tmp/result.tmp"] },
    "RUN_CHECK",
    codingContext,
  );
  assert.equal(absoluteTemp.fingerprint, relativeTemp.fingerprint);

  const externalA = normalizeActionIntent(
    { kind: "command", command: "Tool", args: ["/outside/one.txt"] },
    "RUN_CHECK",
    codingContext,
  );
  const externalB = normalizeActionIntent(
    { kind: "command", command: "Tool", args: ["/another/two.txt"] },
    "RUN_CHECK",
    codingContext,
  );
  assert.equal(externalA.fingerprint, externalB.fingerprint);
});


test("normalizes contained edit paths and rejects paths outside the repo", () => {
  const absolute = normalizeActionIntent(
    { kind: "edit", filePath: "/work/project/src/config.ts", editKind: "update", symbol: "Config" },
    "CHANGE_CONFIGURATION",
    codingContext,
  );
  const relative = normalizeActionIntent(
    { kind: "edit", filePath: "src/config.ts", editKind: "update", symbol: "Config" },
    "CHANGE_CONFIGURATION",
    codingContext,
  );
  assert.equal(absolute.fingerprint, relative.fingerprint);
  assert.throws(
    () => normalizeActionIntent(
      { kind: "edit", filePath: "/work/other/secret.ts", editKind: "update" },
      "CHANGE_IMPLEMENTATION",
      codingContext,
    ),
    /contained/,
  );
});

test("excludes secrets, raw home paths, and root paths from fingerprints", () => {
  assert.equal(sanitizePayloadString("sk-1234567890abcdef"), "<secret>");
  const normalized = normalizeActionIntent(
    { kind: "command", command: "curl", args: ["sk-1234567890abcdef", "/work/project/tmp/a.tmp"] },
    "INSPECT_STATE",
    codingContext,
  );
  assert.doesNotMatch(normalized.fingerprint, /secret|work|project|tmp/);
});

test("strict loader distinguishes absent, empty, and unreadable stores", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-strict-"));
  assert.equal((await readCausalTrajectoryRecordsStrict({ memoryDir })).status, "absent");
  await mkdir(path.join(memoryDir, "state", "causal-trajectories", "trajectories"), { recursive: true });
  assert.equal((await readCausalTrajectoryRecordsStrict({ memoryDir })).status, "empty");
  const badStore = path.join(memoryDir, "bad-store");
  await writeFile(badStore, "not a directory");
  await assert.rejects(
    () => readCausalTrajectoryRecordsStrict({ memoryDir, causalTrajectoryStoreDir: badStore }),
    /not a directory|Unreadable|Failed to read/,
  );
});

test("strict loader rejects symlinked trajectory entries", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-strict-symlink-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "remnic-strict-outside-"));
  const trajectoriesDir = path.join(memoryDir, "state", "causal-trajectories", "trajectories");
  try {
    await mkdir(trajectoriesDir, { recursive: true });
    await writeFile(path.join(outsideDir, "record.json"), "{}");

    await symlink(outsideDir, path.join(trajectoriesDir, "linked-day"));
    await assert.rejects(
      () => readCausalTrajectoryRecordsStrict({ memoryDir }),
      /symbolic link/,
    );

    await rm(path.join(trajectoriesDir, "linked-day"));
    await symlink(path.join(outsideDir, "record.json"), path.join(trajectoriesDir, "linked.json"));
    await assert.rejects(
      () => readCausalTrajectoryRecordsStrict({ memoryDir }),
      /symbolic link/,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("matches only complete typed failure identity for the exact project", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-match-"));
  const actionFingerprint = fingerprint({ kind: "command", command: "pnpm test" }, "RUN_CHECK");
  await recordCausalTrajectory({
    memoryDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "typed-failure",
      recordedAt: "2026-07-29T12:00:00Z",
      sessionKey: "historical-session",
      goal: "Run checks",
      actionSummary: "Ran the focused check",
      observationSummary: "The check failed",
      outcomeKind: "failure",
      outcomeSummary: "Two assertions failed",
      followUpSummary: "Inspect the failing assertions",
      codingContext: { projectId: codingContext.projectId, branch: "old-branch" },
      actionIdentity: {
        fingerprintVersion: 1,
        fingerprint: actionFingerprint,
        strategyId: "RUN_CHECK",
      },
    },
  });
  const gate = new PreActionFailureGate({ timeoutMs: 1_000 });
  assert.equal((await gate.evaluate(request(memoryDir))).status, "MATCH_WARN");
  assert.equal((await gate.evaluate(request(memoryDir, {
    codingContext: { ...codingContext, projectId: "other-project" },
  }))).status, "NO_MATCH");
});

test("selects the newest matching failure with trajectoryId tie-break", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-match-order-"));
  const actionFingerprint = fingerprint({ kind: "command", command: "pnpm test" }, "RUN_CHECK");
  for (const trajectoryId of ["b-tie", "a-tie", "older"]) {
    await recordCausalTrajectory({
      memoryDir,
      record: {
        schemaVersion: 1,
        trajectoryId,
        recordedAt: trajectoryId === "older" ? "2026-07-28T12:00:00Z" : "2026-07-29T12:00:00Z",
        sessionKey: "old",
        goal: "Run checks",
        actionSummary: trajectoryId,
        observationSummary: "failed",
        outcomeKind: "failure",
        outcomeSummary: "failed",
        codingContext: { projectId: codingContext.projectId },
        actionIdentity: {
          fingerprintVersion: 1,
          fingerprint: actionFingerprint,
          strategyId: "RUN_CHECK",
        },
      },
    });
  }
  const result = await new PreActionFailureGate({ timeoutMs: 1_000 })
    .evaluate(request(memoryDir));
  assert.equal(result.matchedTrajectoryId, "a-tie");
});

test("ignores legacy, version-miss, strategy-miss, success, and partial records", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ignore-"));
  const actionFingerprint = fingerprint({ kind: "command", command: "pnpm test" }, "RUN_CHECK");
  const records = [
    { id: "legacy", outcomeKind: "failure" as const },
    { id: "success", outcomeKind: "success" as const, identity: true },
    { id: "partial", outcomeKind: "partial" as const, identity: true },
  ];
  for (const item of records) {
    await recordCausalTrajectory({
      memoryDir,
      record: {
        schemaVersion: 1,
        trajectoryId: item.id,
        recordedAt: "2026-07-29T12:00:00Z",
        sessionKey: "old",
        goal: "Run checks",
        actionSummary: "pnpm test",
        observationSummary: "result",
        outcomeKind: item.outcomeKind,
        outcomeSummary: "result",
        codingContext: { projectId: codingContext.projectId },
        actionIdentity: item.identity ? {
          fingerprintVersion: 1,
          fingerprint: actionFingerprint,
          strategyId: "RUN_CHECK",
        } : undefined,
      },
    });
  }
  await recordCausalTrajectory({
    memoryDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "strategy-miss",
      recordedAt: "2026-07-29T12:01:00Z",
      sessionKey: "old",
      goal: "Inspect state",
      actionSummary: "pnpm test",
      observationSummary: "failed",
      outcomeKind: "failure",
      outcomeSummary: "failed",
      codingContext: { projectId: codingContext.projectId },
      actionIdentity: {
        fingerprintVersion: 1,
        fingerprint: actionFingerprint,
        strategyId: "INSPECT_STATE",
      },
    },
  });
  const versionMissDir = path.join(
    memoryDir,
    "state",
    "causal-trajectories",
    "trajectories",
    "2026-07-29",
  );
  await mkdir(versionMissDir, { recursive: true });
  await writeFile(path.join(versionMissDir, "version-miss.json"), JSON.stringify({
    schemaVersion: 1,
    trajectoryId: "version-miss",
    recordedAt: "2026-07-29T12:02:00Z",
    sessionKey: "old",
    goal: "Run checks",
    actionSummary: "pnpm test",
    observationSummary: "failed",
    outcomeKind: "failure",
    outcomeSummary: "failed",
    codingContext: { projectId: codingContext.projectId },
    actionIdentity: {
      fingerprintVersion: 2,
      fingerprint: `v2:sha256:${"a".repeat(64)}`,
      strategyId: "RUN_CHECK",
    },
  }));
  assert.equal(
    (await new PreActionFailureGate({ timeoutMs: 1_000 }).evaluate(request(memoryDir))).status,
    "NO_MATCH",
  );
});
test("fingerprint version miss is legacy-compatible but not matchable", () => {
  const record = validateCausalTrajectoryRecord({
    schemaVersion: 1,
    trajectoryId: "version-miss",
    recordedAt: "2026-07-29T12:00:00Z",
    sessionKey: "old",
    goal: "Run checks",
    actionSummary: "pnpm test",
    observationSummary: "failed",
    outcomeKind: "failure",
    outcomeSummary: "failed",
    codingContext: { projectId: codingContext.projectId },
    actionIdentity: {
      fingerprintVersion: 2,
      fingerprint: `v2:sha256:${"a".repeat(64)}`,
      strategyId: "RUN_CHECK",
    },
  });
  assert.equal(record.actionIdentity, undefined);
});


test("invalid JSON in the store fails open", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-invalid-json-"));
  const trajectoryDir = path.join(
    memoryDir,
    "state",
    "causal-trajectories",
    "trajectories",
    "2026-07-29",
  );
  await mkdir(trajectoryDir, { recursive: true });
  await writeFile(path.join(trajectoryDir, "invalid.json"), "{not-json");
  const result = await new PreActionFailureGate({ timeoutMs: 1_000 })
    .evaluate(request(memoryDir));
  assert.equal(result.status, "ERROR_FAIL_OPEN");
});

test("cache dimensions include branch, session, revision, fingerprint version, and store", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cache-"));
  let reads = 0;
  const gate = new PreActionFailureGate({
    timeoutMs: 1_000,
    getRevision: async () => "rev-fixed",
    readStrict: async () => {
      reads += 1;
      return { status: "empty", files: [], trajectories: [], invalidTrajectories: [] };
    },
  });
  await gate.evaluate(request(memoryDir));
  await gate.evaluate(request(memoryDir));
  await gate.evaluate(request(memoryDir, { sessionKey: "other-session" }));
  await gate.evaluate(request(memoryDir, { codingContext: { ...codingContext, branch: "other" } }));
  await gate.evaluate(request(memoryDir, { causalTrajectoryStoreDir: memoryDir }));
  assert.equal(reads, 4);
});

test("revision change during scan suppresses cache publication", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-revision-"));
  let revisions = 0;
  let reads = 0;
  const gate = new PreActionFailureGate({
    timeoutMs: 1_000,
    getRevision: async () => `rev-${++revisions}`,
    readStrict: async () => {
      reads += 1;
      return { status: "empty", files: [], trajectories: [], invalidTrajectories: [] };
    },
  });
  await gate.evaluate(request(memoryDir));
  await gate.evaluate(request(memoryDir));
  assert.equal(reads, 2);
});

test("deadline aborts and suppresses late cache publication", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-deadline-"));
  const gate = new PreActionFailureGate({
    timeoutMs: 1,
    readStrict: async ({ signal }) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  const result = await gate.evaluate(request(memoryDir));
  assert.equal(result.status, "ERROR_FAIL_OPEN");
});

test("deadline returns when the trajectory reader ignores abort and never publishes its late result", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-noncooperative-deadline-"));
  const lateRead = Promise.withResolvers<{
    status: "empty";
    files: [];
    trajectories: [];
    invalidTrajectories: [];
  }>();
  let reads = 0;
  const gate = new PreActionFailureGate({
    timeoutMs: 5,
    getRevision: async () => "stable",
    readStrict: async () => {
      reads += 1;
      return reads === 1
        ? lateRead.promise
        : { status: "empty", files: [], trajectories: [], invalidTrajectories: [] };
    },
  });

  // Integration coverage for the real deadline timer; the reader never cooperates with abort.
  const result = await gate.evaluate(request(memoryDir));
  assert.equal(result.status, "ERROR_FAIL_OPEN");
  lateRead.resolve({ status: "empty", files: [], trajectories: [], invalidTrajectories: [] });
  await lateRead.promise;
  await Promise.resolve();
  assert.equal((await gate.evaluate(request(memoryDir))).status, "NO_MATCH");
  assert.equal(reads, 2);
});

test("bounded cache evicts oldest entry", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-eviction-"));
  let reads = 0;
  const gate = new PreActionFailureGate({
    timeoutMs: 1_000,
    maxCacheSize: 1,
    getRevision: async () => "rev",
    readStrict: async () => {
      reads += 1;
      return { status: "empty", files: [], trajectories: [], invalidTrajectories: [] };
    },
  });
  await gate.evaluate(request(memoryDir, { sessionKey: "a" }));
  await gate.evaluate(request(memoryDir, { sessionKey: "b" }));
  await gate.evaluate(request(memoryDir, { sessionKey: "a" }));
  assert.equal(reads, 3);
});

test("warning is fixed, versioned, bounded, and does not predict failure", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-warning-"));
  const actionFingerprint = fingerprint({ kind: "command", command: "pnpm test" }, "RUN_CHECK");
  await recordCausalTrajectory({
    memoryDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "warning-record",
      recordedAt: "2026-07-29T12:00:00Z",
      sessionKey: "old",
      goal: "Run checks",
      actionSummary: "Focused test run",
      observationSummary: "failed",
      outcomeKind: "failure",
      outcomeSummary: "Assertion mismatch",
      followUpSummary: "Inspect expected output",
      codingContext: { projectId: codingContext.projectId },
      actionIdentity: { fingerprintVersion: 1, fingerprint: actionFingerprint, strategyId: "RUN_CHECK" },
    },
  });
  const result = await new PreActionFailureGate({ timeoutMs: 1_000 }).evaluate(request(memoryDir));
  assert.match(result.advisoryText ?? "", /^\[PreActionFailureGate 1\] A similar action failed before\./);
  assert.match(result.advisoryText ?? "", /Prior act: "Focused test run"/);
  assert.match(result.advisoryText ?? "", /Failure: "Assertion mismatch"/);
  assert.match(result.advisoryText ?? "", /Next safe check: "Inspect expected output"/);
  assert.doesNotMatch(result.advisoryText ?? "", /will fail/);
});

test("missing memoryDir fails open before revision read", async () => {
  let revisionReads = 0;
  const gate = new PreActionFailureGate({
    timeoutMs: 1_000,
    getRevision: async () => { revisionReads += 1; return "rev"; },
  });
  const result = await gate.evaluate({
    sessionKey: "session",
    strategyId: "RUN_CHECK",
    codingContext,
    intent: { kind: "command", command: "pnpm test" },
  });
  assert.equal(result.status, "ERROR_FAIL_OPEN");
  assert.equal(revisionReads, 0);
});

test("public versions remain pinned", () => {
  assert.equal(PRE_ACTION_FINGERPRINT_VERSION, 1);
  assert.equal(PRE_ACTION_WARNING_VERSION, 1);
});
