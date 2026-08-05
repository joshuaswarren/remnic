import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  computeTrapAuditMetrics,
  computeTrapAuditArtifactHash,
  runTrapAudit,
  verifyTrapAuditArtifact,
  verifyMatchingTrapAudit,
  type RepeatedFailureTrapAuditRow,
  type RepeatedFailureTrapAuditArtifact,
} from "./repeated-failure-trap-audit.js";
import {
  PROMPT_CONTRACT,
  computeAnalysisHarnessHash,
  loadFixtureBundle,
} from "./repeated-failure-suite.js";
import { RepeatedFailureRowStore, buildRepeatedFailureRowKey } from "./repeated-failure-store.js";
import type {
  RepeatedFailureEpisode,
  RepeatedFailureEpisodeDriver,
  RepeatedFailureRowIdentity,
} from "./repeated-failure-types.js";
import { sanitizeFilenameSegment } from "../filename-safety.js";
import { parseBenchCodingArgs } from "../../../remnic-cli/src/bench-coding-commands.js";

const TEST_PROFILE_ID = "test-model-v1";
const TEST_PROFILE_HASH = "a".repeat(64);
const TEST_MODEL_DIGEST = "e".repeat(64);
const TEST_DATASET_HASH = "b".repeat(64);
const TEST_HARNESS_HASH = "c".repeat(64);
const TEST_DECISION_RULE_HASH = "d".repeat(64);
const TEST_THRESHOLDS = Object.freeze({
  minimumTrappedRate: 0.3,
  minimumNonFixedRate: 0.5,
  maximumInvalidRows: 0 as const,
  requireCompleteRows: true as const,
});
const TEST_EXPECTED_AUDIT = Object.freeze({
  modelProfileId: TEST_PROFILE_ID,
  modelProfileHash: TEST_PROFILE_HASH,
  modelDigest: TEST_MODEL_DIGEST,
  datasetInventoryHash: TEST_DATASET_HASH,
  harnessSourceHash: TEST_HARNESS_HASH,
  decisionRuleHash: TEST_DECISION_RULE_HASH,
  thresholds: TEST_THRESHOLDS,
  rowIdentities: Array.from({ length: 30 }, (_, index) => {
    const taskId = `task-${index + 1}`;
    return {
      taskId,
      variantId: `${taskId}-v1`,
      rowKey: `h6-row-v1-${taskId}`,
    };
  }),
});

function makeDummyRow(
  taskId: string,
  finalState: "TRAPPED" | "FIXED" | "UNFIXED" | "NO_TRAP" | "INVALID",
): RepeatedFailureTrapAuditRow {
  return {
    taskId,
    variantId: `${taskId}-v1`,
    rowKey: `h6-row-v1-${taskId}`,
    finalState,
    status: finalState === "INVALID" ? "INVALID" : "VALID",
    tryCount: 1,
    durationMs: 50,
    tokens: { input: 100, output: 50, total: 150, cachedInput: 0, cacheWriteInput: 0, reasoningOutput: 0 },
  };
}

function makePassingArtifact(): RepeatedFailureTrapAuditArtifact {
  const rows: RepeatedFailureTrapAuditRow[] = [];
  for (let index = 1; index <= 15; index++) rows.push(makeDummyRow(`task-${index}`, "TRAPPED"));
  for (let index = 16; index <= 24; index++) rows.push(makeDummyRow(`task-${index}`, "UNFIXED"));
  for (let index = 25; index <= 30; index++) rows.push(makeDummyRow(`task-${index}`, "FIXED"));
  const metrics = computeTrapAuditMetrics(rows, 30, TEST_THRESHOLDS);
  const payload: Omit<RepeatedFailureTrapAuditArtifact, "artifactHash"> = {
    schemaVersion: 1,
    modelProfileId: TEST_PROFILE_ID,
    modelProfileHash: TEST_PROFILE_HASH,
    modelDigest: TEST_MODEL_DIGEST,
    datasetInventoryHash: TEST_DATASET_HASH,
    harnessSourceHash: TEST_HARNESS_HASH,
    decisionRuleHash: TEST_DECISION_RULE_HASH,
    thresholds: TEST_THRESHOLDS,
    passed: metrics.passed,
    metrics,
    rows,
  };
  return { ...payload, artifactHash: computeTrapAuditArtifactHash(payload) };
}

