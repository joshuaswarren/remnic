import assert from "node:assert/strict";
import test from "node:test";

import { PUBLISHED_BENCHMARK_ARTIFACT_IDS } from "./published-artifact.js";
import { getBenchmark, getRegisteredBenchmark, listBenchmarks } from "./registry.js";

const LEGACY_EVAL_BENCHMARK_IDS = [
  "ama-bench",
  "amemgym",
  "locomo",
  "longmemeval",
  "memory-arena",
] as const;

test("registry covers every legacy eval benchmark id with a published runner", () => {
  const registered = new Set(listBenchmarks().map((benchmark) => benchmark.id));
  for (const id of LEGACY_EVAL_BENCHMARK_IDS) {
    assert.ok(registered.has(id), `${id} must be registered in @remnic/bench`);
    const definition = getBenchmark(id);
    assert.equal(definition?.tier, "published", `${id} must be tier "published"`);
    assert.equal(
      definition?.runnerAvailable,
      true,
      `${id} must advertise an available runner`,
    );
    assert.equal(
      typeof getRegisteredBenchmark(id)?.run,
      "function",
      `${id} must have a registered run function`,
    );
    assert.ok(
      (PUBLISHED_BENCHMARK_ARTIFACT_IDS as readonly string[]).includes(id),
      `${id} must be in PUBLISHED_BENCHMARK_ARTIFACT_IDS`,
    );
  }
});
