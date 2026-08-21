import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { BenchmarkResult, TaskResult } from "../types.js";
import {
  selectLoCoMoTasks,
  type LoCoMoTaskSelectionManifest,
} from "../benchmarks/published/locomo/task-selection.js";
import {
  LOCOMO_FULL_TASK_COUNT,
  diagnoseLoComoRecallDelta,
  renderLoComoRecallDeltaMarkdown,
  sanitizeLoComoResultReference,
} from "./locomo-recall-delta.js";

function task(args: {
  id: string;
  score: number;
  recall: string;
  answer?: string;
  question?: string;
  expected?: string;
  evidence?: unknown;
}): TaskResult {
  return {
    taskId: args.id,
    question: args.question ?? "What is the answer?",
    expected: args.expected ?? "needle answer",
    actual: args.answer ?? "answer",
    scores: { f1: args.score, llm_judge: args.score },
    latencyMs: 1,
    tokens: { input: 0, output: 0 },
    details: {
      categoryName: args.id.split("-").at(-1),
      recalledText: args.recall,
      answeredText: args.answer ?? "answer",
      evidence: args.evidence,
    },
  };
}

function result(
  profile: "baseline" | "real",
  tasks: TaskResult[],
  overrides: Partial<BenchmarkResult> = {}
): BenchmarkResult {
  const complete = completeTasks(tasks);
  const aggregates = aggregatesFor(complete);
  const value: BenchmarkResult = {
    meta: {
      id: `${profile}-id`,
      benchmark: "locomo",
      benchmarkTier: "published",
      version: "2.0.0",
      remnicVersion: "9.6.10",
      gitSha: "abc123",
      timestamp: "2026-07-14T00:00:00.000Z",
      mode: "full",
      runCount: 1,
      seeds: [1],
    },
    config: {
      runtimeProfile: profile,
      systemProvider: { provider: "claude-cli", model: "opus" },
      judgeProvider: { provider: "ollama", model: "qwen" },
      adapterMode: "direct",
      remnicConfig: {},
      benchmarkOptions: {},
    },
    cost: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      totalLatencyMs: 0,
      meanQueryLatencyMs: 0,
    },
    results: { tasks: complete, aggregates },
    environment: { os: "linux", nodeVersion: "v22" },
  };
  return { ...value, ...overrides };
}

function aggregatesFor(tasks: TaskResult[]): BenchmarkResult["results"]["aggregates"] {
  return Object.fromEntries(
    Object.keys(tasks[0]?.scores ?? {}).map((metric) => {
      const values = tasks
        .map((entry) => entry.scores[metric])
        .filter((value): value is number => Number.isFinite(value));
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      return [metric, { mean, median: mean, stdDev: 0, min: Math.min(...values), max: Math.max(...values) }];
    })
  );
}

function selectedResult(
  profile: "baseline" | "real",
  tasks: TaskResult[],
  selectionOverride?: LoCoMoTaskSelectionManifest
): BenchmarkResult {
  const base = result(profile, tasks);
  const candidates = [
    ...tasks.map((entry) => ({ taskId: entry.taskId })),
    ...Array.from(
      { length: LOCOMO_FULL_TASK_COUNT - tasks.length },
      (_, index) => ({ taskId: `selection-candidate-${index}` })
    ),
  ];
  const taskSelection =
    selectionOverride ??
    selectLoCoMoTasks(candidates, { taskIds: tasks.map((entry) => entry.taskId) });
  return {
    ...base,
    config: {
      ...base.config,
      benchmarkOptions: { taskSelection },
    },
    results: {
      tasks,
      aggregates: aggregatesFor(tasks),
    },
  };
}

function completeTasks(tasks: TaskResult[]): TaskResult[] {
  const complete = [...tasks];
  for (let index = complete.length; index < LOCOMO_FULL_TASK_COUNT; index += 1) {
    complete.push(
      task({
        id: `fixture-conv-q${index}-single_hop`,
        score: 0.5,
        recall: "shared filler evidence",
        question: `Filler question ${index}?`,
        expected: `filler-${index}`,
        answer: `filler-${index}`,
      })
    );
  }
  return complete;
}

function evidence(value: BenchmarkResult, label: string) {
  return {
    result: value,
    reference: `${label}.json`,
    sha256: createHash("sha256").update(label).digest("hex"),
  };
}

