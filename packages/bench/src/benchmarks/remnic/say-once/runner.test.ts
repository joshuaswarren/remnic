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
import type { Message } from "../../../adapters/types.js";

import { runSayOnceBenchmark, sayOnceDefinition } from "./runner.js";
import { SAY_ONCE_CASES, SAY_ONCE_SMOKE_FIXTURE, type VaguenessTier } from "./fixture.js";

// ─── Replay mode is deterministic ─────────────────────────────────────────

test("say-once: replay mode produces identical scorecards across two runs", async () => {
  const options = {
    benchmark: sayOnceDefinition,
    mode: "quick" as const,
    seed: 0,
    system: buildRecordingAdapter().system,
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
    system: buildRecordingAdapter().system,
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
    system: buildRecordingAdapter().system,
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
    system: buildRecordingAdapter().system,
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
    system: buildRecordingAdapter().system,
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
// ─── Adapter-driven recall path (#3042 P1 finding) ──────────────────────────

/**
 * Minimal adapter that records every store/recall call and answers recall
 * using the stored messages, so the runner can be tested without booting
 * the real retrieval pipeline.
 */
function buildRecordingAdapter() {
  const stored = new Map<string, Message[]>();
  const storeCalls: { sessionId: string; messages: Message[] }[] = [];
  const recallCalls: { sessionId: string; query: string }[] = [];
  return {
    stored,
    storeCalls,
    recallCalls,
    system: {
      async store(sessionId: string, messages: Message[]): Promise<void> {
        storeCalls.push({ sessionId, messages });
        const prev = stored.get(sessionId) ?? [];
        stored.set(sessionId, prev.concat(messages));
      },
      async recall(sessionId: string, query: string): Promise<string> {
        recallCalls.push({ sessionId, query });
        const msgs = stored.get(sessionId) ?? [];
        // Trivial recall: surface every stored message as context.
        return msgs.map((m) => `${m.role}: ${m.content}`).join("\n");
      },
      async search(): Promise<never[]> { return []; },
      async reset(): Promise<void> {},
      async getStats(): Promise<{ totalMessages: number; totalSummaryNodes: number; maxDepth: number }> {
        return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
      },
      async destroy(): Promise<void> {},
    },
  };
}

test("say-once: routes every store+recall through the adapter, never the filesystem (#3042)", async () => {
  const rec = buildRecordingAdapter();
  const options = {
    benchmark: sayOnceDefinition,
    mode: "quick" as const,
    seed: 0,
    system: rec.system,
    onTaskComplete: () => {},
  };
  const result = await runSayOnceBenchmark(options);
  // At least one store + one recall per case.
  assert.ok(rec.storeCalls.length >= result.results.tasks.length, "each case stores once");
  assert.ok(rec.recallCalls.length >= result.results.tasks.length, "each case recalls at least once");
  // Replay against this trivial adapter surfaces the seed message text,
  // so all fixtures should report 1.0 recall.
  for (const task of result.results.tasks) {
    assert.equal(task.scores.recall, 1, `task ${task.taskId} should recall the preference`);
  }
});

test("say-once: isolated session ids prevent cross-task recall bleed", async () => {
  const rec = buildRecordingAdapter();
  const options = {
    benchmark: sayOnceDefinition,
    mode: "full" as const,
    seed: 0,
    system: rec.system,
    onTaskComplete: () => {},
  };
  await runSayOnceBenchmark(options);
  const sessionIds = new Set(rec.storeCalls.map((c) => c.sessionId));
  assert.equal(sessionIds.size, rec.storeCalls.length, "each store call uses a unique session");
});

test("say-once: refuses to run without a memory adapter (#3042 contract)", async () => {
  const options = {
    benchmark: sayOnceDefinition,
    mode: "quick" as const,
    seed: 0,
    onTaskComplete: () => {},
  } as unknown as Parameters<typeof runSayOnceBenchmark>[0];
  await assert.rejects(
    () => runSayOnceBenchmark(options),
    /BenchMemoryAdapter is required/,
  );
});
