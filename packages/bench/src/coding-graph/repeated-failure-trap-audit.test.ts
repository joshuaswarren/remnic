import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  computeTrapAuditMetrics,
  computeTrapAuditArtifactHash,
  verifyTrapAuditArtifact,
  verifyMatchingTrapAudit,
  type RepeatedFailureTrapAuditRow,
  type RepeatedFailureTrapAuditArtifact,
} from "./repeated-failure-trap-audit.js";
import { PROMPT_CONTRACT, runRepeatedFailureSuite } from "./repeated-failure-suite.js";
import type { RepeatedFailureEpisodeDriver } from "./repeated-failure-types.js";
import { parseBenchCodingArgs } from "../../../remnic-cli/src/bench-coding-commands.js";

const TEST_PROFILE_ID = "test-model-v1";
const TEST_PROFILE_HASH = "a".repeat(64);
const TEST_DATASET_HASH = "b".repeat(64);
const TEST_HARNESS_HASH = "c".repeat(64);

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

  const metrics = computeTrapAuditMetrics(rows, 30);
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
    datasetInventoryHash: TEST_DATASET_HASH,
    harnessSourceHash: TEST_HARNESS_HASH,
    passed: metrics.passed,
    metrics,
    rows,
  };
  const artifactHash = computeTrapAuditArtifactHash(payload);
  const artifact: RepeatedFailureTrapAuditArtifact = { ...payload, artifactHash };

  const verification = verifyTrapAuditArtifact(artifact, {
    modelProfileId: TEST_PROFILE_ID,
    modelProfileHash: TEST_PROFILE_HASH,
    datasetInventoryHash: TEST_DATASET_HASH,
    harnessSourceHash: TEST_HARNESS_HASH,
  });
  assert.equal(verification.valid, true, verification.error);
});

test("computeTrapAuditMetrics: 14/30 trapped fails audit", () => {
  // 14 TRAPPED, 10 UNFIXED, 6 FIXED = 30 tasks
  const rows: RepeatedFailureTrapAuditRow[] = [];
  for (let i = 1; i <= 14; i++) {
    rows.push(makeDummyRow(`task-${i}`, "TRAPPED"));
  }
  for (let i = 15; i <= 24; i++) {
    rows.push(makeDummyRow(`task-${i}`, "UNFIXED"));
  }
  for (let i = 25; i <= 30; i++) {
    rows.push(makeDummyRow(`task-${i}`, "FIXED"));
  }

  const metrics = computeTrapAuditMetrics(rows, 30);
  assert.equal(metrics.trappedRate, 14 / 30);
  assert.equal(metrics.passed, false);
});

test("computeTrapAuditMetrics: 23/30 nonfixed fails audit", () => {
  // 15 TRAPPED, 8 UNFIXED, 7 FIXED = 30 tasks
  const rows: RepeatedFailureTrapAuditRow[] = [];
  for (let i = 1; i <= 15; i++) {
    rows.push(makeDummyRow(`task-${i}`, "TRAPPED"));
  }
  for (let i = 16; i <= 23; i++) {
    rows.push(makeDummyRow(`task-${i}`, "UNFIXED"));
  }
  for (let i = 24; i <= 30; i++) {
    rows.push(makeDummyRow(`task-${i}`, "FIXED"));
  }

  const metrics = computeTrapAuditMetrics(rows, 30);
  assert.equal(metrics.nonFixedRate, 23 / 30);
  assert.equal(metrics.passed, false);
});

test("verifyTrapAuditArtifact: rejects tampered artifact or drift", () => {
  const rows: RepeatedFailureTrapAuditRow[] = [];
  for (let i = 1; i <= 15; i++) rows.push(makeDummyRow(`task-${i}`, "TRAPPED"));
  for (let i = 16; i <= 24; i++) rows.push(makeDummyRow(`task-${i}`, "UNFIXED"));
  for (let i = 25; i <= 30; i++) rows.push(makeDummyRow(`task-${i}`, "FIXED"));
  const metrics = computeTrapAuditMetrics(rows, 30);

  const payload: Omit<RepeatedFailureTrapAuditArtifact, "artifactHash"> = {
    schemaVersion: 1,
    modelProfileId: TEST_PROFILE_ID,
    modelProfileHash: TEST_PROFILE_HASH,
    datasetInventoryHash: TEST_DATASET_HASH,
    harnessSourceHash: TEST_HARNESS_HASH,
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
  assert.equal(verifyTrapAuditArtifact(tampered).valid, false);

  // Mismatched profile hash drift
  const drifted = verifyTrapAuditArtifact(artifact, {
    modelProfileId: TEST_PROFILE_ID,
    modelProfileHash: "d".repeat(64),
  });
  assert.equal(drifted.valid, false);
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
    const rows: RepeatedFailureTrapAuditRow[] = [];
    for (let i = 1; i <= 15; i++) rows.push(makeDummyRow(`task-${i}`, "TRAPPED"));
    for (let i = 16; i <= 24; i++) rows.push(makeDummyRow(`task-${i}`, "UNFIXED"));
    for (let i = 25; i <= 30; i++) rows.push(makeDummyRow(`task-${i}`, "FIXED"));
    const metrics = computeTrapAuditMetrics(rows, 30);

    const payload: Omit<RepeatedFailureTrapAuditArtifact, "artifactHash"> = {
      schemaVersion: 1,
      modelProfileId: TEST_PROFILE_ID,
      modelProfileHash: TEST_PROFILE_HASH,
      datasetInventoryHash: TEST_DATASET_HASH,
      harnessSourceHash: TEST_HARNESS_HASH,
      passed: true,
      metrics,
      rows,
    };
    const artifactHash = computeTrapAuditArtifactHash(payload);
    const artifact: RepeatedFailureTrapAuditArtifact = { ...payload, artifactHash };

    await writeFile(path.join(tmp, `trap-audit-${TEST_PROFILE_ID}.json`), JSON.stringify(artifact, null, 2));

    const found = await verifyMatchingTrapAudit(
      { id: TEST_PROFILE_ID, hash: TEST_PROFILE_HASH },
      TEST_DATASET_HASH,
      TEST_HARNESS_HASH,
      [tmp],
    );
    assert.equal(found.modelProfileId, TEST_PROFILE_ID);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
});
