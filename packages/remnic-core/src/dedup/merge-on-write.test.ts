import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyMergeOnWrite,
  judgeMergeDecision,
  shouldConsiderMerge,
  type MergeJudgeVerdict,
  type MergeOnWritePair,
} from "./merge-on-write.js";


function pair(overrides: Partial<MergeOnWritePair> = {}): MergeOnWritePair {
  return {
    category: "fact",
    score: 0.85,
    incomingContent: "User prefers dark mode on laptops.",
    existingContent: "User likes dark mode.",
    existingId: "mem-1",
    ...overrides,
  };
}

const mergeJudge = async () => "merge" as const;

test("merge-on-write: skip band is not considered", () => {
  assert.equal(shouldConsiderMerge({ score: 0.92 }), false);
  assert.equal(shouldConsiderMerge({ score: 0.99 }), false);
});

test("merge-on-write: merge band is considered", () => {
  assert.equal(shouldConsiderMerge({ score: 0.8 }), true);
  assert.equal(shouldConsiderMerge({ score: 0.85 }), true);
  assert.equal(shouldConsiderMerge({ score: 0.919 }), true);
});

test("merge-on-write: score below mergeMin is not considered", () => {
  assert.equal(shouldConsiderMerge({ score: 0.79 }), false);
});

test("merge-on-write: refused categories always create", async () => {
  for (const category of ["procedure", "reasoning_trace", "moment", "correction"]) {
    const decision = await applyMergeOnWrite({
      enabled: true,
      pair: pair({ category }),
      judge: mergeJudge,
    });
    assert.equal(decision, "create", category);
  }
});

test("merge-on-write: judge throw creates", async () => {
  const viaJudge = await judgeMergeDecision(pair(), async () => {
    throw new Error("timeout");
  });
  assert.equal(viaJudge, "create");

  const viaApply = await applyMergeOnWrite({
    enabled: true,
    pair: pair(),
    judge: async () => {
      throw new Error("timeout");
    },
  });
  assert.equal(viaApply, "create");
});

test("merge-on-write: uncertain judge creates", async () => {
  const decision = await judgeMergeDecision(pair(), async (): Promise<MergeJudgeVerdict> => "uncertain");
  assert.equal(decision, "create");
});

test("merge-on-write: disabled or mergeMin 0 creates", async () => {
  let called = 0;
  const judge = async () => {
    called += 1;
    return "merge" as const;
  };

  assert.equal(await applyMergeOnWrite({ pair: pair(), judge }), "create");
  assert.equal(
    await applyMergeOnWrite({ enabled: false, pair: pair(), judge }),
    "create",
  );
  assert.equal(
    await applyMergeOnWrite({ enabled: true, mergeMin: 0, pair: pair(), judge }),
    "create",
  );
  assert.equal(called, 0);
});

test("merge-on-write: enabled in-band merge applies", async () => {
  const decision = await applyMergeOnWrite({
    enabled: true,
    pair: pair(),
    judge: mergeJudge,
  });
  assert.equal(decision, "merge");
});
