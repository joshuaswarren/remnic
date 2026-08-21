import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_EVAL_TRAJECTORY_OUTCOME_WINDOW_MS,
  type EvalActionInput,
  type EvalOutcomeInput,
  type EvalTrajectoryReport,
  buildEvalTrajectoryReport,
  createSyntheticEvalTrajectoryReader,
  deriveUnifiedMemoryPromotionReport,
  readEvalTrajectoryReport,
  serializeEvalTrajectoryReport,
  validateEvalTrajectoryReport,
  writeEvalTrajectoryReport,
} from "./eval-trajectory.js";

/**
 * Issue #2345 — focused behavior tests for the offline trajectory evaluator.
 * Made-up fixtures only. Every test pins one rule from the issue contract:
 * input rejection, digest stability, join precedence, time-window boundaries,
 * namespace isolation, missing/late/future/ambiguous semantics, metric
 * boundaries, stale-use proof, trust flags, redaction, determinism, and the
 * checked reader.
 */

const NAMESPACE = "test-ns";
const AS_OF = "2026-08-15T00:00:00.000Z";
const SALT = "unit-test-salt";
const ACTION_AT = "2026-08-10T00:00:00.000Z";

function action(overrides: Partial<EvalActionInput> = {}): EvalActionInput {
  return {
    schemaVersion: 1,
    actionId: "act-1",
    namespace: NAMESPACE,
    actionAt: ACTION_AT,
    action: "store_note",
    immediateStatus: "applied",
    ...overrides,
  };
}

function outcome(overrides: Partial<EvalOutcomeInput> = {}): EvalOutcomeInput {
  return {
    schemaVersion: 1,
    namespace: NAMESPACE,
    outcomeId: "out-1",
    outcomeAt: "2026-08-12T00:00:00.000Z",
    source: "eval_artifact",
    result: "success",
    actionId: "act-1",
    ...overrides,
  };
}

function buildReport(
  actions: unknown[],
  outcomes: unknown[] = [],
  config?: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): EvalTrajectoryReport {
  return buildEvalTrajectoryReport({
    namespace: NAMESPACE,
    asOf: AS_OF,
    salt: SALT,
    actions,
    outcomes,
    config,
    ...extra,
  });
}

test("actions without a stable actionId are rejected, never dropped silently", () => {
  const report = buildReport([
    { ...action(), actionId: "" },
    { ...action(), actionId: undefined },
  ]);
  assert.equal(report.rejectionCounts.missing_action_id, 2);
  assert.equal(report.rows.length, 0);
});

test("action digests are stable per (namespace, actionId) and differ across either", () => {
  const base = buildReport([action()]);
  const same = buildReport([action()]);
  const otherId = buildReport([action({ actionId: "act-2" })]);
  const otherNs = buildEvalTrajectoryReport({
    namespace: "other-ns",
    asOf: AS_OF,
    salt: SALT,
    actions: [action({ namespace: "other-ns" })],
  });
  const digest = (r: EvalTrajectoryReport) => r.rows[0]?.actionDigest;
  assert.equal(digest(base), digest(same));
  assert.notEqual(digest(base), digest(otherId));
  assert.notEqual(digest(base), digest(otherNs));
});

test("explicit actionId beats trajectory and session-key fallback joins", () => {
  const report = buildReport(
    [action({ sessionKey: "agent:main", trajectoryId: "traj-1" })],
    [
      outcome({ outcomeId: "explicit", result: "success" }),
      outcome({ outcomeId: "session-fallback", result: "failure", actionId: undefined, sessionKey: "agent:main" }),
      outcome({
        outcomeId: "traj-fallback",
        result: "partial",
        actionId: undefined,
        trajectoryId: "traj-1",
        sessionKey: undefined,
      }),
    ]
  );
  const row = report.rows[0];
  assert.equal(row?.status, "joined");
  assert.equal(row?.join, "action_id");
  assert.equal(row?.taskOutcome, 1);
  assert.equal(report.aggregates.metricMeans.taskOutcome, 1);
});

test("memory outcomes require exact (namespace, sessionKey, memoryId) scope", () => {
  const report = buildReport(
    [action({ sessionKey: "agent:main", memoryId: "mem-1", contextTokensAfter: 100, contextTokenBudget: 1000 })],
    [
      outcome({
        outcomeId: "m1",
        source: "memory_outcome",
        result: "success",
        actionId: undefined,
        memoryId: "mem-1",
        sessionKey: "agent:main",
      }),
    ]
  );
  const row = report.rows[0];
  assert.equal(row?.status, "joined");
  assert.equal(row?.join, "memory_scope");
  // Memory success never becomes task success.
  assert.equal(row?.taskOutcome, null);
  assert.equal(row?.actionConditionedUtility, null);
  assert.deepEqual(row?.missingDimensions, ["taskOutcome"]);
});