test("joins complete raw results and emits deterministic final-context displacement receipts", () => {
  const baselineTasks = [
    task({
      id: "conv-1-q0-single_hop",
      score: 1,
      recall: "## LoCoMo Question-Focused Evidence\r\n[conv-1-session_1, turn 3, user, score 9.1]: needle answer",
      answer: "needle answer",
    }),
    task({ id: "conv-1-q1-multi_hop", score: 0.5, recall: "## Evidence\nshared line" }),
  ];
  const realTasks = [
    task({ id: "conv-1-q1-multi_hop", score: 0.5, recall: "## Evidence\nshared line" }),
    task({
      id: "conv-1-q0-single_hop",
      score: 0,
      recall: "## LoCoMo Question-Focused Evidence\nunrelated summary",
      answer: "unknown",
    }),
  ];
  const options = {
    baseline: evidence(result("baseline", baselineTasks), "b"),
    real: evidence(result("real", realTasks), "r"),
  };
  const first = diagnoseLoComoRecallDelta(options);
  const second = diagnoseLoComoRecallDelta(options);

  assert.deepEqual(first, second);
  assert.equal(first.taskCount, LOCOMO_FULL_TASK_COUNT);
  assert.deepEqual(
    first.categories.map((entry) => entry.category),
    ["single_hop", "multi_hop"]
  );
  assert.ok(Math.abs(first.overall.delta + 1 / LOCOMO_FULL_TASK_COUNT) < Number.EPSILON);
  assert.equal(first.topRegressions[0]?.taskId, "conv-1-q0-single_hop");
  assert.equal(first.topRegressions[0]?.baseline.recall.expectedTokenCoverage, 1);
  assert.equal(first.topRegressions[0]?.real.recall.expectedTokenCoverage, 0);
  assert.equal(first.topRegressions[0]?.displacedLines.lines[0]?.sourceRef, "conv-1-session_1:turn-3:user");
  assert.equal(first.topRegressions[0]?.displacedLines.lines[0]?.ordinal, 1);
  assert.equal(first.comparison.baseline.taskPayloadSha256, first.comparison.real.taskPayloadSha256);
  assert.equal(first.evidenceBoundary.retrievalTierAttribution, "unavailable-in-cached-results");
});

test("sorts tied regressions by task id and bounds excerpts and line counts", () => {
  const longLine = `baseline-only ${"x".repeat(400)}`;
  const displaced = Array.from({ length: 21 }, (_, index) => `${longLine}-${index}`).join("\n");
  const baselineTasks = [
    task({ id: "conv-1-q1-multi_hop", score: 1, recall: displaced }),
    task({ id: "conv-1-q0-single_hop", score: 1, recall: longLine }),
  ];
  const realTasks = [
    task({ id: "conv-1-q0-single_hop", score: 0, recall: "real-only" }),
    task({ id: "conv-1-q1-multi_hop", score: 0, recall: "real-only\nsecond-real" }),
  ];
  const report = diagnoseLoComoRecallDelta({
    baseline: evidence(result("baseline", baselineTasks), "b"),
    real: evidence(result("real", realTasks), "r"),
  });

  assert.deepEqual(
    report.topRegressions.map((entry) => entry.taskId),
    ["conv-1-q0-single_hop", "conv-1-q1-multi_hop"]
  );
  assert.equal(report.topRegressions[1]?.displacedLines.totalCount, 21);
  assert.equal(report.topRegressions[1]?.displacedLines.shownCount, 20);
  assert.equal(report.topRegressions[1]?.displacedLines.lines[0]?.excerpt.length, 240);
});

test("never consumes or emits hidden details.evidence", () => {
  const hidden = "DO-NOT-EMIT-HIDDEN-EVIDENCE-ID";
  const baseline = result("baseline", [
    task({ id: "conv-1-q0-single_hop", score: 1, recall: "needle answer", evidence: [hidden] }),
  ]);
  const real = result("real", [
    task({ id: "conv-1-q0-single_hop", score: 0, recall: "unknown", evidence: { hidden } }),
  ]);
  const report = diagnoseLoComoRecallDelta({
    baseline: evidence(baseline, "b"),
    real: evidence(real, "r"),
  });
  assert.equal(JSON.stringify(report).includes(hidden), false);
  assert.equal(renderLoComoRecallDeltaMarkdown(report).includes(hidden), false);
  assert.equal(report.evidenceBoundary.hiddenEvidenceUsed, false);
});

