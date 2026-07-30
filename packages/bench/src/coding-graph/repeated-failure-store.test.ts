import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RepeatedFailureRowStore,
  buildRepeatedFailureRowKey,
  writeRepeatedFailureRunMetadata,
} from "./repeated-failure-store.ts";
import { REPEATED_FAILURE_ARMS } from "./repeated-failure-types.ts";
import type {
  RepeatedFailureEpisode,
  RepeatedFailureRowIdentity,
  RepeatedFailureRunMetadata,
  RepeatedFailureTry,
} from "./repeated-failure-types.ts";

const IDENTITY: RepeatedFailureRowIdentity = {
  suiteVersion: "h6-suite-v1",
  taskId: "task/a",
  variantId: "variant:1",
  modelProfileId: "model-profile@test",
  modelProfileHash: "a".repeat(64),
  seed: 17,
  arm: "PRE_ACTION_FAILURE",
};
const RUN_METADATA_CONTRACT = {
  decisionRuleHash: "4".repeat(64),
  analysisVersion: "analysis-v1",
  harnessVersion: "1.0.0",
  harnessSourceHash: "7".repeat(64),
  provenanceHash: "5".repeat(64),
  gitDirtyEntryCount: 0,
  phase: "main",
  splitTaskIds: ["task/a"],
  taskRevisions: [{
    taskId: "task/a",
    variantId: "variant:1",
    cleanRevisionSha: "1".repeat(40),
    trapRevisionSha: "2".repeat(40),
    rightRevisionSha: "3".repeat(40),
    noTrapRevisionSha: "4".repeat(40),
  }],
  caps: {
    maxTurns: 12,
    maxToolCalls: 8,
    maxTotalTokens: 16_384,
    maxDurationMs: 120_000,
    requestTimeoutMs: 60_000,
    maxToolOutputChars: 16_384,
  },
  toolLocks: {
    allowedTools: ["inspect_repo"],
    taskToolSchemaHashes: [{
      taskId: "task/a",
      variantId: "variant:1",
      sha256: "6".repeat(64),
    }],
  },
  sandboxFlags: {
    networkDisabled: true,
    isolatedRepoPerArm: true,
    isolatedMemoryPerArm: true,
    isolatedSessionPerArm: true,
    rejectSymlinks: true,
  },
  retryRule: {
    hostApiFaultRetriesAfterFirstTry: 2,
    rerunTaskResults: false,
    retainAllTries: true,
  },
  runOrder: [{
    rowKey: "row-1",
    analysis: "PRIMARY",
    identity: IDENTITY,
  }],
} as const satisfies Pick<
  RepeatedFailureRunMetadata,
  | "decisionRuleHash"
  | "harnessSourceHash"
  | "analysisVersion"
  | "harnessVersion"
  | "provenanceHash"
  | "gitDirtyEntryCount"
  | "phase"
  | "splitTaskIds"
  | "taskRevisions"
  | "caps"
  | "toolLocks"
  | "sandboxFlags"
  | "retryRule"
  | "runOrder"
>;

function faultTry(attempt: 1 | 2 | 3, code = "RATE_LIMIT"): RepeatedFailureTry {
  return {
    attempt,
    durationMs: attempt * 10,
    tokens: {
      input: attempt,
      output: attempt + 1,
      total: attempt * 2 + 1,
      cachedInput: attempt + 2,
      cacheWriteInput: attempt + 3,
      reasoningOutput: attempt + 4,
    },
    outcome: {
      kind: "HOST_API_FAULT",
      code,
      messageHash: `message-${attempt}`,
    },
  };
}

function validEpisode(overrides: Partial<Extract<RepeatedFailureEpisode, { status: "VALID" }>> = {}): RepeatedFailureEpisode {
  return {
    status: "VALID",
    finalState: "FIXED",
    evidence: {
      startRepoHash: "repo-hash",
      startMemoryHash: "memory-hash",
      historyHash: "history-hash",
      askedActionHash: "action-hash",
      traceArtifactPath: "traces/row/attempt-1.json",
      traceArtifactHash: "a".repeat(64),
      gate: {
        status: "MATCH_WARN",
        fingerprintHash: "fingerprint-hash",
        warningHash: "warning-hash",
      },
      actionExecuted: true,
      checkResult: "PASS",
      repeatedFailure: false,
      taskPassed: true,
      steps: 4,
      warningCount: 1,
      falseWarningCount: 0,
      factPairAudit: "MATCHED",
      faults: ["Z_FAULT", "A_FAULT", "A_FAULT"],
    },
    isolation: {
      repoId: "repo-isolation",
      memoryId: "memory-isolation",
      codingScopeId: "scope-isolation",
      codeGraphId: "graph-isolation",
      chatId: "chat-isolation",
      sessionId: "session-isolation",
      cacheId: "cache-isolation",
    },
    ...overrides,
  };
}

