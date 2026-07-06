import test from "node:test";
import assert from "node:assert/strict";
import {
  runMemCorrectBenchmark,
  memcorrectDefinition,
  summarizeAggregateMetrics,
} from "./runner.js";
import { generateMemCorrectCorpus, corpusHash } from "./generator.js";
import { PromptOnlyBaselineAdapter } from "./adapters.js";
import {
  listBenchmarks,
  getBenchmark,
  getRegisteredBenchmark,
} from "../../../registry.js";
import { BENCHMARK_RESULT_SCHEMA } from "../../../schema.js";
import type { ResolvedRunBenchmarkOptions } from "../../../types.js";
import type { MemCorrectSystemAdapter } from "./types.js";

function options(
  overrides: Partial<ResolvedRunBenchmarkOptions> = {},
): ResolvedRunBenchmarkOptions {
  return {
    mode: "quick",
    benchmark: memcorrectDefinition,
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

// ---------------------------------------------------------------------------
// Registry integration
// ---------------------------------------------------------------------------

test("registry: memcorrect-v1 is registered and resolvable", () => {
  const all = listBenchmarks();
  assert.ok(
    all.some((b) => b.id === "memcorrect-v1"),
    "memcorrect-v1 must appear in listBenchmarks()",
  );
  assert.equal(getBenchmark("memcorrect-v1")?.id, "memcorrect-v1");
  const registered = getRegisteredBenchmark("memcorrect-v1");
  assert.ok(registered, "memcorrect-v1 must have a registered runner");
  assert.equal(typeof registered?.run, "function");
});

test("registry: memcorrect-v1 is tier=remnic, status=ready, runnerAvailable", () => {
  assert.equal(memcorrectDefinition.tier, "remnic");
  assert.equal(memcorrectDefinition.status, "ready");
  assert.equal(memcorrectDefinition.runnerAvailable, true);
});

// ---------------------------------------------------------------------------
// End-to-end with the prompt-only baseline
// ---------------------------------------------------------------------------

test("runner: baseline run emits one task per scenario with all 7 score keys", async () => {
  const result = await runMemCorrectBenchmark(
    options({
      benchmarkOptions: { adapter: new PromptOnlyBaselineAdapter() },
      limit: 4,
    }),
  );
  assert.ok(result.results.tasks.length === 4, "limit=4 → 4 tasks");
  const expected = [
    "uptake_at_next",
    "uptake_latency",
    "non_resurrection",
    "collateral_delta",
    "scope_precision",
    "false_apply",
    "reassertion",
  ];
  for (const task of result.results.tasks) {
    for (const key of expected) {
      assert.ok(key in task.scores, `task ${task.taskId} missing score ${key}`);
    }
  }
  // Aggregate headline bundle present in config.benchmarkOptions.
  const bundle = summarizeAggregateMetrics(result);
  assert.ok(bundle, "aggregate bundle must be attached");
  assert.ok("uptake_at_next" in bundle);
  assert.ok("provenance_fidelity" in bundle);
});

test("runner: baseline scores near-zero on non_resurrection-under-reingest (the structural floor)", async () => {
  // The append-everything baseline never retires anything, so re-ingesting
  // the original transcript re-surfaces the retired fact. non_resurrection
  // must collapse toward 0 — this is the sanity requirement from the issue
  // (baseline near-zero, Remnic must not).
  const result = await runMemCorrectBenchmark(
    options({
      benchmarkOptions: { adapter: new PromptOnlyBaselineAdapter() },
      limit: 6,
    }),
  );
  const bundle = summarizeAggregateMetrics(result);
  assert.ok(bundle, "bundle missing");
  assert.ok(
    bundle.non_resurrection < 0.5,
    `baseline non_resurrection should be low (re-ingest resurrects), got ${bundle.non_resurrection}`,
  );
});

// ---------------------------------------------------------------------------
// Determinism: two runs, same seed, identical corpus hash + identical metrics
// ---------------------------------------------------------------------------

test("runner: identical seed → identical datasetHash and identical deterministic metrics", async () => {
  const seed = 4242;
  const r1 = await runMemCorrectBenchmark(
    options({
      seed,
      benchmarkOptions: { adapter: new PromptOnlyBaselineAdapter() },
      limit: 4,
    }),
  );
  const r2 = await runMemCorrectBenchmark(
    options({
      seed,
      benchmarkOptions: { adapter: new PromptOnlyBaselineAdapter() },
      limit: 4,
    }),
  );
  assert.equal(r1.meta.datasetHash, r2.meta.datasetHash);
  // Per-task deterministic metrics identical (latency is non-deterministic,
  // so compare scores only).
  for (let i = 0; i < r1.results.tasks.length; i += 1) {
    assert.deepEqual(
      r1.results.tasks[i].scores,
      r2.results.tasks[i].scores,
      `task ${i} metrics diverged`,
    );
  }
});

test("runner: datasetHash matches the standalone corpus hash for the same seed", async () => {
  const seed = 4242;
  const result = await runMemCorrectBenchmark(
    options({
      seed,
      benchmarkOptions: { adapter: new PromptOnlyBaselineAdapter() },
      limit: 2,
    }),
  );
  // The runner uses QUICK_OPTIONS shape with the override seed; the corpus
  // hash is over ALL scenarios (limit only trims which run), so compare
  // against the full quick corpus.
  const corpus = generateMemCorrectCorpus({
    personaCount: 2,
    factsPerPersona: 4,
    seed,
    nowIso: "2026-07-05T00:00:00.000Z",
    maintenanceCycles: 3,
    uptakeLatencyCap: 5,
  });
  assert.equal(result.meta.datasetHash, corpusHash(corpus));
});

// ---------------------------------------------------------------------------
// Adapter resolution
// ---------------------------------------------------------------------------

test("runner: benchmarkOptions.adapter is used when it satisfies the MemCorrect contract", async () => {
  let resetCalls = 0;
  const custom: MemCorrectSystemAdapter = {
    label: "custom-fake",
    async reset() {
      resetCalls += 1;
    },
    async ingestTurn() {},
    async recall() {
      return [];
    },
    async correct() {},
    async runMaintenance() {},
  };
  const result = await runMemCorrectBenchmark(
    options({
      benchmarkOptions: { adapter: custom },
      limit: 2,
    }),
  );
  assert.equal(result.config.adapterMode, "custom-fake");
  assert.ok(resetCalls >= 2, `reset should run per scenario, got ${resetCalls}`);
});

// ---------------------------------------------------------------------------
// Schema round-trip
// ---------------------------------------------------------------------------

test("runner: emitted result validates against BENCHMARK_RESULT_SCHEMA", async () => {
  const result = await runMemCorrectBenchmark(
    options({
      benchmarkOptions: { adapter: new PromptOnlyBaselineAdapter() },
      limit: 3,
    }),
  );
  // The schema is a JSON-schema object; validate by shape via the schema's
  // required-key contract. (BENCHMARK_RESULT_SCHEMA is consumed by the
  // publishing pipeline; here we assert the structural invariants it pins.)
  const required: readonly string[] = BENCHMARK_RESULT_SCHEMA.required;
  for (const key of required) {
    assert.ok(key in result, `result missing required top-level key ${key}`);
  }
  assert.ok(result.meta.datasetHash?.length === 64, "datasetHash must be sha-256");
  assert.deepEqual(result.meta.seeds, [0xc077e7 & 0xffffffff]);
  assert.equal(result.meta.benchmark, "memcorrect-v1");
});

// ---------------------------------------------------------------------------
// Runtime-profile compatibility (the bench must accept a resolved profile)
// ---------------------------------------------------------------------------

test("runner: accepts a local-lab runtime profile without changing the hermetic corpus", async () => {
  const result = await runMemCorrectBenchmark(
    options({
      runtimeProfile: "local-lab",
      benchmarkOptions: { adapter: new PromptOnlyBaselineAdapter() },
      limit: 2,
    }),
  );
  assert.equal(result.config.runtimeProfile, "local-lab");
  // The hermetic corpus hash is independent of the runtime profile.
  const baseline = await runMemCorrectBenchmark(
    options({
      benchmarkOptions: { adapter: new PromptOnlyBaselineAdapter() },
      limit: 2,
    }),
  );
  assert.equal(result.meta.datasetHash, baseline.meta.datasetHash);
});

test("runner: onTaskComplete fires for each scenario with a correct total", async () => {
  const completed: Array<{ count: number; total?: number }> = [];
  await runMemCorrectBenchmark(
    options({
      benchmarkOptions: { adapter: new PromptOnlyBaselineAdapter() },
      limit: 3,
      onTaskComplete: (_task, count, total) => {
        completed.push({ count, total });
      },
    }),
  );
  assert.equal(completed.length, 3);
  assert.deepEqual(
    completed.map((c) => c.count),
    [1, 2, 3],
  );
  assert.ok(completed.every((c) => c.total === 3));
});