function makeFrozenMatchingArtifact(): RepeatedFailureTrapAuditArtifact {
  const artifact = makePassingArtifact();
  const rows = artifact.rows.map((row, index): RepeatedFailureTrapAuditRow => {
    const taskId = `h6-task-${String(index + 1).padStart(2, "0")}`;
    const variantId = `${taskId}-v1`;
    return {
      ...row,
      taskId,
      variantId,
      rowKey: buildRepeatedFailureRowKey({
        suiteVersion: `h6-failure-gate-v1-${TEST_DATASET_HASH}-${TEST_HARNESS_HASH}`,
        taskId,
        variantId,
        modelProfileId: TEST_PROFILE_ID,
        modelProfileHash: TEST_PROFILE_HASH,
        seed: 1,
        arm: "NO_MEMORY",
      }),
    };
  });
  const metrics = computeTrapAuditMetrics(rows, rows.length, TEST_THRESHOLDS);
  const { artifactHash: _artifactHash, ...originalPayload } = artifact;
  const payload: Omit<RepeatedFailureTrapAuditArtifact, "artifactHash"> = {
    ...originalPayload,
    rows,
    metrics,
  };
  return { ...payload, artifactHash: computeTrapAuditArtifactHash(payload) };
}

function terminalEpisode(
  traceArtifactPath: string,
  traceArtifactHash: string,
): RepeatedFailureEpisode {
  return {
    status: "VALID",
    finalState: "FIXED",
    evidence: {
      startRepoHash: "repo-hash",
      startMemoryHash: "memory-hash",
      askedActionHash: "action-hash",
      historyHash: "history-hash",
      traceArtifactPath,
      traceArtifactHash,
      gate: {
        status: "NO_MATCH",
        fingerprintHash: "fingerprint-hash",
      },
      actionExecuted: true,
      checkResult: "PASS",
      repeatedFailure: false,
      taskPassed: true,
      steps: 1,
      warningCount: 0,
      falseWarningCount: 0,
      factPairAudit: "MATCHED",
      faults: [],
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
  };
}

function noCallDriver(modelProfileId: string): RepeatedFailureEpisodeDriver & { calls: number } {
  return {
    driverKind: "deterministic-fake",
    modelProfileId,
    modelProfileHash: TEST_PROFILE_HASH,
    modelDigest: TEST_MODEL_DIGEST,
    developerInstructions: "Frozen test contract.",
    tokenizer: {
      identity: "test-nfkc-whitespace",
      implementation: "nfkc-whitespace-v1",
    },
    calls: 0,
    async runEpisode() {
      this.calls += 1;
      throw new Error("terminal audit rows must not call the driver");
    },
  };
}

async function seedTerminalAuditRows(
  outputDir: string,
  driver: RepeatedFailureEpisodeDriver,
  traceIdentity?: (identity: RepeatedFailureRowIdentity) => RepeatedFailureRowIdentity,
  retryBeforeResult = false,
): Promise<number> {
  const bundle = await loadFixtureBundle();
  const store = new RepeatedFailureRowStore(outputDir);
  const harnessSourceHash = await computeAnalysisHarnessHash();
  for (const task of bundle.dataset.tasks) {
    const variant = task.variants[0];
    assert.ok(variant);
    const identity: RepeatedFailureRowIdentity = {
      suiteVersion: `h6-failure-gate-v1-${bundle.dataset.inventoryHash}-${harnessSourceHash}`,
      taskId: task.id,
      variantId: variant.variantId,
      modelProfileId: driver.modelProfileId,
      modelProfileHash: driver.modelProfileHash,
      seed: 1,
      arm: "NO_MEMORY",
    };
    const rowKey = buildRepeatedFailureRowKey(identity);
    const tokens = {
      input: 1,
      output: 1,
      total: 2,
      cachedInput: 0,
      cacheWriteInput: 0,
      reasoningOutput: 0,
    };
    const terminalAttempt = retryBeforeResult ? 2 : 1;
    const traceArtifactPath = `traces/${rowKey}/attempt-${terminalAttempt}.json`;
    const traceBytes = `${JSON.stringify({
      schemaVersion: 1,
      identity: traceIdentity?.(identity) ?? identity,
      result: { usage: tokens },
      finalRepoEvidence: { checkResult: "FIXED" },
      armAudit: { badStrategyExecuted: false },
    }, null, 2)}\n`;
    const tracePath = path.join(outputDir, traceArtifactPath);
    await mkdir(path.dirname(tracePath), { recursive: true });
    await writeFile(tracePath, traceBytes);
    const traceArtifactHash = createHash("sha256").update(traceBytes).digest("hex");
    if (retryBeforeResult) {
      const retryTokens = {
        input: 2,
        output: 1,
        total: 3,
        cachedInput: 0,
        cacheWriteInput: 0,
        reasoningOutput: 0,
      };
      const retryTracePath = `traces/${rowKey}/attempt-1.json`;
      const retryTraceBytes = `${JSON.stringify({
        schemaVersion: 1,
        identity,
        hostFault: { code: "RATE_LIMIT" },
        usage: retryTokens,
        finalRepoEvidence: { checkResult: "FIXED" },
      }, null, 2)}\n`;
      await writeFile(path.join(outputDir, retryTracePath), retryTraceBytes);
      const retryTraceHash = createHash("sha256").update(retryTraceBytes).digest("hex");
      const claim = await store.claimRow(identity);
      await store.commitTry(claim, {
        attempt: 1,
        durationMs: 1,
        tokens: retryTokens,
        outcome: {
          kind: "HOST_API_FAULT",
          code: "RATE_LIMIT",
          messageHash: "a".repeat(64),
          traceArtifactPath: retryTracePath,
          traceArtifactHash: retryTraceHash,
        },
      });
      await store.releaseClaim(claim);
    }
    const claim = await store.claimRow(identity);
    try {
      await store.commitTry(claim, {
        attempt: terminalAttempt,
        durationMs: 1,
        tokens,
        outcome: {
          kind: "TASK_RESULT",
          episode: terminalEpisode(traceArtifactPath, traceArtifactHash),
        },
      });
    } finally {
      await store.releaseClaim(claim);
    }
  }
  return bundle.dataset.tasks.length;
}

test("computeTrapAuditMetrics: 15/30 trapped and 24/30 nonfixed passes", () => {
  // 15 TRAPPED, 9 UNFIXED, 6 FIXED = 30 tasks
  const rows: RepeatedFailureTrapAuditRow[] = [];
  for (let i = 1; i <= 15; i++) {
    rows.push(makeDummyRow(`task-${i}`, "TRAPPED"));
  }
  for (let i = 16; i <= 24; i++) {
    rows.push(makeDummyRow(`task-${i}`, "UNFIXED"));
  }
  for (let i = 25; i <= 30; i++) {
    rows.push(makeDummyRow(`task-${i}`, "FIXED"));
  }

  const metrics = computeTrapAuditMetrics(rows, 30, TEST_THRESHOLDS);
  assert.equal(metrics.totalTasks, 30);
  assert.equal(metrics.completedRows, 30);
  assert.equal(metrics.trappedCount, 15);
  assert.equal(metrics.trappedRate, 0.5);
  assert.equal(metrics.nonFixedCount, 24);
  assert.equal(metrics.nonFixedRate, 0.8);
  assert.equal(metrics.invalidCount, 0);
  assert.equal(metrics.missingCount, 0);

  const payload: Omit<RepeatedFailureTrapAuditArtifact, "artifactHash"> = {
    schemaVersion: 1,
    modelProfileId: TEST_PROFILE_ID,
    modelProfileHash: TEST_PROFILE_HASH,
    modelDigest: TEST_MODEL_DIGEST,
    datasetInventoryHash: TEST_DATASET_HASH,
    harnessSourceHash: TEST_HARNESS_HASH,
    decisionRuleHash: TEST_DECISION_RULE_HASH,
    thresholds: TEST_THRESHOLDS,
    passed: metrics.passed,
    metrics,
    rows,
  };
  const artifactHash = computeTrapAuditArtifactHash(payload);
  const artifact: RepeatedFailureTrapAuditArtifact = { ...payload, artifactHash };

  const verification = verifyTrapAuditArtifact(artifact, TEST_EXPECTED_AUDIT);
  assert.equal(verification.valid, true, verification.error);
});

test("computeTrapAuditMetrics: 8/30 trapped fails the 0.30 floor", () => {
  // 8 TRAPPED (0.267, below the 0.30 floor), 16 UNFIXED, 6 FIXED = 30 tasks.
  // Non-fixed is 24/30 = 0.80 and clears its own floor, so this isolates the
  // trapped-rate rejection.
  const rows: RepeatedFailureTrapAuditRow[] = [];
  for (let i = 1; i <= 8; i++) {
    rows.push(makeDummyRow(`task-${i}`, "TRAPPED"));
  }
  for (let i = 9; i <= 24; i++) {
    rows.push(makeDummyRow(`task-${i}`, "UNFIXED"));
  }
  for (let i = 25; i <= 30; i++) {
    rows.push(makeDummyRow(`task-${i}`, "FIXED"));
  }

  const metrics = computeTrapAuditMetrics(rows, 30, TEST_THRESHOLDS);
  assert.equal(metrics.trappedRate, 8 / 30);
  assert.equal(metrics.nonFixedRate, 24 / 30);
  assert.equal(metrics.passed, false);
});

test("computeTrapAuditMetrics: 14/30 nonfixed fails the 0.50 floor", () => {
  // 12 TRAPPED (0.40, clears the trapped floor), 2 UNFIXED, 16 FIXED = 30 tasks.
  // Non-fixed is 14/30 = 0.467, just under the 0.50 floor, so this isolates the
  // non-fixed rejection.
  const rows: RepeatedFailureTrapAuditRow[] = [];
  for (let i = 1; i <= 12; i++) {
    rows.push(makeDummyRow(`task-${i}`, "TRAPPED"));
  }
  for (let i = 13; i <= 14; i++) {
    rows.push(makeDummyRow(`task-${i}`, "UNFIXED"));
  }
  for (let i = 15; i <= 30; i++) {
    rows.push(makeDummyRow(`task-${i}`, "FIXED"));
  }

  const metrics = computeTrapAuditMetrics(rows, 30, TEST_THRESHOLDS);
  assert.equal(metrics.trappedRate, 12 / 30);
  assert.equal(metrics.nonFixedRate, 14 / 30);
  assert.equal(metrics.passed, false);
});

test("verifyTrapAuditArtifact: rejects tampered artifact or drift", () => {
  const rows: RepeatedFailureTrapAuditRow[] = [];
  for (let i = 1; i <= 15; i++) rows.push(makeDummyRow(`task-${i}`, "TRAPPED"));
  for (let i = 16; i <= 24; i++) rows.push(makeDummyRow(`task-${i}`, "UNFIXED"));
  for (let i = 25; i <= 30; i++) rows.push(makeDummyRow(`task-${i}`, "FIXED"));
  const metrics = computeTrapAuditMetrics(rows, 30, TEST_THRESHOLDS);

  const payload: Omit<RepeatedFailureTrapAuditArtifact, "artifactHash"> = {
    schemaVersion: 1,
    modelProfileId: TEST_PROFILE_ID,
    modelProfileHash: TEST_PROFILE_HASH,
    modelDigest: TEST_MODEL_DIGEST,
    datasetInventoryHash: TEST_DATASET_HASH,
    harnessSourceHash: TEST_HARNESS_HASH,
    decisionRuleHash: TEST_DECISION_RULE_HASH,
    thresholds: TEST_THRESHOLDS,
    passed: metrics.passed,
    metrics,
    rows,
  };
  const validHash = computeTrapAuditArtifactHash(payload);
  const artifact: RepeatedFailureTrapAuditArtifact = { ...payload, artifactHash: validHash };

  // Tampered payload with valid hash
  const tampered: RepeatedFailureTrapAuditArtifact = {
    ...artifact,
    artifactHash: "bad".padEnd(64, "0"),
  };
  assert.equal(verifyTrapAuditArtifact(tampered, TEST_EXPECTED_AUDIT).valid, false);

  // Mismatched profile hash drift
  const drifted = verifyTrapAuditArtifact(artifact, {
    ...TEST_EXPECTED_AUDIT,
    modelProfileHash: "d".repeat(64),
  });
  assert.equal(drifted.valid, false);
  const digestDrifted = verifyTrapAuditArtifact(artifact, {
    ...TEST_EXPECTED_AUDIT,
    modelDigest: "f".repeat(64),
  });
  assert.equal(digestDrifted.valid, false);
});

test("PROMPT_CONTRACT is neutral for trap and no-trap populations", () => {
  assert.equal(typeof PROMPT_CONTRACT.noTrapInstruction, "string");
  assert.equal(typeof PROMPT_CONTRACT.trapInstruction, "string");
  assert.equal(PROMPT_CONTRACT.noTrapInstruction, PROMPT_CONTRACT.trapInstruction);
  const text = PROMPT_CONTRACT.noTrapInstruction.toLowerCase();
  assert.equal(text.includes("trap"), false);
  assert.equal(text.includes("prior failure"), false);
  assert.equal(text.includes("bad"), false);
  assert.equal(text.includes("good"), false);
});

test("parseBenchCodingArgs handles trap-audit command strictly", () => {
  const parsed = parseBenchCodingArgs(["repeated-failure", "trap-audit", "--profile", "profile.json", "--out", "out_dir"]);
  assert.equal(parsed.kind, "trap-audit");
  if (parsed.kind === "trap-audit") {
    assert.deepEqual(parsed.profilePaths, ["profile.json"]);
    assert.equal(parsed.outputDir, "out_dir");
  }

  assert.throws(() => parseBenchCodingArgs(["trap-audit"]), /requires at least one --profile/);
});

test("verifyMatchingTrapAudit finds and validates saved audit artifact", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "h6-audit-test-"));
  try {
    const artifact = makeFrozenMatchingArtifact();

    await writeFile(path.join(tmp, `trap-audit-${TEST_PROFILE_ID}.json`), JSON.stringify(artifact, null, 2));

    const found = await verifyMatchingTrapAudit(
      { id: TEST_PROFILE_ID, hash: TEST_PROFILE_HASH, modelDigest: TEST_MODEL_DIGEST },
      TEST_DATASET_HASH,
      TEST_HARNESS_HASH,
      { hash: TEST_DECISION_RULE_HASH, trapAudit: TEST_THRESHOLDS },
      [tmp],
    );
    assert.equal(found.modelProfileId, TEST_PROFILE_ID);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("verifyMatchingTrapAudit selects by validated identity and content, not filename", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "h6-audit-identity-"));
  try {
    const validArtifact = makeFrozenMatchingArtifact();
    const { artifactHash: _artifactHash, ...validPayload } = validArtifact;
    const wrongPayload: Omit<RepeatedFailureTrapAuditArtifact, "artifactHash"> = {
      ...validPayload,
      decisionRuleHash: "e".repeat(64),
    };
    const wrongArtifact = {
      ...wrongPayload,
      artifactHash: computeTrapAuditArtifactHash(wrongPayload),
    };
    await Promise.all([
      writeFile(
        path.join(tmp, `trap-audit-${TEST_PROFILE_ID}-${TEST_PROFILE_HASH}.json`),
        JSON.stringify(wrongArtifact),
      ),
      writeFile(path.join(tmp, "trap-audit-valid-content.json"), JSON.stringify(validArtifact)),
    ]);

    const found = await verifyMatchingTrapAudit(
      { id: TEST_PROFILE_ID, hash: TEST_PROFILE_HASH, modelDigest: TEST_MODEL_DIGEST },
      TEST_DATASET_HASH,
      TEST_HARNESS_HASH,
      { hash: TEST_DECISION_RULE_HASH, trapAudit: TEST_THRESHOLDS },
      [tmp],
    );
    assert.equal(found.artifactHash, validArtifact.artifactHash);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("verifyTrapAuditArtifact rejects a rehashed forged pass verdict", () => {
  const rows = Array.from({ length: 30 }, (_, index) => makeDummyRow(`task-${index + 1}`, "FIXED"));
  const metrics = computeTrapAuditMetrics(rows, rows.length, TEST_THRESHOLDS);
  const payload: Omit<RepeatedFailureTrapAuditArtifact, "artifactHash"> = {
    schemaVersion: 1,
    modelProfileId: TEST_PROFILE_ID,
    modelProfileHash: TEST_PROFILE_HASH,
    modelDigest: TEST_MODEL_DIGEST,
    datasetInventoryHash: TEST_DATASET_HASH,
    harnessSourceHash: TEST_HARNESS_HASH,
    decisionRuleHash: TEST_DECISION_RULE_HASH,
    thresholds: TEST_THRESHOLDS,
    passed: true,
    metrics: { ...metrics, passed: true },
    rows,
  };
  const artifact: RepeatedFailureTrapAuditArtifact = {
    ...payload,
    artifactHash: computeTrapAuditArtifactHash(payload),
  };

  const verification = verifyTrapAuditArtifact(artifact, TEST_EXPECTED_AUDIT);
  assert.equal(verification.valid, false);
  assert.match(verification.error ?? "", /recomputation mismatch/);
});

test("verifyTrapAuditArtifact requires the frozen decision rule", () => {
  const artifact = makePassingArtifact();
  const verification = Reflect.apply(verifyTrapAuditArtifact, undefined, [artifact]) as {
    valid: boolean;
    error?: string;
  };

  assert.equal(verification.valid, false);
  assert.match(verification.error ?? "", /expected decision rule is required/);
});

test("verifyTrapAuditArtifact rejects a rehashed artifact missing its decision-rule hash", () => {
  const artifact = makePassingArtifact();
  const {
    artifactHash: _artifactHash,
    decisionRuleHash: _decisionRuleHash,
    ...payload
  } = artifact;
  const malformedArtifact: Record<string, unknown> = {
    ...payload,
    artifactHash: computeTrapAuditArtifactHash(
      payload as unknown as Omit<RepeatedFailureTrapAuditArtifact, "artifactHash">,
    ),
  };

  const verification = verifyTrapAuditArtifact(malformedArtifact, TEST_EXPECTED_AUDIT);
  assert.equal(verification.valid, false);
  assert.match(verification.error ?? "", /fields do not match|missing or invalid hash/);
});

test("verifyTrapAuditArtifact rejects rehashed mismatched thresholds", () => {
  const artifact = makePassingArtifact();
  const mismatchedThresholds = {
    ...TEST_THRESHOLDS,
    minimumTrappedRate: 0.4,
  };
  const metrics = computeTrapAuditMetrics(artifact.rows, artifact.metrics.totalTasks, mismatchedThresholds);
  const { artifactHash: _artifactHash, ...originalPayload } = artifact;
  const payload: Omit<RepeatedFailureTrapAuditArtifact, "artifactHash"> = {
    ...originalPayload,
    thresholds: mismatchedThresholds,
    metrics,
    passed: metrics.passed,
  };
  const mismatchedArtifact = {
    ...payload,
    artifactHash: computeTrapAuditArtifactHash(payload),
  };

  const verification = verifyTrapAuditArtifact(mismatchedArtifact, TEST_EXPECTED_AUDIT);
  assert.equal(verification.valid, false);
  assert.match(verification.error ?? "", /thresholds do not match/);
});

test("verifyTrapAuditArtifact rejects rehashed recomputed-metric tampering", () => {
  const artifact = makePassingArtifact();
  const { artifactHash: _artifactHash, ...originalPayload } = artifact;
  const payload: Omit<RepeatedFailureTrapAuditArtifact, "artifactHash"> = {
    ...originalPayload,
    metrics: {
      ...artifact.metrics,
      trappedCount: artifact.metrics.trappedCount + 1,
    },
  };
  const tamperedArtifact = {
    ...payload,
    artifactHash: computeTrapAuditArtifactHash(payload),
  };

  const verification = verifyTrapAuditArtifact(tamperedArtifact, TEST_EXPECTED_AUDIT);
  assert.equal(verification.valid, false);
  assert.match(verification.error ?? "", /recomputation mismatch/);
});

test("verifyTrapAuditArtifact rejects rehashed row truncation with self-consistent metrics", () => {
  const artifact = makePassingArtifact();
  const rows = artifact.rows.slice(0, 29);
  const metrics = computeTrapAuditMetrics(rows, rows.length, TEST_THRESHOLDS);
  assert.equal(metrics.passed, true);
  const { artifactHash: _artifactHash, ...originalPayload } = artifact;
  const payload: Omit<RepeatedFailureTrapAuditArtifact, "artifactHash"> = {
    ...originalPayload,
    rows,
    metrics,
    passed: metrics.passed,
  };
  const truncatedArtifact = {
    ...payload,
    artifactHash: computeTrapAuditArtifactHash(payload),
  };

  const verification = verifyTrapAuditArtifact(truncatedArtifact, TEST_EXPECTED_AUDIT);
  assert.equal(verification.valid, false);
  assert.match(verification.error ?? "", /row identities do not match/);
});

test("runTrapAudit reuses terminal checkpoints without driver calls or checkpoint mutation", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-audit-resume-"));
  const driver = noCallDriver(TEST_PROFILE_ID);
  try {
    const taskCount = await seedTerminalAuditRows(outputDir, driver, undefined, true);
    const checkpointDir = path.join(outputDir, "checkpoints");
    const checkpointNames = (await readdir(checkpointDir)).sort();
    const before = await Promise.all(
      checkpointNames.map(async (name) => [name, await readFile(path.join(checkpointDir, name), "utf8")] as const),
    );

    const artifact = await runTrapAudit({ driver, outputDir });
    const bundle = await loadFixtureBundle();
    const after = await Promise.all(
      checkpointNames.map(async (name) => [name, await readFile(path.join(checkpointDir, name), "utf8")] as const),
    );

    assert.equal(driver.calls, 0);
    assert.equal(artifact.rows.length, taskCount);
    assert.deepEqual(artifact.thresholds, bundle.decisionRule.trapAudit);
    assert.equal(
      artifact.decisionRuleHash,
      createHash("sha256").update(bundle.decisionRuleBytes).digest("hex"),
    );
    assert.deepEqual(after, before);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("runTrapAudit rejects a terminal checkpoint with missing trace evidence", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-audit-trace-"));
  const driver = noCallDriver(TEST_PROFILE_ID);
  try {
    await seedTerminalAuditRows(outputDir, driver);
    const [traceDir] = await readdir(path.join(outputDir, "traces"));
    assert.ok(traceDir);
    await rm(path.join(outputDir, "traces", traceDir, "attempt-1.json"));

    await assert.rejects(
      () => runTrapAudit({ driver, outputDir }),
      /invalid trace evidence/,
    );
    assert.equal(driver.calls, 0);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("runTrapAudit rejects a rehashed trace for a different row identity", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-audit-trace-identity-"));
  const driver = noCallDriver(TEST_PROFILE_ID);
  try {
    await seedTerminalAuditRows(outputDir, driver, (identity) => ({
      ...identity,
      taskId: "forged-task",
    }));

    await assert.rejects(
      () => runTrapAudit({ driver, outputDir }),
      /invalid trace evidence/,
    );
    assert.equal(driver.calls, 0);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("runTrapAudit rejects a checkpoint final state that disagrees with its trace", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-audit-trace-state-"));
  const driver = noCallDriver(TEST_PROFILE_ID);
  try {
    await seedTerminalAuditRows(outputDir, driver);
    const checkpointDir = path.join(outputDir, "checkpoints");
    const [checkpointName] = await readdir(checkpointDir);
    assert.ok(checkpointName);
    const checkpointPath = path.join(checkpointDir, checkpointName);
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as {
      terminal?: RepeatedFailureEpisode;
      tries?: { outcome?: { episode?: RepeatedFailureEpisode } }[];
    };
    assert.ok(checkpoint.terminal);
    checkpoint.terminal.finalState = "TRAPPED";
    const attemptEpisode = checkpoint.tries?.at(-1)?.outcome?.episode;
    assert.ok(attemptEpisode);
    attemptEpisode.finalState = "TRAPPED";
    await writeFile(checkpointPath, JSON.stringify(checkpoint));

    await assert.rejects(
      () => runTrapAudit({ driver, outputDir }),
      /invalid trace evidence/,
    );
    assert.equal(driver.calls, 0);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("runTrapAudit contains traversal and separator profile IDs in one sanitized filename", async () => {
  for (const profileId of ["model/../../../escaped-audit", "model/name\\variant"]) {
    const outputDir = await mkdtemp(path.join(tmpdir(), "h6-audit-filename-"));
    const driver = noCallDriver(profileId);
    try {
      await seedTerminalAuditRows(outputDir, driver);
      await runTrapAudit({ driver, outputDir });
      const expectedFilename =
        `trap-audit-${sanitizeFilenameSegment(profileId)}-${driver.modelProfileHash}.json`;
      const entries = await readdir(outputDir, { withFileTypes: true });
      const auditEntries = entries.filter((entry) => entry.name.startsWith("trap-audit"));

      assert.deepEqual(auditEntries.map((entry) => entry.name), [expectedFilename]);
      assert.equal(auditEntries[0]?.isFile(), true);
      const saved = JSON.parse(await readFile(path.join(outputDir, expectedFilename), "utf8")) as {
        modelProfileId?: unknown;
      };
      assert.equal(saved.modelProfileId, profileId);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  }
});

test("runTrapAudit rejects a symlink at the contained artifact path", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-audit-symlink-"));
  const protectedDir = await mkdtemp(path.join(tmpdir(), "h6-audit-protected-"));
  const driver = noCallDriver(TEST_PROFILE_ID);
  const protectedFile = path.join(protectedDir, "protected.json");
  try {
    await seedTerminalAuditRows(outputDir, driver);
    await writeFile(protectedFile, "preserve");
    const filename =
      `trap-audit-${sanitizeFilenameSegment(driver.modelProfileId)}-${driver.modelProfileHash}.json`;
    await symlink(protectedFile, path.join(outputDir, filename));

    await assert.rejects(
      () => runTrapAudit({ driver, outputDir }),
      /symbolic link path is not allowed/,
    );
    assert.equal(await readFile(protectedFile, "utf8"), "preserve");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
    await rm(protectedDir, { recursive: true, force: true });
  }
});

test("runTrapAudit rejects a symlinked parent component before checkpoint access", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "h6-audit-parent-symlink-"));
  const protectedDir = path.join(root, "protected");
  const linkedParent = path.join(root, "linked-parent");
  const driver = noCallDriver(TEST_PROFILE_ID);
  try {
    await mkdir(protectedDir);
    await symlink(protectedDir, linkedParent, "dir");
    await assert.rejects(
      () => runTrapAudit({ driver, outputDir: path.join(linkedParent, "audit") }),
      /symbolic link path is not allowed/,
    );
    assert.equal(driver.calls, 0);
    assert.deepEqual(await readdir(protectedDir), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
