import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RepeatedFailureEpisodeRow, RepeatedFailureArm } from "./repeated-failure-types.js";
import type { FactPairAuditPair } from "./repeated-failure-suite-shared.js";
import type { TimingPayload } from "./repeated-failure-suite-execution.js";
import {
  buildTimingEvidenceAudit,
  writeTrace,
  type TimingEvidenceSourceRow,
} from "./repeated-failure-suite-output.js";

const pair: FactPairAuditPair = {
  pairKey: "pair-1",
  taskId: "task-1",
  variantId: "variant-1",
  seed: 1,
  modelProfileId: "profile-1",
  modelProfileHash: "a".repeat(64),
  tokenizerIdentity: "tokenizer-1",
  tokenizerImplementation: "nfkc-whitespace-v1",
  historyHash: "history-1",
  failureRepoHash: "failure-repo",
  successRepoHash: "success-repo",
  failureActionFingerprint: "failure-action",
  successActionFingerprint: "success-action",
  failurePathShapeHash: "failure-path",
  successPathShapeHash: "success-path",
  failureActionShapeHash: "failure-shape",
  successActionShapeHash: "success-shape",
  failureFactId: "fact-1",
  failureCitationHash: "citation-1",
  failureFactHash: "fact-hash-1",
  successFactHash: "success-hash-1",
  failureFactCount: 1,
  successFactCount: 1,
  failureTokens: 5,
  successTokens: 5,
  tokenGap: 0,
  relativeTokenGap: 0,
  jaccard: 1,
  status: "MATCHED",
};

const payload = (frame: TimingPayload["frame"]): TimingPayload => ({
  frame,
  factId: pair.failureFactId,
  citationHash: pair.failureCitationHash,
  factCount: 1,
  renderedTokenCount: 5,
});

function row(arm: RepeatedFailureArm, gateStatus: "NO_MATCH" | "MATCH_WARN"): RepeatedFailureEpisodeRow {
  return {
    schemaVersion: 1,
    rowKey: arm,
    identity: {
      suiteVersion: "suite-1",
      taskId: pair.taskId,
      variantId: pair.variantId,
      modelProfileId: pair.modelProfileId,
      modelProfileHash: pair.modelProfileHash,
      seed: pair.seed,
      arm,
    },
    status: "VALID",
    finalState: "UNFIXED",
    durationMs: 1,
    tokens: { input: 0, output: 0, total: 0, cachedInput: 0, cacheWriteInput: 0, reasoningOutput: 0 },
    tryCount: 1,
    evidence: {
      startRepoHash: "start-repo",
      startMemoryHash: "start-memory",
      historyHash: pair.historyHash,
      askedActionHash: "asked-action",
      traceArtifactPath: "traces/trace.json",
      traceArtifactHash: "trace-hash",
      gate: { status: gateStatus, fingerprintHash: "fingerprint" },
      actionExecuted: true,
      checkResult: "FAIL",
      repeatedFailure: false,
      taskPassed: false,
      steps: 1,
      warningCount: gateStatus === "MATCH_WARN" ? 1 : 0,
      falseWarningCount: 0,
      factPairAudit: "MATCHED",
      faults: [],
    },
  };
}

const baseline = {
  row: row("TURN_START_FAILURE", "NO_MATCH"),
  timingPayload: payload("TURN_START"),
  turnStartFactHash: pair.failureFactHash,
  preActionFailureFactHash: null,
};

const preAction = (gateStatus: "NO_MATCH" | "MATCH_WARN") => ({
  row: row("PRE_ACTION_FAILURE", gateStatus),
  timingPayload: payload("PRE_ACTION"),
  turnStartFactHash: null,
  preActionFailureFactHash: pair.failureFactHash,
});

test("timing audit reports a non-warning pre-action row as uninjected", () => {
  const audit = buildTimingEvidenceAudit([pair], [baseline, preAction("NO_MATCH")]);
  assert.equal(audit.rows[0]?.status, "UNINJECTED");
  assert.equal(audit.rows[0]?.matches, null);
  assert.equal(audit.injectedPairCount, 0);
  assert.equal(audit.uninjectedPairCount, 1);
  assert.equal(audit.allMatched, false);
});

test("timing audit permits uninjected cells when another pair proves a matched injection", () => {
  const secondPair = { ...pair, pairKey: "pair-2", taskId: "task-2" };
  const forSecondTask = (source: TimingEvidenceSourceRow): TimingEvidenceSourceRow => ({
    ...source,
    row: {
      ...source.row,
      identity: { ...source.row.identity, taskId: secondPair.taskId },
    },
  });
  const audit = buildTimingEvidenceAudit(
    [pair, secondPair],
    [
      baseline,
      preAction("MATCH_WARN"),
      forSecondTask(baseline),
      forSecondTask(preAction("NO_MATCH")),
    ],
  );
  assert.equal(audit.injectedPairCount, 1);
  assert.equal(audit.uninjectedPairCount, 1);
  assert.equal(audit.allMatched, true);
});

test("timing audit keeps a missing turn-start payload as a mismatch", () => {
  const audit = buildTimingEvidenceAudit([pair], [preAction("NO_MATCH")]);
  assert.equal(audit.rows[0]?.status, "MISMATCH");
  assert.equal(audit.rows[0]?.matches, false);
  assert.equal(audit.allMatched, false);
});

test("timing audit compares payloads only after a warning injection", () => {
  const candidate = preAction("MATCH_WARN");
  candidate.timingPayload = { ...candidate.timingPayload, renderedTokenCount: 6 };
  const audit = buildTimingEvidenceAudit([pair], [baseline, candidate]);
  assert.equal(audit.rows[0]?.status, "MISMATCH");
  assert.equal(audit.injectedPairCount, 1);
  assert.equal(audit.allMatched, false);
});

test("timing audit rejects same-history rows from a different paired identity", () => {
  const foreignBaseline = {
    ...baseline,
    row: {
      ...baseline.row,
      identity: { ...baseline.row.identity, taskId: "task-foreign" },
    },
  };
  const candidate = preAction("MATCH_WARN");
  const foreignCandidate = {
    ...candidate,
    row: {
      ...candidate.row,
      identity: { ...candidate.row.identity, taskId: "task-foreign" },
    },
  };
  const audit = buildTimingEvidenceAudit([pair], [foreignBaseline, foreignCandidate]);
  assert.equal(audit.rows[0]?.status, "MISMATCH");
  assert.equal(audit.rows[0]?.turnStartRowKey, null);
  assert.equal(audit.rows[0]?.preActionRowKey, null);
  assert.equal(audit.allMatched, false);
});

test("trace writes reject symlinked parent directories", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-trace-output-"));
  const outsideDir = await mkdtemp(path.join(tmpdir(), "h6-trace-outside-"));
  try {
    await mkdir(outsideDir, { recursive: true });
    await symlink(outsideDir, path.join(outputDir, "traces"), "dir");
    await assert.rejects(
      () => writeTrace(outputDir, "row-1", 1, { status: "test" }),
      /symbolic link path is not allowed/,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});
