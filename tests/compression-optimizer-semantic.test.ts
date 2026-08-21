import test from "node:test";
import assert from "node:assert/strict";
import {
  computeCompressionGuidelineCandidate,
  refineCompressionGuidelineCandidateSemantically,
} from "../src/compression-optimizer.ts";
import type { MemoryActionEvent } from "../src/types.ts";

function baselineCandidate() {
  const events: MemoryActionEvent[] = [
    { timestamp: "2026-02-27T00:00:00.000Z", action: "summarize_node", outcome: "applied", reason: "recall_good" },
    { timestamp: "2026-02-27T00:01:00.000Z", action: "summarize_node", outcome: "applied", reason: "recall_good" },
    { timestamp: "2026-02-27T00:02:00.000Z", action: "summarize_node", outcome: "applied", reason: "recall_good" },
    { timestamp: "2026-02-27T00:03:00.000Z", action: "summarize_node", outcome: "applied", reason: "recall_good" },
    { timestamp: "2026-02-27T00:04:00.000Z", action: "summarize_node", outcome: "applied", reason: "recall_good" },
  ];
  return computeCompressionGuidelineCandidate(events, {
    generatedAtIso: "2026-02-27T01:00:00.000Z",
  });
}

test("semantic refinement is no-op when disabled", async () => {
  const baseline = baselineCandidate();
  const refined = await refineCompressionGuidelineCandidateSemantically(baseline, {
    enabled: false,
    timeoutMs: 50,
    runRefinement: async () => ({ updates: [{ action: "summarize_node", delta: -0.1 }] }),
  });

  assert.deepEqual(refined, baseline);
});

test("semantic refinement fail-opens on timeout", async () => {
  const baseline = baselineCandidate();
  const refined = await refineCompressionGuidelineCandidateSemantically(baseline, {
    enabled: true,
    timeoutMs: 10,
    runRefinement: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { updates: [{ action: "summarize_node", delta: -0.1 }] };
    },
  });

  assert.deepEqual(refined, baseline);
});

test("semantic refinement timeout does not leak late rejections", async () => {
  const baseline = baselineCandidate();
  let unhandled: unknown = null;
  const onUnhandled = (reason: unknown) => {
    unhandled = reason;
  };
  process.once("unhandledRejection", onUnhandled);

  try {
    const refined = await refineCompressionGuidelineCandidateSemantically(baseline, {
      enabled: true,
      timeoutMs: 5,
      runRefinement: async () => {
        await new Promise((_, reject) => setTimeout(() => reject(new Error("late failure")), 30));
        return { updates: [] };
      },
    });

    assert.deepEqual(refined, baseline);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(unhandled, null);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("semantic refinement fail-opens on runner error", async () => {
  const baseline = baselineCandidate();
  const refined = await refineCompressionGuidelineCandidateSemantically(baseline, {
    enabled: true,
    timeoutMs: 50,
    runRefinement: async () => {
      throw new Error("runner failed");
    },
  });

  assert.deepEqual(refined, baseline);
});

test("semantic refinement applies bounded update patches", async () => {
  const baseline = baselineCandidate();
  const refined = await refineCompressionGuidelineCandidateSemantically(baseline, {
    enabled: true,
    timeoutMs: 50,
    runRefinement: async () => ({
      updates: [
        {
          action: "summarize_node",
          delta: 0.5,
          confidence: "high",
          note: "Semantic pass recommends slight increase based on context coherence.",
        },
      ],
    }),
  });

  const before = baseline.ruleUpdates.find((rule) => rule.action === "summarize_node");
  const after = refined.ruleUpdates.find((rule) => rule.action === "summarize_node");
  assert.ok(before);
  assert.ok(after);
  assert.equal(after?.delta, 0.15);
  assert.equal(after?.direction, "increase");
  assert.equal(after?.confidence, "high");
  assert.equal(after?.notes[0]?.includes("Semantic pass"), true);
});
