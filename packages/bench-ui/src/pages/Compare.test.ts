import assert from "node:assert/strict";
import test from "node:test";

import type { BenchResultSummary } from "../bench-data";
import { canCompareBenchRuns, filterComparableCandidateRuns } from "./Compare";

function summary(overrides: Partial<BenchResultSummary>): BenchResultSummary {
  return {
    id: "run",
    benchmark: "bench-a",
    benchmarkTier: "local",
    timestamp: "2026-05-21T00:00:00.000Z",
    mode: "quick",
    totalLatencyMs: null,
    meanQueryLatencyMs: null,
    taskCount: 0,
    metricHighlights: [],
    primaryMetric: "accuracy",
    primaryScore: null,
    runCount: 1,
    estimatedCostUsd: null,
    totalTokens: null,
    inputTokens: null,
    outputTokens: null,
    systemProvider: "system-a",
    judgeProvider: "judge-a",
    providerKey: "system-a::judge-a",
    adapterMode: "memory",
    aggregateMetrics: [],
    taskSummaries: [],
    integrity: {
      split: "unknown",
      sealsPresent: false,
      canaryUnderFloor: null,
      canaryScore: null,
      canaryFloor: 0.1,
      qrelsSealedHashShort: null,
      judgePromptHashShort: null,
      datasetHashShort: null,
    },
    filePath: "/tmp/run.json",
    ...overrides,
  };
}

test("canCompareBenchRuns rejects comparing a run against itself", () => {
  const run = summary({ id: "same-run", benchmark: "bench-a" });
  const other = summary({ id: "other-run", benchmark: "bench-a" });

  assert.equal(canCompareBenchRuns(run, run), false);
  assert.equal(canCompareBenchRuns(run, other), true);
});

test("filterComparableCandidateRuns excludes the selected baseline", () => {
  const baseline = summary({ id: "baseline", benchmark: "bench-a" });
  const candidate = summary({ id: "candidate", benchmark: "bench-a" });
  const otherBenchmark = summary({ id: "other", benchmark: "bench-b" });

  const filtered = filterComparableCandidateRuns(
    {
      resultsDir: "/tmp/results",
      summaries: [baseline, candidate, otherBenchmark],
    },
    baseline,
  );

  assert.deepEqual(
    filtered.map((run) => run.id),
    ["candidate"],
  );
});

test("reconcileCompareSelection preserves valid manual selections across payload refreshes", async () => {
  // @ts-ignore This TS test imports a TSX page module in the root test-typecheck baseline.
  const module = await import("./Compare") as {
    reconcileCompareSelection(
      payload: { resultsDir: string; summaries: BenchResultSummary[] },
      selection: { baselineId: string; candidateId: string },
    ): { baselineId: string; candidateId: string };
  };
  const defaultBaseline = summary({ id: "default-baseline", benchmark: "bench-a", timestamp: "2026-05-21T00:00:00.000Z" });
  const defaultCandidate = summary({ id: "default-candidate", benchmark: "bench-a", timestamp: "2026-05-22T00:00:00.000Z" });
  const manualBaseline = summary({ id: "manual-baseline", benchmark: "bench-b", timestamp: "2026-05-19T00:00:00.000Z" });
  const manualCandidate = summary({ id: "manual-candidate", benchmark: "bench-b", timestamp: "2026-05-20T00:00:00.000Z" });

  const next = module.reconcileCompareSelection(
    {
      resultsDir: "/tmp/results",
      summaries: [defaultBaseline, defaultCandidate, manualBaseline, manualCandidate],
    },
    {
      baselineId: manualBaseline.id,
      candidateId: manualCandidate.id,
    },
  );

  assert.deepEqual(next, {
    baselineId: manualBaseline.id,
    candidateId: manualCandidate.id,
  });
});

