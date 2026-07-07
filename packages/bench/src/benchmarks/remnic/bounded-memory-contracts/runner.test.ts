import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  runBoundedMemoryContractsBenchmark,
  boundedMemoryContractsDefinition,
} from "./runner.js";
import {
  BOUNDED_MEMORY_FIXTURE,
  BOUNDED_MEMORY_SMOKE_FIXTURE,
  fixtureHash,
} from "./fixture.js";
import {
  assemblePack,
  BOUNDED_MEMORY_CONTRACT,
  classifySkillTrigger,
  simulateAgent,
  buildSkillTriggerLog,
} from "./agent.js";
import { scoreTaskPair, aggregateCondition } from "./scoring.js";
import {
  listBenchmarks,
  getBenchmark,
  getRegisteredBenchmark,
} from "../../../registry.js";
import { BENCHMARK_RESULT_SCHEMA } from "../../../schema.js";
import type { ResolvedRunBenchmarkOptions } from "../../../types.js";

function options(
  overrides: Partial<ResolvedRunBenchmarkOptions> = {},
): ResolvedRunBenchmarkOptions {
  return {
    mode: "quick",
    benchmark: boundedMemoryContractsDefinition,
    system: {
      describe: () => "fake",
      store: async () => undefined,
      query: async () => "",
      recall: async () => "",
      search: async () => [],
      reset: async () => undefined,
      getStats: async () => ({ totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 }),
      destroy: async () => undefined,
    },
    ...overrides,
  } as unknown as ResolvedRunBenchmarkOptions;
}

/**
 * Pull the per-condition aggregate bundles off a result. `benchmarkOptions` is
 * optional on BenchmarkResult; this narrows it once so the five tests below
 * read cleanly without re-casting (and without growing the test-typecheck
 * baseline with TS18048 "possibly undefined" entries).
 */
function conditionsOf(
  result: { config: { benchmarkOptions?: Record<string, unknown> } },
): Record<string, Record<string, number>> {
  return (result.config.benchmarkOptions as {
    conditions: Record<string, Record<string, number>>;
  }).conditions;
}

// ---------------------------------------------------------------------------
// Registry integration
// ---------------------------------------------------------------------------

test("registry: bounded-memory-contracts is registered and resolvable", () => {
  const all = listBenchmarks();
  assert.ok(
    all.some((b) => b.id === "bounded-memory-contracts"),
    "bounded-memory-contracts must appear in listBenchmarks()",
  );
  assert.equal(getBenchmark("bounded-memory-contracts")?.id, "bounded-memory-contracts");
  const registered = getRegisteredBenchmark("bounded-memory-contracts");
  assert.ok(registered, "must have a registered runner");
  assert.equal(typeof registered?.run, "function");
});

test("registry: bounded-memory-contracts is tier=remnic, status=ready, runnerAvailable", () => {
  assert.equal(boundedMemoryContractsDefinition.tier, "remnic");
  assert.equal(boundedMemoryContractsDefinition.status, "ready");
  assert.equal(boundedMemoryContractsDefinition.runnerAvailable, true);
});

// ---------------------------------------------------------------------------
// Fixture shape
// ---------------------------------------------------------------------------

test("fixture: smoke subset spans all 7 families; full fixture has 12-20 tasks", () => {
  const families = new Set(BOUNDED_MEMORY_FIXTURE.map((t) => t.family));
  const expected = new Set([
    "recall-needed",
    "stale-memory-trap",
    "wrong-scope-trap",
    "skill-positive",
    "skill-negative",
    "ask-needed",
    "act-when-enough",
  ]);
  assert.deepEqual([...families].sort(), [...expected].sort(), "full fixture covers all 7 families");
  assert.ok(
    BOUNDED_MEMORY_FIXTURE.length >= 12 && BOUNDED_MEMORY_FIXTURE.length <= 20,
    `full fixture size ${BOUNDED_MEMORY_FIXTURE.length} must be 12-20`,
  );
  const smokeFamilies = new Set(BOUNDED_MEMORY_SMOKE_FIXTURE.map((t) => t.family));
  assert.deepEqual([...smokeFamilies].sort(), [...expected].sort(), "smoke subset covers all 7 families");
});

test("fixture: stable fixtureHash is deterministic", () => {
  assert.equal(fixtureHash(), fixtureHash(), "fixtureHash must be stable across calls");
  assert.match(fixtureHash(), /^[0-9a-f]{64}$/, "fixtureHash is a 64-hex SHA-256 digest");
});

// ---------------------------------------------------------------------------
// End-to-end quick run
// ---------------------------------------------------------------------------

test("runner: quick run emits one task per (task × condition) with all 4 conditions", async () => {
  const result = await runBoundedMemoryContractsBenchmark(options());
  const expectedPairs = BOUNDED_MEMORY_SMOKE_FIXTURE.length * 4;
  assert.equal(result.results.tasks.length, expectedPairs, "4 conditions × smoke tasks");
  const conditions = new Set(result.results.tasks.map((t) => (t.details as { condition: string }).condition));
  assert.deepEqual([...conditions].sort(), [
    "no-memory",
    "raw-transcript",
    "typed-contract",
    "typed-plus-skills",
  ]);
});