test("duplicate candidates at the same join priority become ambiguous", () => {
  const report = buildReport(
    [action()],
    [outcome({ outcomeId: "a", result: "success" }), outcome({ outcomeId: "b", result: "failure" })]
  );
  const row = report.rows[0];
  assert.equal(row?.status, "ambiguous");
  assert.equal(row?.join, "action_id");
  assert.equal(row?.outcomeDigest, null);
  assert.equal(row?.actionConditionedUtility, null);
  assert.equal(report.aggregates.coverage.ambiguous, 1);
  assert.equal(report.aggregates.metricMeans.taskOutcome, null);
});

test("time window is half-open: action time excluded, window end excluded, asOf included", () => {
  const windowMs = 2 * 24 * 60 * 60 * 1000;
  const atActionTime = buildReport(
    [action({ actionId: "t0" })],
    [outcome({ outcomeId: "o0", actionId: "t0", outcomeAt: ACTION_AT })],
    { outcomeWindowMs: windowMs }
  );
  assert.equal(atActionTime.rows[0]?.status, "missing_within_window");

  const atWindowEnd = buildReport(
    [action({ actionId: "t1" })],
    [outcome({ outcomeId: "o1", actionId: "t1", outcomeAt: "2026-08-12T00:00:00.000Z" })],
    { outcomeWindowMs: windowMs }
  );
  assert.equal(atWindowEnd.rows[0]?.status, "late_outcome");

  const atAsOf = buildReport(
    [action({ actionId: "t2" })],
    [outcome({ outcomeId: "o2", actionId: "t2", outcomeAt: AS_OF })],
    { outcomeWindowMs: DEFAULT_EVAL_TRAJECTORY_OUTCOME_WINDOW_MS }
  );
  assert.equal(atAsOf.rows[0]?.status, "joined");
});

test("future outcomes are reported, never matched, and excluded from means and reach", () => {
  const report = buildReport(
    [action({ actionId: "f1" }), action({ actionId: "f2" })],
    [
      outcome({ outcomeId: "future", actionId: "f1", outcomeAt: "2026-08-15T00:00:00.001Z", result: "success" }),
      outcome({ outcomeId: "joined", actionId: "f2", outcomeAt: "2026-08-12T00:00:00.000Z", result: "failure" }),
    ]
  );
  const statuses = report.rows.map((row) => row.status).sort();
  assert.deepEqual(statuses, ["future_outcome", "joined"]);
  const futureRow = report.rows.find((row) => row.status === "future_outcome");
  assert.equal(futureRow?.outcomeDigest, null);
  assert.equal(futureRow?.taskOutcome, null);
  // reach denominator drops the future row: joined / (2 - 1) = 1.
  assert.equal(report.aggregates.coverage.reach, 1);
});

test("late outcomes stay in the file but outside the means", () => {
  const report = buildReport(
    [action()],
    [outcome({ outcomeId: "late", outcomeAt: "2026-08-14T23:59:59.999Z", result: "success" })],
    { outcomeWindowMs: 60 * 60 * 1000 }
  );
  const row = report.rows[0];
  assert.equal(row?.status, "late_outcome");
  assert.equal(row?.taskOutcome, 1);
  assert.equal(row?.actionConditionedUtility, null);
  assert.equal(report.aggregates.statusCounts.late_outcome, 1);
  assert.equal(report.aggregates.metricMeans.taskOutcome, null);
  assert.equal(report.aggregates.coverage.lateOutcome, 1);
});

test("missing outcomes are not failures and stay out of the means", () => {
  const report = buildReport([action()]);
  const row = report.rows[0];
  assert.equal(row?.status, "missing_within_window");
  assert.equal(row?.taskOutcome, null);
  assert.equal(row?.actionConditionedUtility, null);
  assert.deepEqual(row?.missingDimensions, ["taskOutcome", "contextTokenCost"]);
  assert.equal(report.aggregates.metricMeans.taskOutcome, null);
  // Missing rows count in the reach denominator.
  assert.equal(report.aggregates.coverage.reach, 0);
});

