/**
 * Tests for scripts/bench/build-artifact-from-result.ts (issue #1712).
 *
 * Covers the 12 hardening nits in three bands:
 *   1. CLI input validation — invalid --tier / --vram-gb / missing positionals
 *      / --tier local without hardware are rejected by parseArgs.
 *   2. Publish-safety + identity — validateResultForPromotion rejects
 *      unpublished benchmark ids, partial/quick runs, and limited runs;
 *      isPublishedBenchmarkId matches the allow-list.
 *   3. Timestamp derivation + end-to-end promotion — deriveRunWindow treats
 *      meta.timestamp as the run END (startedAt = finish − duration), and a
 *      full promote() round-trip yields an artifact that re-parses cleanly
 *      through loadBenchmarkArtifact (the verify-artifact.ts path).
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadBenchmarkArtifact, type BenchmarkResult, type TaskResult } from "@remnic/bench";

import {
  parseArgs,
  validateResultForPromotion,
  deriveRunWindow,
  isPublishedBenchmarkId,
  promote,
} from "../scripts/bench/build-artifact-from-result.js";

function makeTask(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId: "t1",
    question: "q",
    expected: "e",
    actual: "a",
    scores: { f1: 0.5 },
    latencyMs: 1000,
    tokens: { input: 10, output: 5 },
    ...overrides,
  };
}

interface ResultOverrides {
  benchmark?: string;
  status?: "complete" | "partial";
  mode?: "full" | "quick";
  timestamp?: string;
  totalLatencyMs?: number;
  benchmarkOptions?: Record<string, unknown>;
  tasks?: TaskResult[];
  model?: string;
}

function makeResult(overrides: ResultOverrides = {}): BenchmarkResult {
  const tasks =
    overrides.tasks ?? [
      makeTask(),
      makeTask({ taskId: "t2", scores: { f1: 0.9, llm_judge: 1 }, latencyMs: 4000 }),
    ];
  return {
    meta: {
      id: "run-1",
      benchmark: overrides.benchmark ?? "locomo",
      benchmarkTier: "published",
      version: "1.0.0",
      remnicVersion: "9.3.725",
      gitSha: "abc1234",
      timestamp: overrides.timestamp ?? "2026-07-07T10:00:00.000Z",
      mode: overrides.mode ?? "full",
      runCount: 1,
      seeds: [42],
      ...(overrides.status !== undefined ? { status: overrides.status } : {}),
    },
    config: {
      systemProvider: { provider: "openai", model: overrides.model ?? "gpt-4o-mini" },
      judgeProvider: { provider: "openai", model: "gpt-4o" },
      adapterMode: "direct",
      remnicConfig: {},
      ...(overrides.benchmarkOptions !== undefined
        ? { benchmarkOptions: overrides.benchmarkOptions }
        : {}),
    },
    cost: {
      totalTokens: 100,
      inputTokens: 60,
      outputTokens: 40,
      estimatedCostUsd: 0.01,
      totalLatencyMs: overrides.totalLatencyMs ?? 5000,
      meanQueryLatencyMs: 2500,
      judgeModelCalls: 2,
    },
    results: {
      tasks,
      aggregates: {
        f1: { mean: 0.7, median: 0.7, stdDev: 0.2, min: 0.5, max: 0.9 },
      },
    },
    environment: {
      os: "linux",
      nodeVersion: "v22.20.0",
      hardware: "arm64",
    },
  };
}

// --- isPublishedBenchmarkId -------------------------------------------------

test("isPublishedBenchmarkId accepts known ids and rejects unknown ones", () => {
  assert.equal(isPublishedBenchmarkId("locomo"), true);
  assert.equal(isPublishedBenchmarkId("longmemeval"), true);
  assert.equal(isPublishedBenchmarkId("not-a-bench"), false);
  assert.equal(isPublishedBenchmarkId(""), false);
});

// --- parseArgs: --tier allow-list (nit [2],[5]) -----------------------------

test("parseArgs accepts --tier frontier bare and --tier local with hardware", () => {
  // frontier never requires hardware; local does (nit [13]), so it is tested
  // with the envelope here to isolate the allow-list check.
  const frontier = parseArgs(["a.json", "out", "--tier", "frontier"]);
  assert.equal(frontier.ok, true);
  assert.equal(frontier.ok && frontier.value.tier, "frontier");

  const local = parseArgs([
    "a.json",
    "out",
    "--tier",
    "local",
    "--gpu",
    "NVIDIA RTX 3090",
    "--vram-gb",
    "24",
    "--quantization",
    "Q4_K_M",
  ]);
  assert.equal(local.ok, true);
  assert.equal(local.ok && local.value.tier, "local");
});

test("parseArgs rejects an invalid --tier with a clear diagnostic", () => {
  const r = parseArgs(["a.json", "out", "--tier", "batman"]);
  assert.equal(r.ok, false);
  assert.match(!r.ok && r.message, /--tier must be one of: local, frontier/);
});

test("parseArgs rejects a missing --tier value", () => {
  const r = parseArgs(["a.json", "out", "--tier"]);
  assert.equal(r.ok, false);
  assert.match(!r.ok && r.message, /--tier requires a value/);
});

// --- parseArgs: --vram-gb finite-integer (nit [3],[9]) ----------------------

test("parseArgs accepts a positive integer --vram-gb", () => {
  const r = parseArgs(["a.json", "out", "--gpu", "RTX 3090", "--vram-gb", "24", "--quantization", "Q4_K_M"]);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.value.hardware?.vramGb, 24);
});

test("parseArgs rejects non-integer / non-finite / non-positive --vram-gb values", () => {
  const bad = ["abc", "1.5", "0", "-1", "", " "];
  for (const raw of bad) {
    const r = parseArgs(["a.json", "out", "--vram-gb", raw]);
    assert.equal(r.ok, false, `expected --vram-gb "${raw}" to be rejected`);
    assert.match(!r.ok && r.message, /--vram-gb must be a positive finite integer/);
  }
});

test("parseArgs rejects a missing --vram-gb value", () => {
  const r = parseArgs(["a.json", "out", "--vram-gb"]);
  assert.equal(r.ok, false);
  assert.match(!r.ok && r.message, /--vram-gb requires a positive integer/);
});

// --- parseArgs: hardware envelope + positionals -----------------------------

test("parseArgs requires all three hardware flags together", () => {
  const r = parseArgs(["a.json", "out", "--gpu", "RTX 3090", "--vram-gb", "24"]);
  assert.equal(r.ok, false);
  assert.match(!r.ok && r.message, /--gpu, --vram-gb, and --quantization must all be supplied together/);
});

test("parseArgs rejects --tier local without the hardware envelope (nit [13])", () => {
  const r = parseArgs(["a.json", "out", "--tier", "local"]);
  assert.equal(r.ok, false);
  assert.match(!r.ok && r.message, /--tier local requires the full hardware envelope/);
});

test("parseArgs accepts --tier local with the full hardware envelope", () => {
  const r = parseArgs([
    "a.json",
    "out",
    "--tier",
    "local",
    "--gpu",
    "NVIDIA RTX 3090",
    "--vram-gb",
    "24",
    "--quantization",
    "Q4_K_M",
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.value.tier, "local");
  assert.deepEqual(r.ok && r.value.hardware, {
    gpu: "NVIDIA RTX 3090",
    vramGb: 24,
    quantization: "Q4_K_M",
  });
});

test("parseArgs rejects a missing outDir positional", () => {
  const r = parseArgs(["a.json"]);
  assert.equal(r.ok, false);
  assert.match(!r.ok && r.message, /^usage:/);
});

// --- validateResultForPromotion: identity + publish-safety (nit [10],[12]) --

test("validateResultForPromotion accepts a complete full run", () => {
  assert.equal(validateResultForPromotion(makeResult()).ok, true);
});

test("validateResultForPromotion rejects an unpublished benchmark id (nit [10])", () => {
  const r = validateResultForPromotion(makeResult({ benchmark: "made-up-bench" }));
  assert.equal(r.ok, false);
  assert.match(!r.ok && r.message, /is not a published benchmark artifact id/);
});

test("validateResultForPromotion rejects a partial run (nit [12])", () => {
  const r = validateResultForPromotion(makeResult({ status: "partial" }));
  assert.equal(r.ok, false);
  assert.match(!r.ok && r.message, /refusing to promote a partial run/);
});

test("validateResultForPromotion rejects legacy task-error artifacts missing partial status", () => {
  const r = validateResultForPromotion(makeResult({
    tasks: [makeTask({
      taskId: "provider-failure",
      actual: "(error: provider HTTP 400)",
      scores: { f1: -1, llm_judge: -1 },
      details: { error: "provider HTTP 400" },
    })],
  }));
  assert.equal(r.ok, false);
  assert.match(!r.ok && r.message, /refusing to promote.*failed trial.*provider-failure/);
});

test("validateResultForPromotion preserves legitimate negative scores and diagnostic error fields", () => {
  const negativeScore = validateResultForPromotion(makeResult({
    tasks: [makeTask({ scores: { judge_accuracy: -1 } })],
  }));
  assert.equal(negativeScore.ok, true);

  const diagnosticOnly = validateResultForPromotion(makeResult({
    tasks: [makeTask({ actual: "valid answer", details: { error: "non-fatal diagnostic" } })],
  }));
  assert.equal(diagnosticOnly.ok, true);
});

test("validateResultForPromotion rejects a quick-mode run (nit [12])", () => {
  const r = validateResultForPromotion(makeResult({ mode: "quick" }));
  assert.equal(r.ok, false);
  assert.match(!r.ok && r.message, /refusing to promote a quick-mode run/);
});

test("validateResultForPromotion rejects a limited run via benchmarkOptions.limit (nit [12])", () => {
  const r = validateResultForPromotion(makeResult({ benchmarkOptions: { limit: 100 } }));
  assert.equal(r.ok, false);
  assert.match(!r.ok && r.message, /refusing to promote a limited run/);
});

test("validateResultForPromotion rejects a limited run via benchmarkOptions.trialLimit (nit [12])", () => {
  const r = validateResultForPromotion(makeResult({ benchmarkOptions: { trialLimit: 3 } }));
  assert.equal(r.ok, false);
  assert.match(!r.ok && r.message, /refusing to promote a limited run/);
});

test("validateResultForPromotion treats a null benchmarkOptions as absent (typeof null === object footgun)", () => {
  // JSON `null` must not crash the limit check (typeof null === "object").
  const r = validateResultForPromotion(makeResult({ benchmarkOptions: null as unknown as Record<string, unknown> }));
  assert.equal(r.ok, true);
});

test("validateResultForPromotion rejects a non-object result", () => {
  assert.equal(validateResultForPromotion(null).ok, false);
  assert.equal(validateResultForPromotion("nope").ok, false);
  assert.equal(validateResultForPromotion(undefined).ok, false);
});

// --- deriveRunWindow: timestamp derivation (nit [8],[11]) -------------------

test("deriveRunWindow treats meta.timestamp as the finish and derives start = finish - duration", () => {
  // meta.timestamp is recorded at run END; the pre-#1712 helper misused it as
  // the start. start must be duration-earlier than finish.
  const w = deriveRunWindow("2026-07-07T10:00:00.000Z", 5000);
  assert.equal(w.finishedAt, "2026-07-07T10:00:00.000Z");
  assert.equal(w.startedAt, "2026-07-07T09:59:55.000Z");
});

test("deriveRunWindow collapses a zero/negative/non-finite duration to a zero-length window", () => {
  for (const duration of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
    const w = deriveRunWindow("2026-07-07T10:00:00.000Z", duration);
    assert.equal(w.startedAt, "2026-07-07T10:00:00.000Z", `duration ${duration}`);
    assert.equal(w.finishedAt, "2026-07-07T10:00:00.000Z", `duration ${duration}`);
  }
});

test("deriveRunWindow throws on an invalid timestamp", () => {
  assert.throws(
    () => deriveRunWindow("not-a-date", 1000),
    /is not a valid ISO-8601 timestamp/,
  );
});

// --- promote: end-to-end valid input -> correct artifact (nit [4],[6],[7]) --

test("promote writes a publishable artifact with the true run window + envelope", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-helper-"));
  const outDir = path.join(tmp, "out");
  await mkdir(outDir, { recursive: true });
  const resultPath = path.join(tmp, "result.json");
  await writeFile(resultPath, JSON.stringify(makeResult({ totalLatencyMs: 5000 })), "utf8");

  try {
    const r = await promote({
      resultPath,
      outDir,
      tier: "local",
      hardware: { gpu: "NVIDIA RTX 3090", vramGb: 24, quantization: "Q4_K_M" },
    });
    assert.equal(r.benchmarkId, "locomo");
    assert.equal(r.model, "gpt-4o-mini");
    assert.equal(r.seed, 42);
    assert.equal(r.taskCount, 2);
    assert.equal(r.judgeCalls, 2);
    assert.match(r.sha256, /^[0-9a-f]{64}$/);

    // The written file must re-parse + re-hash through the verify-artifact.ts
    // path (loadBenchmarkArtifact), proving publishability.
    const loaded = await loadBenchmarkArtifact(r.path);
    assert.equal(loaded.artifact.benchmarkId, "locomo");
    assert.equal(loaded.artifact.model, "gpt-4o-mini");
    assert.equal(loaded.artifact.tier, "local");
    assert.deepEqual(loaded.artifact.hardware, {
      gpu: "NVIDIA RTX 3090",
      vramGb: 24,
      quantization: "Q4_K_M",
    });

    // Timestamp derivation landed in the artifact: finish === meta.timestamp,
    // start === finish − duration, durationMs === totalLatencyMs.
    assert.equal(loaded.artifact.finishedAt, "2026-07-07T10:00:00.000Z");
    assert.equal(loaded.artifact.startedAt, "2026-07-07T09:59:55.000Z");
    assert.equal(loaded.artifact.durationMs, 5000);

    // metrics are the aggregate means; perTaskScores preserve runner order.
    assert.equal(loaded.artifact.metrics.f1, 0.7);
    assert.equal(loaded.artifact.perTaskScores.length, 2);
    assert.equal(loaded.artifact.perTaskScores[0]?.taskId, "t1");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("promote surfaces a validation rejection as a clear thrown diagnostic", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-helper-"));
  const resultPath = path.join(tmp, "result.json");
  await writeFile(resultPath, JSON.stringify(makeResult({ benchmark: "bogus" })), "utf8");
  try {
    await assert.rejects(
      promote({ resultPath, outDir: tmp }),
      /is not a published benchmark artifact id/,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("promote surfaces a missing result file as a clear thrown diagnostic", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-helper-"));
  try {
    await assert.rejects(
      promote({ resultPath: path.join(tmp, "nope.json"), outDir: tmp }),
      /could not read result file/,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