function taskTry(
  attempt: 1 | 2 | 3,
  episode: RepeatedFailureEpisode = validEpisode()
): RepeatedFailureTry {
  return {
    attempt,
    durationMs: 100,
    tokens: {
      input: 11,
      output: 7,
      total: 18,
      cachedInput: 0,
      cacheWriteInput: 0,
      reasoningOutput: 3,
    },
    outcome: { kind: "TASK_RESULT", episode },

  };
}

async function tempStore(): Promise<{ dir: string; store: RepeatedFailureRowStore }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "h6-row-store-"));
  return { dir, store: new RepeatedFailureRowStore(dir) };
}

test("the shared design exposes exactly the five preregistered arms", () => {
  assert.deepEqual(REPEATED_FAILURE_ARMS, [
    "NO_MEMORY",
    "TURN_START_FAILURE",
    "TURN_START_SUCCESS",
    "PRE_ACTION_FAILURE",
    "BOTH",
  ]);
  assert.equal(Object.isFrozen(REPEATED_FAILURE_ARMS), true);
});

test("row keys use every identity field and a fixed opaque digest", () => {
  assert.equal(
    buildRepeatedFailureRowKey(IDENTITY),
    "h6-row-v1-fd5539ff1046b205f4515dd87cca5c8ba8bc86482b5b8edda9f7ef1fe4a83ff8"
  );
  const mutations: RepeatedFailureRowIdentity[] = [
    { ...IDENTITY, suiteVersion: "h6-suite-v2" },
    { ...IDENTITY, taskId: "task/b" },
    { ...IDENTITY, variantId: "variant:2" },
    { ...IDENTITY, modelProfileId: "other-model-profile" },
    { ...IDENTITY, modelProfileHash: "b".repeat(64) },
    { ...IDENTITY, seed: 18 },
    { ...IDENTITY, arm: "TURN_START_FAILURE" },
  ];
  const keys = mutations.map(buildRepeatedFailureRowKey);
  assert.equal(new Set([buildRepeatedFailureRowKey(IDENTITY), ...keys]).size, mutations.length + 1);
  for (const key of keys) assert.match(key, /^h6-row-v1-[a-f0-9]{64}$/);
});

test("unsafe identity strings cannot control checkpoint paths", () => {
  const root = path.join(os.tmpdir(), "h6-safe-root");
  const store = new RepeatedFailureRowStore(root);
  const unsafe = {
    ...IDENTITY,
    taskId: "../../outside",
    variantId: "/absolute/variant",
    modelProfileId: "model/../../../escape",
  };
  const checkpointPath = store.checkpointPath(unsafe);
  assert.equal(path.dirname(checkpointPath), path.join(root, "checkpoints"));
  assert.match(path.basename(checkpointPath), /^h6-row-v1-[a-f0-9]{64}\.json$/);
});