test("cross-namespace rows are rejected as namespace_mismatch", () => {
  const report = buildReport(
    [action(), action({ namespace: "other-ns" })],
    [outcome(), outcome({ namespace: "other-ns", outcomeId: "o-2" })]
  );
  assert.equal(report.rejectionCounts.namespace_mismatch, 2);
  assert.equal(report.sourceCounts.actions, 1);
  assert.equal(report.sourceCounts.outcomes, 1);
});

test("task scores map success=1, partial=0.5, failure=0", () => {
  for (const [result, expected] of [
    ["success", 1],
    ["partial", 0.5],
    ["failure", 0],
  ] as const) {
    const report = buildReport([action({ actionId: `s-${result}` })], [outcome({ actionId: `s-${result}`, result })]);
    assert.equal(report.rows[0]?.taskOutcome, expected, result);
  }
});

test("context token cost is clamp01(after / max(1, budget)) and overflow saturates at 1", () => {
  const half = buildReport(
    [action({ actionId: "c1", contextTokensBefore: 100, contextTokensAfter: 400, contextTokenBudget: 800 })],
    [outcome()]
  );
  assert.equal(half.rows[0]?.contextTokenCost, 0.5);

  const overflow = buildReport(
    [action({ actionId: "c2", contextTokensAfter: 1000, contextTokenBudget: 800, contextOverflow: true })],
    [outcome()]
  );
  assert.equal(overflow.rows[0]?.contextTokenCost, 1);
});

test("zero token budget rejects the row; missing tokens file missing_context_cost", () => {
  const rejected = buildReport([action({ actionId: "z1", contextTokensAfter: 10, contextTokenBudget: 0 })]);
  assert.equal(rejected.rejectionCounts.invalid_context_budget, 1);
  assert.equal(rejected.rows.length, 0);

  const missing = buildReport([action()], [outcome()]);
  assert.deepEqual(missing.rows[0]?.missingDimensions, ["contextTokenCost"]);
  assert.equal(missing.rows[0]?.actionConditionedUtility, null);
});

test("utility clamps to [-1, 1]", () => {
  const report = buildReport(
    [action({ actionId: "clamp", policyDecision: "deny" })],
    [outcome({ actionId: "clamp", result: "failure" })],
    { weights: { task: 1, context: 0, trust: 5, stale: 0 } }
  );
  assert.equal(report.rows[0]?.trustViolation, 1);
  assert.equal(report.rows[0]?.actionConditionedUtility, -1);
});

test("trust violations flag applied-deny, replay mismatch, missing guard, and outside eligibility", () => {
  const flags: Array<Partial<EvalActionInput>> = [
    { policyDecision: "deny" },
    { replayMismatch: true },
    { missingReversibleGuard: true },
    { outsideEligibility: true },
  ];
  for (const flag of flags) {
    const report = buildReport([action({ ...flag, actionId: JSON.stringify(flag) })]);
    assert.equal(report.rows[0]?.trustViolation, 1, JSON.stringify(flag));
  }
  // Immediate failure alone is an operation status, not a trust violation.
  const failed = buildReport([action({ actionId: "failed-only", immediateStatus: "failed" })]);
  assert.equal(failed.rows[0]?.trustViolation, 0);
});

test("stale-memory harm requires lifecycle, use-after-action, and an outcome value", () => {
  const evidence = (overrides: Record<string, unknown>) => ({
    schemaVersion: 1,
    namespace: NAMESPACE,
    actionId: "act-1",
    memoryId: "mem-1",
    lifecycleState: "stale",
    usedAt: "2026-08-13T00:00:00.000Z",
    outcome: "failure",
    ...overrides,
  });
  const full = buildReport([action()], [outcome()], undefined, { staleUseEvidence: [evidence({})] });
  assert.equal(full.rows[0]?.staleMemoryHarm, 1);

  const partialProof = buildReport([action()], [outcome()], undefined, {
    staleUseEvidence: [evidence({ outcome: "unknown" })],
  });
  assert.equal(partialProof.rows[0]?.staleMemoryHarm, 0.5);

  for (const [label, override] of [
    ["active lifecycle", { lifecycleState: "active" }],
    ["use before action", { usedAt: ACTION_AT }],
    ["no evidence", null],
  ] as const) {
    const report = buildReport([action()], [outcome()], undefined, {
      staleUseEvidence: override === null ? [] : [evidence(override)],
    });
    assert.equal(report.rows[0]?.staleMemoryHarm, 0, label);
  }
});

