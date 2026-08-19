import assert from "node:assert/strict";
import test from "node:test";

import {
  decideMergeOnWrite,
  type MergeCandidate,
  type MergeDecisionOptions,
} from "./merge-decision.js";

const OPTS: MergeDecisionOptions = { updateThreshold: 0.8, duplicateThreshold: 0.92 };

function candidate(overrides: Partial<MergeCandidate> = {}): MergeCandidate {
  return {
    id: "fact-1",
    similarity: 0.85,
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

test("no candidates creates", () => {
  assert.deepEqual(decideMergeOnWrite([], OPTS), { action: "create" });
});

test("best similarity at or above duplicateThreshold skips as duplicate", () => {
  assert.deepEqual(
    decideMergeOnWrite(
      [candidate({ id: "low", similarity: 0.5 }), candidate({ id: "dup", similarity: 0.92 })],
      OPTS,
    ),
    { action: "skip", reason: "duplicate" },
  );
});

test("best similarity between thresholds updates the best candidate", () => {
  assert.deepEqual(
    decideMergeOnWrite(
      [candidate({ id: "best", similarity: 0.9 }), candidate({ id: "worst", similarity: 0.81 })],
      OPTS,
    ),
    { action: "update", targetId: "best" },
  );
});

test("best similarity below updateThreshold creates", () => {
  assert.deepEqual(
    decideMergeOnWrite([candidate({ similarity: 0.79 })], OPTS),
    { action: "create" },
  );
});

test("invalid thresholds throw RangeError", () => {
  const bad: MergeDecisionOptions[] = [
    { updateThreshold: Number.NaN, duplicateThreshold: 0.9 },
    { updateThreshold: 0.8, duplicateThreshold: Number.POSITIVE_INFINITY },
    { updateThreshold: -0.1, duplicateThreshold: 0.9 },
    { updateThreshold: 0.8, duplicateThreshold: 1.1 },
    { updateThreshold: 0.92, duplicateThreshold: 0.8 }, // duplicate < update
  ];
  for (const options of bad) {
    assert.throws(() => decideMergeOnWrite([], options), RangeError);
  }
});

test("updateThreshold 0 is honored, never coerced up", () => {
  const zero = { updateThreshold: 0, duplicateThreshold: 0.92 };
  // similarity 0 is >= 0 -> update, not create and not default-band behavior
  assert.deepEqual(
    decideMergeOnWrite([candidate({ similarity: 0 })], zero),
    { action: "update", targetId: "fact-1" },
  );
  // no candidates still creates
  assert.deepEqual(decideMergeOnWrite([], zero), { action: "create" });
});

test("malformed candidates are ignored, never thrown on", () => {
  assert.deepEqual(
    decideMergeOnWrite(
      [
        { id: "", similarity: 0.99, updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "  ", similarity: 0.99, updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "nan", similarity: Number.NaN, updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "inf", similarity: Number.POSITIVE_INFINITY, updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "high", similarity: 1.5, updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "neg", similarity: -0.2, updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "good", similarity: 0.85, updatedAt: "2026-01-02T00:00:00.000Z" },
      ],
      OPTS,
    ),
    { action: "update", targetId: "good" },
  );
  // all-malformed behaves like no candidates
  assert.deepEqual(
    decideMergeOnWrite([{ id: "nan", similarity: Number.NaN, updatedAt: "x" }], OPTS),
    { action: "create" },
  );
});

test("identical similarity and updatedAt tie-breaks on id ascending, deterministically", () => {
  const candidates = [
    candidate({ id: "b", similarity: 0.9, updatedAt: "2026-03-01T00:00:00.000Z" }),
    candidate({ id: "a", similarity: 0.9, updatedAt: "2026-03-01T00:00:00.000Z" }),
    candidate({ id: "c", similarity: 0.9, updatedAt: "2026-03-01T00:00:00.000Z" }),
  ];
  const first = decideMergeOnWrite(candidates, OPTS);
  const second = decideMergeOnWrite([...candidates].reverse(), OPTS);
  assert.deepEqual(first, second);
  assert.deepEqual(first, { action: "update", targetId: "a" });
});

test("unparseable updatedAt sorts last", () => {
  const candidates = [
    candidate({ id: "bad-date", similarity: 0.9, updatedAt: "not-a-timestamp" }),
    candidate({ id: "good-date", similarity: 0.9, updatedAt: "2026-03-01T00:00:00.000Z" }),
  ];
  assert.deepEqual(decideMergeOnWrite(candidates, OPTS), { action: "update", targetId: "good-date" });
  // newer timestamp wins when both parse
  assert.deepEqual(
    decideMergeOnWrite(
      [
        candidate({ id: "older", updatedAt: "2026-01-01T00:00:00.000Z" }),
        candidate({ id: "newer", updatedAt: "2026-06-01T00:00:00.000Z" }),
      ],
      OPTS,
    ),
    { action: "update", targetId: "newer" },
  );
});

// Two unparseable timestamps must not make the comparator asymmetric: testing
// each side against NaN independently returned 1 for both orderings, so the
// winner depended on array order.
test("two unparseable updatedAt values break the tie by id, whatever the order", () => {
  const options = { updateThreshold: 0.5, duplicateThreshold: 0.95 };
  const alpha = { id: "alpha", similarity: 0.7, updatedAt: "not-a-date" };
  const beta = { id: "beta", similarity: 0.7, updatedAt: "also-not-a-date" };

  for (const candidates of [[alpha, beta], [beta, alpha]]) {
    assert.deepEqual(decideMergeOnWrite(candidates, options), {
      action: "update",
      targetId: "alpha",
    });
  }
});

test("a parseable updatedAt still outranks an unparseable one in both orders", () => {
  const options = { updateThreshold: 0.5, duplicateThreshold: 0.95 };
  const dated = { id: "zeta", similarity: 0.7, updatedAt: "2026-08-19T00:00:00.000Z" };
  const undated = { id: "alpha", similarity: 0.7, updatedAt: "nope" };

  for (const candidates of [[dated, undated], [undated, dated]]) {
    assert.deepEqual(decideMergeOnWrite(candidates, options), {
      action: "update",
      targetId: "zeta",
    });
  }
});
