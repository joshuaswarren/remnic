/**
 * Behavior-focused tests for the staged-memory runner (issue #2346):
 * staged invariants (persistence across resets, zero leakage, zero scope
 * violations, supersession), arm separation, NA accounting, paired
 * statistics, gate enforcement, determinism, and the sanitized public
 * projection. Controller modes beyond "off" are explicit refusals until
 * the #2348 coordinator lands.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getRegisteredBenchmark } from "../../../registry.js";
import type { ResolvedRunBenchmarkOptions } from "../../../types.js";
import { generateStagedMemoryFixture } from "./fixture.js";
import {
  DeterministicStagedMemory,
  runStagedMemoryBenchmark,
  stagedMemorySyntheticV1Definition,
  toStagedMemoryPublicResults,
} from "./runner.js";
import {
  STAGED_MEMORY_NAMESPACES,
  STAGED_MEMORY_TRUSTED_PRINCIPAL,
  type StagedMemoryPublicResultV1,
} from "./schema.js";

const canonicalDriftDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/drift-gen-core");

const scope = {
  trustedPrincipal: STAGED_MEMORY_TRUSTED_PRINCIPAL,
  namespace: STAGED_MEMORY_NAMESPACES[0] as string,
};

function runOptions(overrides: Partial<ResolvedRunBenchmarkOptions> = {}): ResolvedRunBenchmarkOptions {
  return {
    mode: "quick",
    benchmark: stagedMemorySyntheticV1Definition,
    system: null as unknown as ResolvedRunBenchmarkOptions["system"],
    ...overrides,
  };
}

test("the benchmark is registered with a runnable definition", () => {
  const registered = getRegisteredBenchmark("staged-memory-synthetic-v1");
  assert.ok(registered, "benchmark must be registered");
  assert.equal(typeof registered.run, "function");
});

test("quick mode runs all five arms and passes every deterministic gate", async () => {
  const result = await runStagedMemoryBenchmark(runOptions());
  const stagedOptions = result.config.benchmarkOptions as Record<string, unknown>;
  const armMeans = stagedOptions.armMeans as Record<string, Record<string, number | "NA">>;
  for (const arm of ["empty", "persist-only", "static-context", "staged-memory", "oracle-retrieval"]) {
    assert.ok(armMeans[arm], `arm ${arm} must be summarized`);
  }
  const staged = armMeans["staged-memory"] as Record<string, number | "NA">;
  assert.equal(staged.construction_recall, 1);
  assert.ok((staged.supersession_accuracy as number) >= 0.95);
  assert.ok((staged.retrieval_recall_at_5 as number) >= 0.9);
  assert.ok((staged.task_success as number) >= 0.85);
  assert.equal(staged.distractor_rejection, 1);
  assert.equal(staged.context_reset_leakage, 0);
  assert.equal(staged.scope_violation, 0);
  assert.equal(staged.persistent_survival, 1);
  assert.equal(staged.stale_answer, 0);
  const gates = stagedOptions.gates as Record<string, boolean>;
  assert.ok(
    Object.values(gates).every((pass) => pass),
    `all gates pass: ${JSON.stringify(gates)}`
  );
});

test("the oracle arm calibrates the scorer and the empty arm floors it", async () => {
  const result = await runStagedMemoryBenchmark(runOptions());
  const armMeans = (result.config.benchmarkOptions as Record<string, unknown>).armMeans as Record<
    string,
    Record<string, number | "NA">
  >;
  assert.equal(
    armMeans["oracle-retrieval"].task_success,
    1,
    "oracle retrieval must calibrate the scorer to exact-match"
  );
  assert.equal(armMeans.empty.task_success, 0);
});

test("resetContext removes appended distractors; static-context keeps them", async () => {
  const result = await runStagedMemoryBenchmark(runOptions());
  const tasksByArm = new Map<string, typeof result.results.tasks>();
  for (const arm of ["static-context", "staged-memory"]) {
    tasksByArm.set(
      arm,
      result.results.tasks.filter((task) => task.taskId.endsWith(`::${arm}`))
    );
  }
  const staticTasks = tasksByArm.get("static-context") as typeof result.results.tasks;
  const stagedTasks = tasksByArm.get("staged-memory") as typeof result.results.tasks;
  assert.ok(staticTasks.length > 0);
  // Distractors were demonstrably present in Stage 2 active context.
  for (const task of [...staticTasks, ...stagedTasks]) {
    const details = task.details as { distractorPresenceDuringStage2?: number };
    assert.ok((details.distractorPresenceDuringStage2 ?? 0) > 0, "distractors must be present in the Stage 2 context");
  }
  const staticResidue = staticTasks.filter((task) => task.scores.distractor_rejection === 0);
  assert.ok(staticResidue.length > 0, "static-context must show distractor residue in at least one case");
  for (const task of stagedTasks) {
    assert.equal(task.scores.distractor_rejection, 1);
    assert.equal(task.scores.context_reset_leakage, 0);
  }
});

test("appendContext never writes core memory and resetContext never deletes it", async () => {
  const engine = new DeterministicStagedMemory(STAGED_MEMORY_NAMESPACES);
  const sessionId = "staged-sm-engine-test";
  await engine.store(scope, sessionId, ["Riley Marsh works at Norvig Dynamics."], 2);
  await engine.appendContext(scope, sessionId, ["Marlow Petrov works at Quill Optical."]);
  assert.equal(engine.currentTuples(scope).length, 1);
  assert.deepEqual(engine.contextSnapshot(scope, sessionId), ["Marlow Petrov works at Quill Optical."]);
  await engine.resetContext(scope, sessionId);
  assert.deepEqual(engine.contextSnapshot(scope, sessionId), []);
  assert.equal(engine.currentTuples(scope).length, 1, "resetContext must preserve persistent tuples");
});

test("missing or unallowlisted scope fields fail for every scoped method", async () => {
  const engine = new DeterministicStagedMemory(STAGED_MEMORY_NAMESPACES);
  const badScopes = [
    { trustedPrincipal: "someone-else", namespace: scope.namespace },
    { trustedPrincipal: scope.trustedPrincipal, namespace: "rogue-namespace" },
    { trustedPrincipal: "", namespace: "" },
  ];
  for (const bad of badScopes) {
    await assert.rejects(() => engine.reset(bad), /not allowlisted/);
    await assert.rejects(() => engine.store(bad, "s", ["x"], 1), /not allowlisted/);
    await assert.rejects(() => engine.appendContext(bad, "s", ["x"]), /not allowlisted/);
    await assert.rejects(() => engine.resetContext(bad, "s"), /not allowlisted/);
    assert.throws(() => engine.currentTuples(bad), /not allowlisted/);
    assert.throws(() => engine.recall(bad, "s", "q"), /not allowlisted/);
  }
});

test("same-session and same-ID collisions stay isolated across namespaces", async () => {
  const engine = new DeterministicStagedMemory(STAGED_MEMORY_NAMESPACES);
  const other = {
    trustedPrincipal: STAGED_MEMORY_TRUSTED_PRINCIPAL,
    namespace: STAGED_MEMORY_NAMESPACES[1] as string,
  };
  const sessionId = "shared-session-id";
  // Same principal, same session ID, same statement — different namespaces.
  await engine.store(scope, sessionId, ["Riley Marsh works at Norvig Dynamics."], 2);
  await engine.appendContext(scope, sessionId, ["alpha context line"]);
  await engine.store(other, sessionId, ["Lux Bannister lives in Cinder Falls."], 2);
  await engine.appendContext(other, sessionId, ["beta context line"]);
  const recallAlpha = engine.recall(scope, sessionId, "Where does Riley Marsh work these days?");
  const recallBeta = engine.recall(other, sessionId, "Where does Riley Marsh work these days?");
  assert.match(recallAlpha.text, /Riley Marsh/);
  assert.ok(!recallAlpha.text.includes("Lux Bannister"));
  assert.match(recallBeta.text, /Lux Bannister lives/);
  assert.ok(!recallBeta.text.includes("Riley Marsh"));
  // A context reset in one namespace cannot clear the other.
  await engine.resetContext(other, sessionId);
  assert.deepEqual(engine.contextSnapshot(scope, sessionId), ["alpha context line"]);
  assert.deepEqual(engine.contextSnapshot(other, sessionId), []);
});

test("transition scoring uses the pinned epoch, never wall-clock time", async () => {
  const engine = new DeterministicStagedMemory(STAGED_MEMORY_NAMESPACES);
  const sessionId = "staged-transition-test";
  await engine.store(scope, sessionId, ["Riley Marsh works at Norvig Dynamics."], 1);
  await engine.store(scope, sessionId, ["Riley Marsh works at Halcyon Foundry."], 3);
  await engine.correct(scope, { subject: "Riley Marsh", attribute: "employer", epoch: 3 });
  const values = engine
    .currentTuples(scope)
    .filter((tuple) => tuple.subject === "Riley Marsh")
    .map((tuple) => tuple.value);
  assert.ok(values.includes("Halcyon Foundry"));
  assert.ok(!values.includes("Norvig Dynamics"));
});

test("NA metrics are recorded with reasons and excluded from aggregates", async () => {
  const result = await runStagedMemoryBenchmark(runOptions());
  const stagedOptions = result.config.benchmarkOptions as Record<string, unknown>;
  const naMetrics = stagedOptions.naMetrics as Record<string, { denominator: number; reason: string }>;
  assert.ok(naMetrics["empty:construction_recall"], "empty-arm construction recall must be NA with a reason");
  const armMeans = stagedOptions.armMeans as Record<string, Record<string, number | "NA">>;
  assert.equal(armMeans.empty.construction_recall, "NA");
  // NA values never contaminate numeric means.
  assert.equal(typeof armMeans["staged-memory"].task_success, "number");
  // NA metrics are excluded from bootstrap intervals.
  const statistics = result.results.statistics;
  assert.ok(statistics);
  assert.ok(!Object.keys(statistics.confidenceIntervals).includes("staged-memory:construction_recall_empty"));
});

test("paired permutation and Holm fields are present and shaped", async () => {
  const result = await runStagedMemoryBenchmark(runOptions());
  const stagedOptions = result.config.benchmarkOptions as Record<string, unknown>;
  const paired = stagedOptions.pairedPermutation as Record<string, { pValue: number; samples: number } | "NA">;
  assert.equal(stagedOptions.permutationSamples, 10_000);
  for (const key of [
    "distractor_rejection:staged-vs-static",
    "task_success:staged-vs-static",
    "input_tokens:staged-vs-persist",
  ]) {
    const entry = paired[key];
    assert.ok(entry !== undefined, `${key} must exist`);
    if (entry !== "NA") {
      assert.ok(entry.pValue > 0 && entry.pValue <= 1);
      assert.equal(entry.samples, 10_000);
    }
  }
  const holm = stagedOptions.holmCorrection as {
    adjustedPValues: Record<string, number | "NA">;
  };
  for (const value of Object.values(holm.adjustedPValues)) {
    if (value !== "NA") assert.ok(value > 0 && value <= 1);
  }
});

test("replaying the same seed reproduces every statistic without hand edits", async () => {
  const first = await runStagedMemoryBenchmark(runOptions());
  const second = await runStagedMemoryBenchmark(runOptions());
  assert.deepEqual(
    first.config.benchmarkOptions,
    second.config.benchmarkOptions,
    "statistical payload must be identical across runs"
  );
  assert.deepEqual(
    first.results.tasks.map((task) => [task.taskId, task.actual, task.scores]),
    second.results.tasks.map((task) => [task.taskId, task.actual, task.scores]),
    "task order, answers, and scores must be identical"
  );
  assert.deepEqual(first.results.aggregates, second.results.aggregates);
  assert.deepEqual(first.results.statistics?.confidenceIntervals, second.results.statistics?.confidenceIntervals);
});

test("public projection omits questions, answers, recalled and gold text", async () => {
  const result = await runStagedMemoryBenchmark(runOptions());
  const projections = toStagedMemoryPublicResults(result);
  assert.equal(projections.length, 5);
  const serialized = JSON.stringify(projections);
  for (const task of result.results.tasks) {
    assert.ok(!serialized.includes(JSON.stringify(task.question)));
    assert.ok(!serialized.includes(JSON.stringify(task.expected)));
    assert.ok(!serialized.includes(JSON.stringify(task.actual)));
  }
  for (const projection of projections as StagedMemoryPublicResultV1[]) {
    assert.equal(projection.schemaVersion, 1);
    assert.equal(projection.benchmark, "staged-memory-synthetic-v1");
    assert.match(projection.integrity.resultSha256, /^[0-9a-f]{64}$/);
    assert.match(projection.fixtureHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(projection.seeds, result.meta.seeds);
  }
});

test("controller modes beyond off are explicit refusals, not silent fallbacks", async () => {
  await assert.rejects(
    () => runStagedMemoryBenchmark(runOptions({ benchmarkOptions: { controllerMode: "shadow" } })),
    /#2348/
  );
  await assert.rejects(
    () => runStagedMemoryBenchmark(runOptions({ benchmarkOptions: { controllerMode: "active" } })),
    /#2348/
  );
  await assert.rejects(
    () => runStagedMemoryBenchmark(runOptions({ benchmarkOptions: { controllerMode: "sometimes" } })),
    /controllerMode must be/
  );
});

test("full mode without --dataset-dir is rejected", async () => {
  await assert.rejects(() => runStagedMemoryBenchmark(runOptions({ mode: "full" })), /--dataset-dir/);
});

test("a full-mode run over a generated dataset-dir matches the quick run's staged metrics", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "staged-memory-dataset-"));
  await generateStagedMemoryFixture({
    driftDir: canonicalDriftDir,
    seed: 11,
    outDir: out,
    casesPerUser: 6,
    distractorCount: 3,
  });
  const full = await runStagedMemoryBenchmark(runOptions({ mode: "full", datasetDir: out }));
  const stagedOptions = full.config.benchmarkOptions as Record<string, unknown>;
  const armMeans = stagedOptions.armMeans as Record<string, Record<string, number | "NA">>;
  assert.equal(armMeans["staged-memory"].construction_recall, 1);
  assert.equal(armMeans["staged-memory"].scope_violation, 0);
  assert.equal(full.meta.datasetHash, stagedOptions.fixtureHash);
  assert.equal((stagedOptions.seeds as number[])[0], 11);
  await rm(out, { recursive: true, force: true });
});