test("maxRows truncates deterministically and counts the overflow", () => {
  const actions = Array.from({ length: 4 }, (_, i) => action({ actionId: `act-${i}` }));
  const report = buildReport(actions, [], { maxRows: 2 });
  assert.equal(report.rows.length, 2);
  assert.equal(report.rejectionCounts.max_rows_exceeded, 2);
});

test("bad run-level config fails before any evaluation", () => {
  for (const config of [
    { outcomeWindowMs: 0 },
    { outcomeWindowMs: 1.5 },
    { maxFutureSkewMs: -1 },
    { maxRows: 0 },
    { weights: { task: -1, context: 0, trust: 0, stale: 0 } },
    { weights: { task: 0, context: 0, trust: 0, stale: 0 } },
  ]) {
    assert.throws(() => buildReport([action()], [outcome()], config), Error, JSON.stringify(config));
  }
});

test("redaction fails closed for every forbidden field", () => {
  const report = buildReport([action()], [outcome()]);
  for (const key of [
    "actionId",
    "memoryId",
    "trajectoryId",
    "outcomeId",
    "sessionKey",
    "namespace",
    "salt",
    "prompt",
    "promptHash",
    "inputSummary",
    "actionSummary",
    "goal",
    "summary",
    "content",
    "filePath",
  ]) {
    const poisoned = { ...structuredClone(report), [key]: "leak" } as Record<string, unknown>;
    assert.throws(() => validateEvalTrajectoryReport(poisoned), new RegExp(`'${key}'`), key);
  }
});

test("reordered and repeated inputs produce byte-identical output and identical fingerprints", () => {
  const actions = Array.from({ length: 5 }, (_, i) => action({ actionId: `act-${i}`, sessionKey: "agent:main" }));
  const outcomes = Array.from({ length: 5 }, (_, i) =>
    outcome({
      outcomeId: `out-${i}`,
      actionId: `act-${i}`,
      sessionKey: "agent:main",
      result: i % 2 === 0 ? "success" : "partial",
    })
  );
  const first = buildReport(actions, outcomes);
  const second = buildReport([...actions].reverse(), [...outcomes].reverse());
  const third = buildReport([...actions].reverse(), outcomes);
  assert.equal(serializeEvalTrajectoryReport(first), serializeEvalTrajectoryReport(second));
  assert.equal(serializeEvalTrajectoryReport(first), serializeEvalTrajectoryReport(third));
  assert.equal(first.inputFingerprint, second.inputFingerprint);
  assert.equal(first.reportId, second.reportId);
  assert.equal(first.contentHash, second.contentHash);
});

test("rows with duplicate sort keys produce identical output across invocations", () => {
  const actions = Array.from({ length: 6 }, (_, i) => action({ actionId: `same-time-${i}` }));
  const outcomes = Array.from({ length: 6 }, (_, i) =>
    outcome({ outcomeId: `same-time-out-${i}`, actionId: `same-time-${i}` })
  );
  const first = serializeEvalTrajectoryReport(buildReport(actions, outcomes));
  const second = serializeEvalTrajectoryReport(buildReport([...actions].reverse(), [...outcomes].reverse()));
  assert.equal(first, second);
});