test("runner: per-condition headline bundles attached to config.benchmarkOptions", async () => {
  const result = await runBoundedMemoryContractsBenchmark(options());
  const benchOpts = result.config.benchmarkOptions as {
    conditions: Record<string, { taskSuccessRate: number }>;
    skillTriggerLog: unknown[];
    contract: { id: string };
  };
  assert.ok(benchOpts.conditions, "conditions bundle must be present");
  for (const cond of ["no-memory", "raw-transcript", "typed-contract", "typed-plus-skills"]) {
    assert.ok(benchOpts.conditions[cond], `condition ${cond} aggregate missing`);
  }
  assert.ok(Array.isArray(benchOpts.skillTriggerLog), "skill trigger log present");
  assert.equal(benchOpts.contract.id, "bounded-memory-default");
});

// ---------------------------------------------------------------------------
// The differentiated outcomes the benchmark exists to demonstrate
// ---------------------------------------------------------------------------

test("hypothesis: C1 raw-transcript wins pure recall but loses governance traps", async () => {
  const result = await runBoundedMemoryContractsBenchmark(options({ mode: "full" }));
  const c = conditionsOf(result);
  // Recall parity on pure-recall (C1 is a fair baseline).
  assert.ok(
    c["raw-transcript"].relevantMemoryRecall >= c["typed-contract"].relevantMemoryRecall - 0.001,
    "C1 should recall as well as C2 on pure-recall tasks",
  );
  // C1 surfaces stale + wrong-scope; C2 excludes them.
  assert.equal(c["raw-transcript"].staleMemoryHarmRate, 1, "C1 surfaces every stale decoy");
  assert.equal(c["typed-contract"].staleMemoryHarmRate, 0, "C2 excludes stale decoys");
  assert.equal(c["raw-transcript"].wrongScopeRetrievalRate, 1, "C1 surfaces every wrong-scope decoy");
  assert.equal(c["typed-contract"].wrongScopeRetrievalRate, 0, "C2 excludes wrong-scope decoys");
  assert.equal(c["typed-contract"].supersessionRespectedRate, 1, "C2 respects supersession");
});

test("hypothesis: typed contract asks when needed; raw transcript violates the boundary", async () => {
  const result = await runBoundedMemoryContractsBenchmark(options({ mode: "full" }));
  const c = conditionsOf(result);
  assert.equal(c["typed-contract"].shouldAskAccuracy, 1, "C2 asks exactly when it should");
  assert.equal(c["typed-contract"].actionBoundaryViolationRate, 0, "C2 never violates the ask boundary");
  assert.equal(c["raw-transcript"].actionBoundaryViolationRate, 1, "C1 acts without the structured boundary note");
});

test("hypothesis: C3 triggers skills positively and declines negative triggers", () => {
  const log = buildSkillTriggerLog(BOUNDED_MEMORY_FIXTURE);
  const deploySkill = "skill:deploy-gateway";
  // skill-positive: deploy-gateway fires on the deploy task.
  const posDeploy = log.find((e) => e.taskId === "skill-deploy-gateway" && e.skillId === deploySkill);
  assert.ok(posDeploy?.injected, "deploy skill must trigger on the positive task");
  assert.equal(posDeploy?.outcome, "helped");
  // skill-negative: the question form must NOT trigger.
  const negDeploy = log.find((e) => e.taskId === "skill-deploy-gateway-question" && e.skillId === deploySkill);
  assert.ok(negDeploy && !negDeploy.injected, "deploy skill must NOT trigger on the negative task");
  assert.match(negDeploy!.triggerReason, /doesNotApplyWhen/);
});