test("rejects partial, limited, failed, wrong-profile, or wrong-sized results", () => {
  const baseTask = task({ id: "conv-1-q0-single_hop", score: 1, recall: "needle answer" });
  const baseline = result("baseline", [baseTask]);
  const real = result("real", [baseTask]);
  const diagnose = (left: BenchmarkResult, right: BenchmarkResult) =>
    diagnoseLoComoRecallDelta({
      baseline: evidence(left, "b"),
      real: evidence(right, "r"),
    });

  assert.throws(
    () => diagnose({ ...baseline, meta: { ...baseline.meta, status: "partial" } }, real),
    /complete full-mode/
  );
  assert.throws(
    () =>
      diagnose(
        {
          ...baseline,
          config: { ...baseline.config, benchmarkOptions: { limit: 1 } },
        },
        real
      ),
    /limited/
  );
  const failedTask = {
    ...baseTask,
    details: {
      ...baseTask.details,
      benchmarkFailure: { kind: "trial_execution_failure" },
    },
  };
  assert.throws(() => diagnose(result("baseline", [failedTask]), real), /contains failed task/);
  assert.throws(() => diagnose(result("real", [baseTask]), real), /baseline result runtimeProfile/);
  assert.throws(
    () =>
      diagnose(
        {
          ...baseline,
          config: { ...baseline.config, systemProvider: null },
        },
        real
      ),
    /identify both system and judge providers/
  );
  assert.throws(
    () => diagnose({ ...baseline, results: { ...baseline.results, tasks: [] } }, real),
    /exactly 1986 tasks/
  );
});

test("accepts paired selected results only with identical canonical taskSelection provenance", () => {
  const baselineTasks = [
    task({ id: "conv-1-q0-single_hop", score: 1, recall: "needle answer" }),
    task({ id: "conv-1-q1-multi_hop", score: 0, recall: "other evidence" }),
  ];
  const realTasks = [
    task({ id: "conv-1-q0-single_hop", score: 0, recall: "unknown" }),
    task({ id: "conv-1-q1-multi_hop", score: 1, recall: "other evidence" }),
  ];
  const baseline = selectedResult("baseline", baselineTasks);
  const manifest = baseline.config.benchmarkOptions?.taskSelection as LoCoMoTaskSelectionManifest;
  const real = selectedResult("real", realTasks, manifest);

  const report = diagnoseLoComoRecallDelta({
    baseline: evidence(baseline, "selected-b"),
    real: evidence(real, "selected-r"),
  });

  assert.equal(report.taskCount, 2);
  assert.deepEqual(report.comparison.baseline.taskSelection, manifest);
  assert.deepEqual(report.comparison.real.taskSelection, manifest);
});

test("rejects missing, mismatched, malformed, or non-canonical selected provenance", () => {
  const selectedTasks = [
    task({ id: "conv-1-q0-single_hop", score: 1, recall: "needle answer" }),
    task({ id: "conv-1-q1-multi_hop", score: 0, recall: "other evidence" }),
  ];
  const baseline = selectedResult("baseline", selectedTasks);
  const manifest = baseline.config.benchmarkOptions?.taskSelection as LoCoMoTaskSelectionManifest;
  const real = selectedResult("real", selectedTasks, manifest);
  const diagnose = (left: BenchmarkResult, right: BenchmarkResult) =>
    diagnoseLoComoRecallDelta({
      baseline: evidence(left, "selected-b"),
      real: evidence(right, "selected-r"),
    });

  assert.throws(
    () => diagnose(baseline, result("real", selectedTasks)),
    /taskSelection differs/
  );
  const differentSelectionTasks = [
    selectedTasks[0]!,
    task({ id: "conv-1-q2-temporal", score: 0, recall: "different evidence" }),
  ];
  assert.throws(
    () => diagnose(baseline, selectedResult("real", differentSelectionTasks)),
    /taskSelection differs/
  );
  assert.throws(
    () => diagnose(
      baseline,
      selectedResult("real", selectedTasks, { ...manifest, candidateCount: 1_985 })
    ),
    /candidateCount must be 1986/
  );
  assert.throws(
    () => diagnose(
      baseline,
      {
        ...real,
        config: {
          ...real.config,
          benchmarkOptions: {
            taskSelection: { ...manifest, selectedCount: manifest.selectedCount + 1 },
          },
        },
      }
    ),
    /selectedCount must equal selectedTaskIds.length/
  );
  assert.throws(
    () => diagnose(
      baseline,
      {
        ...real,
        config: {
          ...real.config,
          benchmarkOptions: {
            taskSelection: { ...manifest, selectedTaskIdsSha256: "0".repeat(64) },
          },
        },
      }
    ),
    /selectedTaskIdsSha256 does not match selectedTaskIds/
  );
  assert.throws(
    () => diagnose(
      baseline,
      {
        ...real,
        results: { ...real.results, tasks: [...real.results.tasks].reverse() },
      }
    ),
    /exactly match taskSelection.selectedTaskIds in canonical order/
  );
});