test("reconcileCompareSelection preserves explicit cleared selections", async () => {
  // @ts-ignore This TS test imports a TSX page module in the root test-typecheck baseline.
  const module = await import("./Compare") as {
    reconcileCompareSelection(
      payload: { resultsDir: string; summaries: BenchResultSummary[] },
      selection: { baselineId: string; candidateId: string },
    ): { baselineId: string; candidateId: string };
  };
  const baseline = summary({ id: "baseline", benchmark: "bench-a", timestamp: "2026-05-21T00:00:00.000Z" });
  const candidate = summary({ id: "candidate", benchmark: "bench-a", timestamp: "2026-05-22T00:00:00.000Z" });
  const payload = {
    resultsDir: "/tmp/results",
    summaries: [baseline, candidate],
  };

  assert.deepEqual(
    module.reconcileCompareSelection(payload, {
      baselineId: "",
      candidateId: candidate.id,
    }),
    {
      baselineId: "",
      candidateId: "",
    },
  );
  assert.deepEqual(
    module.reconcileCompareSelection(payload, {
      baselineId: baseline.id,
      candidateId: "",
    }),
    {
      baselineId: baseline.id,
      candidateId: "",
    },
  );
});

test("reconcileCompareSelection applies defaults for untouched blank selections", async () => {
  // @ts-ignore This TS test imports a TSX page module in the root test-typecheck baseline.
  const module = await import("./Compare") as {
    reconcileCompareSelection(
      payload: { resultsDir: string; summaries: BenchResultSummary[] },
      selection: { baselineId: string; candidateId: string },
      options?: { preserveClearedSelection?: boolean },
    ): { baselineId: string; candidateId: string };
  };
  const baseline = summary({ id: "baseline", benchmark: "bench-a", timestamp: "2026-05-21T00:00:00.000Z" });
  const candidate = summary({ id: "candidate", benchmark: "bench-a", timestamp: "2026-05-22T00:00:00.000Z" });

  const next = module.reconcileCompareSelection(
    {
      resultsDir: "/tmp/results",
      summaries: [baseline, candidate],
    },
    {
      baselineId: "",
      candidateId: "",
    },
    { preserveClearedSelection: false },
  );

  assert.deepEqual(next, {
    baselineId: baseline.id,
    candidateId: candidate.id,
  });
});

test("reconcileCompareSelection repairs selections whose runs disappeared", async () => {
  // @ts-ignore This TS test imports a TSX page module in the root test-typecheck baseline.
  const module = await import("./Compare") as {
    reconcileCompareSelection(
      payload: { resultsDir: string; summaries: BenchResultSummary[] },
      selection: { baselineId: string; candidateId: string },
    ): { baselineId: string; candidateId: string };
  };
  const baseline = summary({ id: "baseline", benchmark: "bench-a", timestamp: "2026-05-21T00:00:00.000Z" });
  const candidate = summary({ id: "candidate", benchmark: "bench-a", timestamp: "2026-05-22T00:00:00.000Z" });

  const next = module.reconcileCompareSelection(
    {
      resultsDir: "/tmp/results",
      summaries: [baseline, candidate],
    },
    {
      baselineId: "missing-baseline",
      candidateId: "missing-candidate",
    },
  );

  assert.deepEqual(next, {
    baselineId: baseline.id,
    candidateId: candidate.id,
  });
});

test("reconcileCompareSelection keeps candidate empty without a valid baseline", async () => {
  // @ts-ignore This TS test imports a TSX page module in the root test-typecheck baseline.
  const module = await import("./Compare") as {
    reconcileCompareSelection(
      payload: { resultsDir: string; summaries: BenchResultSummary[] },
      selection: { baselineId: string; candidateId: string },
    ): { baselineId: string; candidateId: string };
  };
  const onlyRun = summary({ id: "only-run", benchmark: "bench-a" });

  const next = module.reconcileCompareSelection(
    {
      resultsDir: "/tmp/results",
      summaries: [onlyRun],
    },
    {
      baselineId: "",
      candidateId: onlyRun.id,
    },
  );

  assert.deepEqual(next, {
    baselineId: "",
    candidateId: "",
  });
});