test("hypothesis: typed contract appends NO raw transcript", async () => {
  const recallTask = BOUNDED_MEMORY_FIXTURE.find((t) => t.id === "recall-framework-choice")!;
  const pack = assemblePack(recallTask, "typed-contract", BOUNDED_MEMORY_CONTRACT, []);
  assert.equal(pack.transcriptBlock, null, "C2 pack must carry no transcript block");
  // C1 must carry one.
  const c1 = assemblePack(recallTask, "raw-transcript", BOUNDED_MEMORY_CONTRACT, []);
  assert.ok(c1.transcriptBlock && c1.transcriptBlock.length > 0, "C1 must carry a transcript block");
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("runner: identical mode → identical datasetHash and identical aggregate task-success", async () => {
  const a = await runBoundedMemoryContractsBenchmark(options({ seed: 42 }));
  const b = await runBoundedMemoryContractsBenchmark(options({ seed: 42 }));
  assert.equal(a.meta.datasetHash, b.meta.datasetHash);
  const ca = conditionsOf(a);
  const cb = conditionsOf(b);
  for (const cond of Object.keys(ca)) {
    assert.equal(ca[cond].taskSuccessRate, cb[cond].taskSuccessRate, `${cond} must be deterministic`);
  }
});

test("runner: datasetHash matches the standalone fixture hash", async () => {
  const result = await runBoundedMemoryContractsBenchmark(options());
  // Quick mode serves the smoke subset, so the digest must hash THAT slice —
  // not the full 16-task fixture (a run with --limit would differ again).
  assert.equal(result.meta.datasetHash, fixtureHash(BOUNDED_MEMORY_SMOKE_FIXTURE));
  assert.notEqual(result.meta.datasetHash, fixtureHash(BOUNDED_MEMORY_FIXTURE),
    "quick-mode digest must differ from the full-fixture digest");
});

// ---------------------------------------------------------------------------
// Artifact emission
// ---------------------------------------------------------------------------

test("runner: writes prompt packs + retrieval + scores + report when outputDir is set", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-bmc-artifacts-"));
  try {
    const result = await runBoundedMemoryContractsBenchmark(options({ outputDir: dir }));
    const report = (result.config.benchmarkOptions as { artifactReport?: string }).artifactReport;
    assert.ok(report, "artifactReport path returned");

    const reportMd = await readFile(path.join(dir, "report.md"), "utf8");
    assert.match(reportMd, /Bounded Memory Contracts/);
    assert.match(reportMd, /Safe vs unsupported claims/);

    const agg = await readFile(path.join(dir, "scores", "aggregate.json"), "utf8");
    assert.ok(JSON.parse(agg)["typed-contract"], "aggregate.json has typed-contract bundle");

    const csv = await readFile(path.join(dir, "scores", "per-task.csv"), "utf8");
    assert.match(csv, /task_id,condition,family/);

    const condDirs = await readdir(path.join(dir, "conditions"));
    assert.ok(condDirs.includes("no-memory"));
    assert.ok(condDirs.includes("typed-plus-skills"));

    const prompts = await readdir(path.join(dir, "prompts"));
    assert.ok(prompts.some((f) => f.endsWith(".no-memory.md")));
    assert.ok(prompts.some((f) => f.endsWith(".raw-transcript.md")));

    const retrieval = await readdir(path.join(dir, "retrieval"));
    assert.ok(retrieval.some((f) => f.endsWith(".typed-contract.json")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Skill-trigger precision/recall aggregation
// ---------------------------------------------------------------------------

test("scoring: C3 aggregate reports full trigger precision (no false positives)", async () => {
  const result = await runBoundedMemoryContractsBenchmark(options({ mode: "full" }));
  const c3 = conditionsOf(result)["typed-plus-skills"];
  assert.equal(c3.skillFalsePositiveRate, 0, "rule-based classifier declines negative triggers");
  assert.ok(c3.skillHelpedCount >= 2, "both skill-positive tasks helped");
  assert.ok(c3.skillTriggerPrecision > 0, "precision is non-zero when skills fire");
});

// ---------------------------------------------------------------------------
// Schema round-trip
// ---------------------------------------------------------------------------

test("runner: emitted result validates against BENCHMARK_RESULT_SCHEMA", async () => {
  const result = await runBoundedMemoryContractsBenchmark(options());
  // The schema is a JSON-schema object; validate by its required-key contract
  // (the publishing pipeline consumes it the same way).
  const required = BENCHMARK_RESULT_SCHEMA.required as readonly string[];
  for (const key of required) {
    assert.ok(key in result, `result missing required top-level key ${key}`);
  }
  assert.equal(result.meta.benchmark, "bounded-memory-contracts");
  assert.equal(result.meta.datasetHash, fixtureHash(BOUNDED_MEMORY_SMOKE_FIXTURE));
});

// ---------------------------------------------------------------------------
// Unit: scoreTaskPair on a known stale trap
// ---------------------------------------------------------------------------

test("unit: stale trap — C1 surfaces stale (harm=1), C2 excludes it (supersession=1)", () => {
  const task = BOUNDED_MEMORY_FIXTURE.find((t) => t.id === "stale-ci-provider")!;
  const c1Pack = assemblePack(task, "raw-transcript", BOUNDED_MEMORY_CONTRACT, []);
  const c2Pack = assemblePack(task, "typed-contract", BOUNDED_MEMORY_CONTRACT, []);
  const c1Decision = simulateAgent(task, c1Pack, []);
  const c2Decision = simulateAgent(task, c2Pack, []);
  const c1Scores = scoreTaskPair(task, c1Pack, c1Decision);
  const c2Scores = scoreTaskPair(task, c2Pack, c2Decision);
  assert.equal(c1Scores.stale_memory_harm_rate, 1, "C1 surfaces the superseded fact");
  assert.equal(c1Scores.task_success, 0, "C1 picks the stale answer → wrong");
  assert.equal(c2Scores.supersession_respected_rate, 1, "C2 excludes the superseded fact");
  assert.equal(c2Scores.task_success, 1, "C2 picks the correction → right");
});
