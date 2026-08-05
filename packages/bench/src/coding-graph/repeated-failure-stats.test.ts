import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzeRepeatedFailureRows,
  decideRepeatedFailureContent,
  decideRepeatedFailureTiming,
  decideRepeatedFailureStudy,
  holmAdjust,
  isRepeatedFailureTimidityEquivalent,
  relativeRiskReduction,
  writeRepeatedFailureStatistics,
  type RepeatedFailureEffectAnalysis,
  type RepeatedFailureInterval,
} from "./repeated-failure-stats.ts";
import type {
  RepeatedFailureArm,
  RepeatedFailureEpisodeRow,
  RepeatedFailureExpectedDesign,
  RepeatedFailureRowIdentity,
} from "./repeated-failure-types.ts";

interface CellMetrics {
  repeatedFailure: boolean;
  taskPassed: boolean;
  steps?: number;
  status?: "VALID" | "INVALID";
  matched?: boolean;
}

function identity(taskId: string, arm: RepeatedFailureArm, seed = 1): RepeatedFailureRowIdentity {
  return {
    suiteVersion: "h6-v1",
    taskId,
    variantId: "variant-1",
    modelProfileId: "model-profile-a",
    modelProfileHash: "c".repeat(64),
    seed,
    arm,
  };
}
const TOKEN_USAGE = {
  input: 1,
  output: 1,
  total: 2,
  cachedInput: 0,
  cacheWriteInput: 0,
  reasoningOutput: 0,
};

function row(taskId: string, arm: RepeatedFailureArm, metrics: CellMetrics, seed = 1): RepeatedFailureEpisodeRow {
  const rowIdentity = identity(taskId, arm, seed);
  if (metrics.status === "INVALID") {
    return {
      schemaVersion: 1,
      rowKey: `${taskId}-${arm}-${seed}`,
      identity: rowIdentity,
      status: "INVALID",
      finalState: "INVALID",
      invalidReason: "TRACE_GAP",
      durationMs: 1,
      tokens: { ...TOKEN_USAGE },
      tryCount: 1,
    };
  }
  return {
    schemaVersion: 1,
    rowKey: `${taskId}-${arm}-${seed}`,
    identity: rowIdentity,
    status: "VALID",
    finalState: metrics.taskPassed ? "FIXED" : "TRAPPED",
    repeatedFailure: metrics.repeatedFailure,
    taskPassed: metrics.taskPassed,
    steps: metrics.steps ?? 4,
    warningCount: 0,
    falseWarningCount: 0,
    factPairAudit: metrics.matched === false ? "UNMATCHED" : "MATCHED",
    durationMs: 1,
    tokens: { ...TOKEN_USAGE },
    tryCount: 1,
  };
}

function designFor(rows: readonly RepeatedFailureEpisodeRow[]): RepeatedFailureExpectedDesign {
  return { rows: rows.map((entry) => entry.identity) };
}

function timingRows(
  taskId: string,
  baseline: CellMetrics,
  candidate: CellMetrics,
  seed = 1
): RepeatedFailureEpisodeRow[] {
  return [
    row(taskId, "TURN_START_FAILURE", baseline, seed),
    row(taskId, "PRE_ACTION_FAILURE", candidate, seed),
  ];
}

function contentRows(
  taskId: string,
  successMemory: CellMetrics,
  failureMemory: CellMetrics,
  seed = 1
): RepeatedFailureEpisodeRow[] {
  return [
    row(taskId, "TURN_START_SUCCESS", successMemory, seed),
    row(taskId, "TURN_START_FAILURE", failureMemory, seed),
  ];
}

function effect(overrides: Partial<RepeatedFailureEffectAnalysis> = {}): RepeatedFailureEffectAnalysis {
  const interval95: RepeatedFailureInterval = { lower: 0.01, upper: 0.2, level: 0.95 };
  return {
    taskCount: 30,
    baselineArm: "TURN_START_FAILURE",
    candidateArm: "PRE_ACTION_FAILURE",
    interpretation: "CONFIRMATORY",
    repeatedFailureBenefit: 0.1,
    repeatedFailureBenefitInterval: interval95,
    relativeRiskReduction: 0.3,
    relativeRiskReductionInterval: { lower: 0.01, upper: 0.5, level: 0.95 },
    nonEstimableRrrDraws: 0,
    repeatedFailureP: 0.01,
    taskPassBenefit: 0.1,
    taskPassBenefitInterval: interval95,
    taskPassP: 0.01,
    ...overrides,
  };
}

