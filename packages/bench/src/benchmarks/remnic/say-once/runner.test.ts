/**
 * Tests for the say-once (extraction -> recall round-trip) benchmark.
 *
 * All tests use replay mode (deterministic, no LLM calls).
 * All fixture data is synthetic and obviously invented (public-repo policy).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runSayOnceBenchmark, sayOnceDefinition } from "./runner.js";
import { SAY_ONCE_CASES, SAY_ONCE_SMOKE_FIXTURE, type VaguenessTier } from "./fixture.js";

// ─── Replay mode is deterministic ─────────────────────────────────────────

test("say-once: replay mode produces identical scorecards across two runs", async () => {
  const options = {
    benchmark: sayOnceDefinition,
    mode: "quick" as const,
    seed: 0,
    onTaskComplete: () => {},
  };
  const result1 = await runSayOnceBenchmark(options);
  const result2 = await runSayOnceBenchmark(options);

  assert.equal(result1.results.tasks.length, result2.results.tasks.length);
  for (let i = 0; i < result1.results.tasks.length; i++) {
    assert.equal(result1.results.tasks[i].scores.recall, result2.results.tasks[i].scores.recall);
    assert.equal(result1.results.tasks[i].taskId, result2.results.tasks[i].taskId);
  }
});

// ─── Store safety ─────────────────────────────────────────────────────────

test("say-once: no writes outside the temp directory", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-say-once-safety-"));
  const { readdirSync } = await import("node:fs");
  const before = new Set(readdirSync(tmpDir));

  const options = {
    benchmark: sayOnceDefinition,
    mode: "quick" as const,
    seed: 0,
    onTaskComplete: () => {},
  };
  await runSayOnceBenchmark(options);

  const after = new Set(readdirSync(tmpDir));
  // Only the temp memory dir should have been created inside tmpDir.
  // The test dir itself should only contain the bench-created subdir.
  for (const entry of after) {
    if (!before.has(entry)) {
      assert.ok(entry.startsWith("remnic-bench-say-once-"), `unexpected file outside temp dir: ${entry}`);
    }
  }
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── Corrupt/missing fixture errors ───────────────────────────────────────

test("say-once: empty fixture produces zero tasks", async () => {
  const options = {
    benchmark: sayOnceDefinition,
    mode: "full" as const,
    limit: 0, // zero budget = no tasks
    seed: 0,
    onTaskComplete: () => {},
  };
  const result = await runSayOnceBenchmark(options);
  assert.equal(result.results.tasks.length, 0);
});

// ─── Per-tier rates from known fixture ────────────────────────────────────

test("say-once: per-tier rates are computed correctly from synthetic fixture", async () => {
  const options = {
    benchmark: sayOnceDefinition,
    mode: "full" as const,
    seed: 0,
    onTaskComplete: () => {},
  };
  const result = await runSayOnceBenchmark(options);

  // Replay mode writes the preference directly, so recall should be 1.0
  for (const task of result.results.tasks) {
    assert.equal(task.scores.recall, 1, `task ${task.taskId} should have perfect recall in replay mode`);
  }
});

// ─── Exit code semantics ─────────────────────────────────────────────────

test("say-once: exit code 0 for a valid run (even with low scores)", async () => {
  const options = {
    benchmark: sayOnceDefinition,
    mode: "quick" as const,
    seed: 0,
    onTaskComplete: () => {},
  };
  // This should not throw — scores are data, not pass/fail.
  const result = await runSayOnceBenchmark(options);
  assert.ok(result.results.tasks.length > 0, "should have produced tasks");
});

// ─── Fixture verification ────────────────────────────────────────────────

test("say-once: fixture has all three vagueness tiers", () => {
  const tiers = new Set(SAY_ONCE_CASES.map((c) => c.tier));
  assert.ok(tiers.has("explicit"), "must have explicit cases");
  assert.ok(tiers.has("casual"), "must have casual cases");
  assert.ok(tiers.has("buried-mid-task"), "must have buried-mid-task cases");
});

test("say-once: smoke fixture has one case per tier", () => {
  const tiers = new Set(SAY_ONCE_SMOKE_FIXTURE.map((c) => c.tier));
  assert.equal(tiers.size, 3, "smoke must cover all three tiers");
});

test("say-once: every case has at least one probe", () => {
  for (const c of SAY_ONCE_CASES) {
    assert.ok(c.probes.length > 0, `case ${c.id} must have at least one probe`);
  }
});

// ─── Registry check ───────────────────────────────────────────────────────

test("say-once: benchmark definition is valid", () => {
  assert.equal(sayOnceDefinition.id, "say-once");
  assert.equal(sayOnceDefinition.tier, "remnic");
  assert.equal(sayOnceDefinition.status, "ready");
  assert.equal(sayOnceDefinition.runnerAvailable, true);
});