test("each host fault is atomically persisted and the third terminalizes INVALID", async () => {
  const { dir, store } = await tempStore();
  try {
    const first = await store.commitTry(IDENTITY, faultTry(1));
    assert.equal(first.tries.length, 1);
    assert.equal(first.terminal, undefined);
    const onDiskFirst = JSON.parse(await readFile(store.checkpointPath(IDENTITY), "utf8"));
    assert.equal(onDiskFirst.tries.length, 1);
    assert.deepEqual(onDiskFirst.tries[0].tokens, faultTry(1).tokens);

    const second = await store.commitTry(IDENTITY, faultTry(2));
    assert.equal(second.tries.length, 2);
    assert.equal(second.terminal, undefined);
    const third = await store.commitTry(IDENTITY, faultTry(3));
    assert.equal(third.tries.length, 3);
    assert.equal(third.terminal?.status, "INVALID");
    assert.equal(third.terminal?.invalidReason, "HOST_RETRIES_EXHAUSTED");
    assert.deepEqual(third.terminal?.tokens, {
      input: 6,
      output: 9,
      total: 15,
      cachedInput: 12,
      cacheWriteInput: 15,
      reasoningOutput: 18,
    });
    assert.equal(third.terminal?.durationMs, 60);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent sequential commits cannot lose an earlier try", async () => {
  const { dir, store } = await tempStore();
  try {
    await Promise.all([
      store.commitTry(IDENTITY, faultTry(1)),
      store.commitTry(IDENTITY, faultTry(2)),
    ]);
    const loaded = await store.load(IDENTITY);
    assert.equal(loaded.kind, "VALID");
    if (loaded.kind === "VALID") {
      assert.deepEqual(loaded.checkpoint.tries.map((entry) => entry.attempt), [1, 2]);
      const firstTry = loaded.checkpoint.tries[0];
      assert.ok(firstTry);
      const firstOutcome = firstTry.outcome;
      assert.equal(firstOutcome.kind, "HOST_API_FAULT");
      if (firstOutcome.kind === "HOST_API_FAULT") {
        assert.match(firstOutcome.messageHash, /^[a-f0-9]{64}$/);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a real task result terminalizes immediately and can never be rerun", async () => {
  const { dir, store } = await tempStore();
  try {
    const checkpoint = await store.commitTry(IDENTITY, taskTry(1));
    assert.equal(checkpoint.terminal?.status, "VALID");
    assert.equal(checkpoint.terminal?.taskPassed, true);
    assert.equal(checkpoint.terminal?.tryCount, 1);
    await assert.rejects(() => store.commitTry(IDENTITY, faultTry(2)), /terminal and immutable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a real task failure is terminal rather than host-retryable", async () => {
  const { dir, store } = await tempStore();
  try {
    const failed = validEpisode({ finalState: "TRAPPED" });
    if (failed.status === "VALID") {
      failed.evidence = { ...failed.evidence, repeatedFailure: true, taskPassed: false, checkResult: "FAIL" };
    }
    const checkpoint = await store.commitTry(IDENTITY, taskTry(1, failed));
    assert.equal(checkpoint.terminal?.finalState, "TRAPPED");
    assert.equal(checkpoint.terminal?.repeatedFailure, true);
    await assert.rejects(() => store.commitTry(IDENTITY, faultTry(2)), /terminal and immutable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("commit is idempotent only for an equivalent attempt", async () => {
  const { dir, store } = await tempStore();
  try {
    const first = await store.commitTry(IDENTITY, faultTry(1));
    assert.deepEqual(await store.commitTry(IDENTITY, faultTry(1)), first);
    await assert.rejects(
      () => store.commitTry(IDENTITY, { ...faultTry(1), durationMs: 999 }),
      /Expected attempt 2/
    );
    await assert.rejects(() => store.commitTry(IDENTITY, faultTry(3)), /Expected attempt 2/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("terminal repeats are idempotent but terminal mutation is rejected", async () => {
  const { dir, store } = await tempStore();
  try {
    const originalTry = taskTry(1);
    const terminal = await store.commitTry(IDENTITY, originalTry);
    assert.deepEqual(await store.commitTry(IDENTITY, originalTry), terminal);
    await assert.rejects(
      () => store.commitTry(IDENTITY, taskTry(1, validEpisode({ finalState: "UNFIXED" }))),
      /terminal and immutable/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a task-result try followed by a host fault is malformed rather than resumable", async () => {
  const { dir, store } = await tempStore();
  try {
    await store.commitTry(IDENTITY, taskTry(1));
    const checkpointPath = store.checkpointPath(IDENTITY);
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    const malformedCheckpoint = {
      ...checkpoint,
      tries: [...checkpoint.tries, faultTry(2)],
      terminal: undefined,
    };
    await writeFile(checkpointPath, `${JSON.stringify(malformedCheckpoint)}\n`, "utf8");
    assert.equal((await store.load(IDENTITY)).kind, "MALFORMED");
    await assert.rejects(() => store.loadTerminalForResume(IDENTITY), /task result must be the final try/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing, malformed, resumable, and exact-identity states stay distinct", async () => {
  const { dir, store } = await tempStore();
  try {
    assert.deepEqual(await store.load(IDENTITY), { kind: "MISSING" });
    await mkdir(store.checkpointsDir, { recursive: true });
    await writeFile(store.checkpointPath(IDENTITY), "not-json\n", "utf8");
    assert.equal((await store.load(IDENTITY)).kind, "MALFORMED");
    await assert.rejects(() => store.loadTerminalForResume(IDENTITY));

    await rm(store.checkpointPath(IDENTITY), { force: true });
    const terminal = (await store.commitTry(IDENTITY, taskTry(1))).terminal;
    assert.deepEqual(await store.loadTerminalForResume(IDENTITY), terminal);
    assert.equal(await store.loadTerminalForResume({ ...IDENTITY, seed: 18 }), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkpoint identity/key collisions fail closed", async () => {
  const { dir, store } = await tempStore();
  try {
    await store.commitTry(IDENTITY, faultTry(1));
    const checkpointPath = store.checkpointPath(IDENTITY);
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    checkpoint.identity.taskId = "different-task";
    await writeFile(checkpointPath, `${JSON.stringify(checkpoint)}\n`, "utf8");
    assert.equal((await store.load(IDENTITY)).kind, "MALFORMED");
    await assert.rejects(() => store.commitTry(IDENTITY, faultTry(2)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a dangling interrupted temp replacement cannot corrupt the prior checkpoint", async () => {
  const { dir, store } = await tempStore();
  try {
    const prior = await store.commitTry(IDENTITY, faultTry(1));
    await writeFile(
      path.join(store.checkpointsDir, `.${path.basename(store.checkpointPath(IDENTITY))}.interrupted.tmp`),
      "{",
      "utf8"
    );
    const loaded = await store.load(IDENTITY);
    assert.equal(loaded.kind, "VALID");
    if (loaded.kind === "VALID") assert.deepEqual(loaded.checkpoint, prior);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compiled JSONL is deterministic across commit and directory order", async () => {
  const first = await tempStore();
  const second = await tempStore();
  try {
    const identities = [
      { ...IDENTITY, taskId: "task-z" },
      { ...IDENTITY, taskId: "task-a" },
      { ...IDENTITY, taskId: "task-m" },
    ];
    for (const identity of identities) await first.store.commitTry(identity, taskTry(1));
    for (const identity of [...identities].reverse()) await second.store.commitTry(identity, taskTry(1));
    const firstPath = await first.store.writeEpisodesJsonl();
    const secondPath = await second.store.writeEpisodesJsonl();
    const firstBytes = await readFile(firstPath, "utf8");
    const secondBytes = await readFile(secondPath, "utf8");
    assert.equal(firstBytes, secondBytes);
    assert.equal(firstBytes.endsWith("\n"), true);
    assert.equal(firstBytes.split("\n").filter(Boolean).length, identities.length);
    const parsed = firstBytes.trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(
      parsed.map((row) => row.rowKey),
      [...parsed.map((row) => row.rowKey)].sort()
    );
    const firstLine = firstBytes.split("\n")[0];
    assert.ok(firstLine);
    assert.match(firstLine, /^\{"schemaVersion":1,"rowKey":"h6-row-v1-/);
    assert.deepEqual(await readdir(first.store.checkpointsDir).then((names) => names.sort()), await readdir(second.store.checkpointsDir).then((names) => names.sort()));
  } finally {
    await rm(first.dir, { recursive: true, force: true });
    await rm(second.dir, { recursive: true, force: true });
  }
});

test("public JSONL hashes unsafe values, sorts sets, and rejects non-finite numbers", async () => {
  const { dir, store } = await tempStore();
  try {
    const unsafeEpisode = validEpisode();
    if (unsafeEpisode.status === "VALID") {
      unsafeEpisode.isolation.repoId = "/home/user/private-repo";
      unsafeEpisode.isolation.memoryId = "super-secret-token";
      unsafeEpisode.evidence.faults = ["/home/user/log", "secret=value", "SAFE_CODE"];
    }
    await store.commitTry(IDENTITY, taskTry(1, unsafeEpisode));
    const jsonl = await readFile(await store.writeEpisodesJsonl(), "utf8");
    assert.equal(jsonl.includes("/home/user"), false);
    assert.equal(jsonl.includes("super-secret-token"), false);
    assert.equal(jsonl.includes("secret=value"), false);
    const row = JSON.parse(jsonl);
    assert.match(row.isolation.repoId, /^h6-id-v1-[a-f0-9]{64}$/);
    assert.deepEqual(row.evidence.faults, [...row.evidence.faults].sort());

    await assert.rejects(
      () => store.commitTry({ ...IDENTITY, taskId: "nan" }, { ...faultTry(1), durationMs: Number.NaN }),
      /finite duration/
    );
    const nonFiniteTokens = faultTry(1);
    nonFiniteTokens.tokens.cacheWriteInput = Number.NaN;
    await assert.rejects(
      () => store.commitTry({ ...IDENTITY, taskId: "nan-token" }, nonFiniteTokens),
      /token usage/,
    );
    await assert.rejects(
      () => store.commitTry(
        { ...IDENTITY, taskId: "inconsistent-total" },
        { ...faultTry(1), tokens: { ...faultTry(1).tokens, total: 999 } },
      ),
      /token usage/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("run metadata writer atomically sorts paired model profiles and set-derived fields", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "h6-run-metadata-"));
  try {
    const filePath = await writeRepeatedFailureRunMetadata(dir, {
      schemaVersion: 1,
      runId: "run-1",
      suiteVersion: "h6-v1",
      datasetInventoryHash: "1".repeat(64),
      resumeContractHash: "2".repeat(64),
      expectedDesignHash: "3".repeat(64),
      ...RUN_METADATA_CONTRACT,
      gitSha: "abc123",
      gitDirty: false,
      mode: "full",
      arms: ["BOTH", "NO_MEMORY", "BOTH"],
      modelProfileIds: [
        "z-profile",
        "a-profile",
        "z-profile",
        "z-profile",
        "a-profile",
      ],
      modelProfileHashes: [
        "1".repeat(64),
        "f".repeat(64),
        "0".repeat(64),
        "1".repeat(64),
        "f".repeat(64),
      ],
      seeds: [9, 1, 9],
      expectedRowCount: 10,
      statisticsSeed: 7,
      statisticsDraws: 10_000,
    });
    const metadata = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(metadata.arms, ["NO_MEMORY", "BOTH"]);
    assert.deepEqual(metadata.modelProfileIds, ["a-profile", "z-profile", "z-profile"]);
    assert.deepEqual(
      metadata.modelProfileHashes,
      ["f".repeat(64), "0".repeat(64), "1".repeat(64)],
    );
    assert.deepEqual(metadata.seeds, [1, 9]);
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("run metadata writer fails closed on corrupt or misaligned model profile pairs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "h6-run-metadata-invalid-"));
  const metadata = {
    schemaVersion: 1 as const,
    runId: "run-1",
    suiteVersion: "h6-v1",
    datasetInventoryHash: "1".repeat(64),
    resumeContractHash: "2".repeat(64),
    expectedDesignHash: "3".repeat(64),
    gitSha: "abc123",
    ...RUN_METADATA_CONTRACT,
    gitDirty: false,
    mode: "full" as const,
    arms: ["NO_MEMORY"] as const,
    modelProfileIds: ["profile-a"],
    modelProfileHashes: ["a".repeat(64)],
    seeds: [1],
    expectedRowCount: 1,
    statisticsSeed: 7,
    statisticsDraws: 10_000,
  };
  try {
    await assert.rejects(
      () => writeRepeatedFailureRunMetadata(dir, {
        ...metadata,
        modelProfileIds: ["profile-a", "profile-b"],
      }),
      /same length/,
    );
    await assert.rejects(
      () => writeRepeatedFailureRunMetadata(dir, {
        ...metadata,
        modelProfileHashes: ["not-a-sha256"],
      }),
      /model profile hash/,
    );
    await assert.rejects(
      () => writeRepeatedFailureRunMetadata(dir, {
        ...metadata,
        modelProfileIds: [""],
      }),
      /model profile id/,
    );
    await assert.rejects(() => readFile(path.join(dir, "run.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