test("task means, not rows, are the statistical units", () => {
  const rows: RepeatedFailureEpisodeRow[] = [];
  for (let seed = 1; seed <= 10; seed += 1) {
    rows.push(...timingRows("many-cells", { repeatedFailure: true, taskPassed: false }, { repeatedFailure: false, taskPassed: true }, seed));
  }
  rows.push(...timingRows("one-cell", { repeatedFailure: false, taskPassed: true }, { repeatedFailure: true, taskPassed: false }));
  const analysis = analyzeRepeatedFailureRows(rows, { expectedDesign: designFor(rows), seed: 7, draws: 100 });
  assert.equal(analysis.timing.taskCount, 2);
  assert.equal(analysis.timing.repeatedFailureBenefit, 0);
  assert.equal(analysis.timing.taskPassBenefit, 0);
});

test("grouped bootstrap and shuffle are invariant to duplicated cells within a task", () => {
  const base = [
    ...timingRows("a", { repeatedFailure: true, taskPassed: false }, { repeatedFailure: false, taskPassed: true }),
    ...timingRows("b", { repeatedFailure: false, taskPassed: true }, { repeatedFailure: true, taskPassed: false }),
    ...timingRows("c", { repeatedFailure: true, taskPassed: false }, { repeatedFailure: false, taskPassed: true }),
  ];
  const duplicated = [...base];
  for (let seed = 2; seed <= 8; seed += 1) {
    duplicated.push(...timingRows("a", { repeatedFailure: true, taskPassed: false }, { repeatedFailure: false, taskPassed: true }, seed));
  }
  const first = analyzeRepeatedFailureRows(base, { expectedDesign: designFor(base), seed: 91, draws: 500 });
  const second = analyzeRepeatedFailureRows(duplicated, { expectedDesign: designFor(duplicated), seed: 91, draws: 500 });
  assert.equal(first.timing.repeatedFailureBenefit, second.timing.repeatedFailureBenefit);
  assert.equal(first.timing.repeatedFailureP, second.timing.repeatedFailureP);
});

test("fixed seed and 10,000 grouped draws are stable while another seed changes Monte Carlo output", () => {
  const rows: RepeatedFailureEpisodeRow[] = [];
  for (let task = 0; task < 12; task += 1) {
    rows.push(
      ...timingRows(
        `task-${task}`,
        { repeatedFailure: task % 3 !== 0, taskPassed: task % 4 === 0 },
        { repeatedFailure: task % 5 === 0, taskPassed: task % 2 === 0 }
      )
    );
  }
  const options = { expectedDesign: designFor(rows), seed: 123, draws: 10_000 } as const;
  const first = analyzeRepeatedFailureRows(rows, options);
  const second = analyzeRepeatedFailureRows([...rows].reverse(), options);
  assert.deepEqual(first, second);
  const differentSeed = analyzeRepeatedFailureRows(rows, { ...options, seed: 124 });
  assert.notDeepEqual(
    {
      interval: first.timing.repeatedFailureBenefitInterval,
      rrrInterval: first.timing.relativeRiskReductionInterval,
      p: first.timing.repeatedFailureP,
    },
    {
      interval: differentSeed.timing.repeatedFailureBenefitInterval,
      rrrInterval: differentSeed.timing.relativeRiskReductionInterval,
      p: differentSeed.timing.repeatedFailureP,
    }
  );
});

test("completeness cuts the whole task for a missing or invalid paired cell", () => {
  const complete = timingRows("complete", { repeatedFailure: true, taskPassed: false }, { repeatedFailure: false, taskPassed: true });
  const missingIdentity = identity("missing", "PRE_ACTION_FAILURE");
  const invalidBaseline = row("invalid", "TURN_START_FAILURE", {
    repeatedFailure: true,
    taskPassed: false,
  });
  const invalidCandidate = row("invalid", "PRE_ACTION_FAILURE", {
    repeatedFailure: false,
    taskPassed: false,
    status: "INVALID",
  });
  const rows = [...complete, invalidBaseline, invalidCandidate];
  const expectedDesign = {
    rows: [...rows.map((entry) => entry.identity), identity("missing", "TURN_START_FAILURE"), missingIdentity],
  };
  const analysis = analyzeRepeatedFailureRows(rows, { expectedDesign, seed: 3, draws: 100 });
  assert.equal(analysis.timing.taskCount, 1);
  assert.equal(analysis.decisions.timing, "NOT_ESTIMABLE");
  assert.equal(analysis.studyDecision, "NOT_ESTIMABLE");
  assert.equal(analysis.timing.repeatedFailureBenefit, 1);
  assert.equal(analysis.timing.interpretation, "EXPLORATORY_COMPLETE_TASKS");
  assert.ok(analysis.timing.repeatedFailureBenefitInterval);
  assert.deepEqual(
    analysis.cuts.filter((cut) => cut.hypothesis === "TIMING").map((cut) => cut.taskId),
    ["invalid", "missing"]
  );
  const missingCut = analysis.cuts.find(
    (cut) => cut.hypothesis === "TIMING" && cut.taskId === "missing"
  );
  const invalidCut = analysis.cuts.find(
    (cut) => cut.hypothesis === "TIMING" && cut.taskId === "invalid"
  );
  assert.ok(missingCut);
  assert.ok(invalidCut);
  assert.match(missingCut.reasons.join(","), /MISSING_ROW/);
  assert.match(invalidCut.reasons.join(","), /INVALID_ROW/);
});