test("rejects mismatched task payloads, metrics, providers, duplicate ids, and invalid hashes", () => {
  const baseTask = task({ id: "conv-1-q0-single_hop", score: 1, recall: "needle answer" });
  const baseline = result("baseline", [baseTask]);
  const real = result("real", [baseTask]);
  const diagnose = (left: BenchmarkResult, right: BenchmarkResult) =>
    diagnoseLoComoRecallDelta({
      baseline: evidence(left, "b"),
      real: evidence(right, "r"),
    });

  assert.throws(
    () => diagnose(baseline, result("real", [{ ...baseTask, question: "changed" }])),
    /mismatched question/
  );
  assert.throws(
    () => diagnose(baseline, result("real", [{ ...baseTask, scores: { f1: 1 } }])),
    /mismatched metric sets/
  );
  assert.throws(
    () =>
      diagnose(
        baseline,
        result("real", [baseTask], {
          config: { ...real.config, systemProvider: { provider: "claude-cli", model: "sonnet" } },
        })
      ),
    /systemProvider differs/
  );
  assert.throws(
    () =>
      diagnose(
        {
          ...baseline,
          config: {
            ...baseline.config,
            systemProvider: {
              provider: "codex-cli",
              model: "gpt-5.6-luna",
              providerRequestTimeoutMs: 180_000,
            },
          },
        },
        result("real", [baseTask], {
          config: {
            ...real.config,
            systemProvider: {
              provider: "codex-cli",
              model: "gpt-5.6-luna",
              providerRequestTimeoutMs: 240_000,
            },
          },
        })
      ),
    /systemProvider differs/
  );
  assert.throws(
    () =>
      diagnose(
        baseline,
        result("real", [baseTask], {
          config: {
            ...real.config,
            internalProvider: { provider: "codex-cli", model: "gpt-5.6", temperature: 0 },
          },
        })
      ),
    /internalProvider differs/
  );
  const inconsistentMetricTask = { ...baseTask, taskId: "conv-1-q1-multi_hop", scores: { f1: 1 } };
  assert.throws(
    () =>
      diagnose(
        result("baseline", [baseTask, inconsistentMetricTask]),
        result("real", [baseTask, inconsistentMetricTask])
      ),
    /inconsistent metric set/
  );
  const corruptedReal = result("real", [baseTask]);
  assert.throws(
    () =>
      diagnose(baseline, {
        ...corruptedReal,
        results: {
          ...corruptedReal.results,
          aggregates: {
            ...corruptedReal.results.aggregates,
            f1: { mean: 0, median: 0, stdDev: 0, min: 0, max: 0 },
          },
        },
      }),
    /does not match task mean/
  );
  assert.throws(
    () =>
      diagnoseLoComoRecallDelta({
        baseline: evidence(result("baseline", [baseTask, baseTask]), "b"),
        real: evidence(result("real", [baseTask, baseTask]), "r"),
      }),
    /duplicate or empty task id/
  );
  assert.throws(
    () =>
      diagnoseLoComoRecallDelta({
        baseline: { result: baseline, reference: "b", sha256: "BAD" },
        real: evidence(real, "r"),
      }),
    /sha256/
  );
});

test("sanitizes result provenance references without exposing caller directories", () => {
  const reference = sanitizeLoComoResultReference("/home/private/benchmark-results/baseline`receipt.json");

  assert.equal(reference, "baseline_receipt.json");
  assert.equal(reference.includes("/home/private"), false);
});

test("markdown is deterministic and states the final-context evidence boundary", () => {
  const baseline = result("baseline", [task({ id: "conv-1-q0-single_hop", score: 1, recall: "needle answer" })]);
  const real = result("real", [task({ id: "conv-1-q0-single_hop", score: 0, recall: "unrelated | summary" })]);
  const report = diagnoseLoComoRecallDelta({
    baseline: evidence(baseline, "b"),
    real: evidence(real, "r"),
  });
  const first = renderLoComoRecallDeltaMarkdown(report);
  assert.equal(first, renderLoComoRecallDeltaMarkdown(report));
  assert.match(first, /single_hop \| 1986 \| 0\.5003 \| 0\.4997 \| -0\.0005/);
  assert.match(first, /Retrieval-tier attribution is unavailable/);
  assert.match(first, /unrelated \\| summary/);
});