test("report write, checked read, tamper rejection, and expiry", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "eval-trajectory-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const report = buildReport([action()], [outcome()]);
  const targetPath = await writeEvalTrajectoryReport({ evalStoreDir: dir, report });
  assert.equal(targetPath, path.join(dir, "trajectory", AS_OF.slice(0, 10), `${report.reportId}.json`));
  assert.equal(await readFile(targetPath, "utf8"), serializeEvalTrajectoryReport(report));

  const readBack = await readEvalTrajectoryReport({ reportPath: targetPath, now: AS_OF });
  assert.equal(readBack.reportId, report.reportId);

  // Tampered field → contentHash mismatch.
  const poisoned = JSON.parse(await readFile(targetPath, "utf8")) as Record<string, unknown>;
  poisoned.sourceCounts = { actions: 99, outcomes: 1, staleUseEvidence: 0 };
  await writeFile(targetPath, JSON.stringify(poisoned), "utf8");
  await assert.rejects(() => readEvalTrajectoryReport({ reportPath: targetPath, now: AS_OF }), /contentHash/);

  // Consistent contentHash but aggregates disagree with rows → still rejected.
  const { contentHash: _originalHash, ...rest } = JSON.parse(serializeEvalTrajectoryReport(report)) as Record<
    string,
    unknown
  > & { contentHash: string };
  const tamperedContent = { ...rest, aggregates: { ...(rest.aggregates as object), rowCount: 42 } };
  // Honest hash over the tampered content so the hash check passes and the
  // aggregate-recompute check is what rejects the report.
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : typeof value === "object" && value !== null
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, v]) => [k, sorted(v)])
          )
        : value;
  const asJson: Record<string, unknown> = {
    ...tamperedContent,
    contentHash: createHash("sha256")
      .update(JSON.stringify(sorted(tamperedContent)))
      .digest("hex"),
  };
  const mismatchedAggregates = path.join(dir, "tampered.json");
  await writeFile(mismatchedAggregates, JSON.stringify(asJson), "utf8");
  await assert.rejects(() => readEvalTrajectoryReport({ reportPath: mismatchedAggregates, now: AS_OF }), /aggregates/);

  // Restore the untampered bytes, then exercise expiry independently.
  await writeFile(targetPath, serializeEvalTrajectoryReport(report), "utf8");
  await assert.rejects(
    () => readEvalTrajectoryReport({ reportPath: targetPath, now: "2026-09-30T00:00:00.000Z" }),
    /expired/
  );
  await assert.rejects(
    () => readEvalTrajectoryReport({ reportPath: targetPath, now: "2026-08-14T00:00:00.000Z" }),
    /after now/
  );
});

test("synthetic reader feeds the builder without touching live stores", async () => {
  const reader = createSyntheticEvalTrajectoryReader({
    actions: [action()],
    outcomes: [outcome()],
    staleUseEvidence: [],
  });
  const rows = await reader({ trustedPrincipal: "operator", resolvedNamespace: NAMESPACE, asOf: AS_OF });
  const report = buildReport(rows.actions, rows.outcomes);
  assert.equal(report.rows[0]?.status, "joined");
});

test("promotion states fail safe: safety fault, insufficient evidence, destructive, reversible", () => {
  const manyActions = Array.from({ length: 40 }, (_, i) =>
    action({ actionId: `act-${i}`, contextTokensAfter: 100, contextTokenBudget: 1000 })
  );
  const manyOutcomes = manyActions.map((a) =>
    outcome({ outcomeId: `out-${a.actionId}`, actionId: a.actionId, result: "success" })
  );

  const healthy = deriveUnifiedMemoryPromotionReport(buildReport(manyActions, manyOutcomes));
  assert.equal(healthy.state, "active_reversible_eligible");
  assert.deepEqual(healthy.reasons, []);

  const safetyFault = deriveUnifiedMemoryPromotionReport(
    buildReport(
      manyActions.map((a) => ({ ...a, policyDecision: "deny" as const })),
      manyOutcomes
    )
  );
  assert.equal(safetyFault.state, "demote_to_shadow");
  assert.deepEqual(safetyFault.reasons, ["safety_fault_present"]);

  const thin = deriveUnifiedMemoryPromotionReport(buildReport([action()], [outcome()]));
  assert.equal(thin.state, "insufficient_evidence");
  assert.deepEqual(thin.reasons, ["insufficient_joined_rows"]);

  const destructive = deriveUnifiedMemoryPromotionReport(
    buildReport(
      manyActions.map((a) => ({ ...a, action: "discard" as const })),
      manyOutcomes
    )
  );
  assert.equal(destructive.state, "active_destructive_review_only");
  assert.deepEqual(destructive.reasons, ["destructive_actions_present"]);

  const noUtility = deriveUnifiedMemoryPromotionReport(
    buildReport(
      manyActions,
      manyActions.map((a) =>
        outcome({
          outcomeId: `mem-out-${a.actionId}`,
          actionId: a.actionId,
          source: "memory_outcome",
          result: "success",
        })
      )
    )
  );
  assert.equal(noUtility.state, "shadow_eligible");
  assert.deepEqual(noUtility.reasons, ["utility_mean_unavailable"]);
});

test("promotion report round-trips and carries the source fingerprint", () => {
  const report = buildReport([action()], [outcome()]);
  const promotion = deriveUnifiedMemoryPromotionReport(report);
  assert.equal(promotion.sourceReportId, report.reportId);
  assert.equal(promotion.inputFingerprint, report.inputFingerprint);
  const roundTripped = JSON.parse(JSON.stringify(promotion));
  assert.equal(roundTripped.schemaVersion, 1);
  assert.equal(roundTripped.state, promotion.state);
});