test("content cuts an unmatched target/twin pair with a receipt", () => {
  const rows = contentRows(
    "unmatched",
    { repeatedFailure: true, taskPassed: false },
    { repeatedFailure: false, taskPassed: true, matched: false }
  );
  const analysis = analyzeRepeatedFailureRows(rows, { expectedDesign: designFor(rows), seed: 8, draws: 100 });
  assert.equal(analysis.content.taskCount, 0);
  assert.equal(analysis.content.nonEstimableRrrDraws, 0);
  const unmatchedCut = analysis.cuts.find((cut) => cut.hypothesis === "CONTENT");
  assert.ok(unmatchedCut);
  assert.match(unmatchedCut.reasons.join(","), /UNMATCHED_FACTS/);
  assert.equal(analysis.decisions.content, "NOT_ESTIMABLE");
});

test("relative risk reduction handles normal, candidate-zero, both-zero, and baseline-zero", () => {
  assert.equal(relativeRiskReduction(0.5, 0.25), 0.5);
  assert.equal(relativeRiskReduction(0.5, 0), 1);
  assert.equal(relativeRiskReduction(0, 0), null);
  assert.equal(relativeRiskReduction(0, 0.2), null);
});

test("baseline-zero grouped analysis reports null RRR and cannot support timing", () => {
  const rows = timingRows("zero", { repeatedFailure: false, taskPassed: true }, { repeatedFailure: false, taskPassed: true });
  const analysis = analyzeRepeatedFailureRows(rows, { expectedDesign: designFor(rows), seed: 5, draws: 100 });
  assert.equal(analysis.timing.relativeRiskReduction, null);
  assert.equal(analysis.timing.relativeRiskReductionInterval, null);
  assert.equal(analysis.timing.nonEstimableRrrDraws, 100);
  assert.equal(analysis.decisions.timing, "NOT_ESTIMABLE");
});

test("content task-pass benefit is candidate minus baseline and compound p is the worse endpoint", () => {
  const rows: RepeatedFailureEpisodeRow[] = [];
  for (let task = 0; task < 8; task += 1) {
    rows.push(
      ...contentRows(
        `content-${task}`,
        { repeatedFailure: true, taskPassed: false },
        { repeatedFailure: task === 0, taskPassed: task !== 0 }
      )
    );
    rows.push(
      row(`content-${task}`, "PRE_ACTION_FAILURE", {
        repeatedFailure: false,
        taskPassed: true,
      })
    );
  }
  const analysis = analyzeRepeatedFailureRows(rows, { expectedDesign: designFor(rows), seed: 12, draws: 400 });
  const taskPassBenefit = analysis.content.taskPassBenefit;
  const repeatedFailureP = analysis.content.repeatedFailureP;
  const taskPassP = analysis.content.taskPassP;
  assert.ok(taskPassBenefit !== null && taskPassBenefit > 0);
  assert.ok(repeatedFailureP !== null);
  assert.ok(taskPassP !== null);
  assert.equal(analysis.contentCompoundP, Math.max(repeatedFailureP, taskPassP));
  assert.deepEqual(analysis.holm.map((entry) => entry.id).sort(), ["CONTENT", "TIMING"].sort());
});

test("shuffle p-values use plus-one Monte Carlo correction", () => {
  const rows: RepeatedFailureEpisodeRow[] = [];
  for (let task = 0; task < 10; task += 1) {
    rows.push(...timingRows(`task-${task}`, { repeatedFailure: true, taskPassed: false }, { repeatedFailure: false, taskPassed: true }));
  }
  const draws = 127;
  const analysis = analyzeRepeatedFailureRows(rows, { expectedDesign: designFor(rows), seed: 1, draws });
  const p = analysis.timing.repeatedFailureP;
  assert.ok(p !== null);
  assert.ok(p >= 1 / (draws + 1));
  assert.equal(Number.isInteger(p * (draws + 1) - 1), true);
});

test("Holm adjustment is stable, monotone, clamped, tied by id, and returned in input order", () => {
  const adjusted = holmAdjust([
    { id: "CONTENT", p: 0.03 },
    { id: "TIMING", p: 0.01 },
  ]);
  assert.deepEqual(adjusted.map((entry) => entry.id), ["CONTENT", "TIMING"]);
  assert.deepEqual(adjusted.map((entry) => entry.adjustedP), [0.03, 0.02]);

  const tied = holmAdjust([
    { id: "TIMING", p: 0.02 },
    { id: "CONTENT", p: 0.02 },
  ]);
  const tiedContent = tied.find((entry) => entry.id === "CONTENT");
  const tiedTiming = tied.find((entry) => entry.id === "TIMING");
  assert.ok(tiedContent);
  assert.ok(tiedTiming);
  assert.equal(tiedContent.rank, 1);
  assert.equal(tiedTiming.rank, 2);
  assert.deepEqual(holmAdjust([{ id: "TIMING", p: 0.8 }, { id: "CONTENT", p: 0.9 }]).map((entry) => entry.adjustedP), [1, 1]);
});

test("timing support requires absolute and relative effect floors plus strict interval and p boundaries", () => {
  assert.equal(decideRepeatedFailureTiming(effect(), 0.049, 0.3, 0.05, 0, 0.05), "SUPPORTED");
  assert.equal(
    decideRepeatedFailureTiming(effect({ repeatedFailureBenefit: 0.0499 }), 0.049, 0.3, 0.05, 0, 0.05),
    "REJECTED",
  );
  assert.equal(decideRepeatedFailureTiming(effect({ relativeRiskReduction: 0.2999 }), 0.049, 0.3, 0.05, 0, 0.05), "REJECTED");
  assert.equal(decideRepeatedFailureTiming(effect({ repeatedFailureBenefitInterval: { lower: 0, upper: 0.2, level: 0.95 } }), 0.049, 0.3, 0.05, 0, 0.05), "REJECTED");
  assert.equal(decideRepeatedFailureTiming(effect(), 0.05, 0.3, 0.05, 0, 0.05), "REJECTED");
  assert.equal(decideRepeatedFailureTiming(effect({ repeatedFailureBenefitInterval: { lower: 0.01, upper: 0.2, level: 0.95 } }), 0.049, 0.3, 0.05, 0.01, 0.05), "REJECTED");
  assert.equal(decideRepeatedFailureTiming(effect({ relativeRiskReduction: null }), 0.01, 0.3, 0.05, 0, 0.05), "NOT_ESTIMABLE");
});

test("content support requires both positive endpoints and a strict adjusted p", () => {
  assert.equal(decideRepeatedFailureContent(effect(), 0.01, 0.049, 0, 0, 0.05), "SUPPORTED");
  assert.equal(decideRepeatedFailureContent(effect({ taskPassBenefitInterval: { lower: 0, upper: 0.2, level: 0.95 } }), 0.01, 0.049, 0, 0, 0.05), "REJECTED");
  assert.equal(decideRepeatedFailureContent(effect({ repeatedFailureBenefitInterval: { lower: -0.01, upper: 0.2, level: 0.95 } }), 0.01, 0.049, 0, 0, 0.05), "REJECTED");
  assert.equal(decideRepeatedFailureContent(effect(), 0.05, 0.05, 0, 0, 0.05), "REJECTED");
  assert.equal(decideRepeatedFailureContent(effect({ taskPassBenefitInterval: null }), null, undefined, 0, 0, 0.05), "NOT_ESTIMABLE");
});

test("study decision maps the two preregistered primary decisions", () => {
  assert.equal(decideRepeatedFailureStudy("SUPPORTED", "SUPPORTED"), "PASS");
  assert.equal(decideRepeatedFailureStudy("SUPPORTED", "REJECTED"), "PARTIAL");
  assert.equal(decideRepeatedFailureStudy("REJECTED", "SUPPORTED"), "PARTIAL");
  assert.equal(decideRepeatedFailureStudy("REJECTED", "REJECTED"), "REJECT");
  assert.equal(decideRepeatedFailureStudy("NOT_ESTIMABLE", "SUPPORTED"), "NOT_ESTIMABLE");
  assert.equal(decideRepeatedFailureStudy("SUPPORTED", "NOT_ESTIMABLE"), "NOT_ESTIMABLE");
});

test("timidity equivalence uses a 90% interval wholly inside both margins", () => {
  const inside = { lower: -0.019, upper: 0.019, level: 0.9 };
  const stepsInside = { lower: -1.9, upper: 1.9, level: 0.9 };
  assert.equal(isRepeatedFailureTimidityEquivalent(inside, stepsInside, 0.02, 2), true);
  assert.equal(isRepeatedFailureTimidityEquivalent({ ...inside, lower: -0.02 }, stepsInside, 0.02, 2), false);
  assert.equal(isRepeatedFailureTimidityEquivalent(inside, { ...stepsInside, upper: 2 }, 0.02, 2), false);
  assert.equal(isRepeatedFailureTimidityEquivalent({ ...inside, upper: 0.021 }, stepsInside, 0.02, 2), false);
  assert.equal(isRepeatedFailureTimidityEquivalent(inside, { ...stepsInside, lower: -2.1 }, 0.02, 2), false);
});

test("no-trap analysis reports separate timidity equivalence without Holm inclusion", () => {
  const rows: RepeatedFailureEpisodeRow[] = [];
  for (let task = 0; task < 5; task += 1) {
    rows.push(
      row(`benign-${task}`, "NO_MEMORY", { repeatedFailure: false, taskPassed: true, steps: 4 }),
      row(`benign-${task}`, "PRE_ACTION_FAILURE", { repeatedFailure: false, taskPassed: true, steps: 4 })
    );
  }
  const analysis = analyzeRepeatedFailureRows(rows, {
    expectedDesign: { rows: [] },
    timidityDesign: designFor(rows),
    seed: 55,
    draws: 200,
  });
  assert.equal(analysis.timidity.equivalent, true);
  assert.equal(analysis.timidity.intervalLevel, 0.9);
  assert.equal(analysis.holm.length, 0);
});

test("timidity decision is not estimable when any registered task is cut", () => {
  const rows = [
    row("complete", "NO_MEMORY", { repeatedFailure: false, taskPassed: true }),
    row("complete", "PRE_ACTION_FAILURE", { repeatedFailure: false, taskPassed: true }),
    row("missing", "NO_MEMORY", { repeatedFailure: false, taskPassed: true }),
  ];
  const analysis = analyzeRepeatedFailureRows(rows, {
    expectedDesign: { rows: [] },
    timidityDesign: {
      rows: [
        identity("complete", "NO_MEMORY"),
        identity("complete", "PRE_ACTION_FAILURE"),
        identity("missing", "NO_MEMORY"),
        identity("missing", "PRE_ACTION_FAILURE"),
      ],
    },
    seed: 55,
    draws: 20,
  });
  assert.ok(analysis.cuts.some(
    (cut) => cut.hypothesis === "TIMIDITY" && cut.taskId === "missing",
  ));
  assert.equal(analysis.timidity.taskCount, 1);
  assert.equal(analysis.timidity.equivalent, null);
});

test("timidity is opt-in and fails closed without an exact no-trap design", () => {
  const rows = [
    row("benign", "NO_MEMORY", { repeatedFailure: false, taskPassed: true }),
    row("benign", "PRE_ACTION_FAILURE", { repeatedFailure: false, taskPassed: true }),
  ];
  const withoutTimidity = analyzeRepeatedFailureRows(rows, {
    expectedDesign: { rows: [] },
    seed: 55,
    draws: 20,
  });
  assert.equal(withoutTimidity.timidity.taskCount, 0);
  assert.equal(withoutTimidity.timidity.equivalent, null);
  assert.throws(
    () =>
      analyzeRepeatedFailureRows(rows, {
        expectedDesign: { rows: [] },
        seed: 55,
        draws: 20,
        timidityPassMargin: 0.02,
      }),
    /requires a compatible timidityDesign/
  );
  assert.throws(
    () =>
      analyzeRepeatedFailureRows(rows, {
        expectedDesign: { rows: [] },
        timidityDesign: { rows: [identity("benign", "NO_MEMORY")] },
        seed: 55,
        draws: 20,
      }),
    /incomplete no-trap pair/
  );
  assert.throws(
    () =>
      analyzeRepeatedFailureRows(rows, {
        expectedDesign: { rows: [] },
        timidityDesign: {
          rows: [...rows.map((entry) => entry.identity), identity("benign", "TURN_START_FAILURE")],
        },
        seed: 55,
        draws: 20,
      }),
    /may contain only/
  );
});

test("statistics writer atomically emits the standard JSON artifact", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "h6-stats-writer-"));
  try {
    const rows = timingRows("writer", { repeatedFailure: true, taskPassed: false }, { repeatedFailure: false, taskPassed: true });
    const analysis = analyzeRepeatedFailureRows(rows, { expectedDesign: designFor(rows), seed: 9, draws: 20 });
    const filePath = await writeRepeatedFailureStatistics(dir, analysis);
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), analysis);
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
