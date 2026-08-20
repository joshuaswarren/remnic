import assert from "node:assert/strict";
import test from "node:test";

import { MS_PER_DAY } from "./privacy.js";
import {
  ACTIVITY_DELETE_SCOPES,
  planActivityDeletion,
  type ActivityDeleteCandidate,
} from "./privacy-delete-plan.js";

const NOW = 100 * MS_PER_DAY;

function cand(
  scope: string,
  relPath: string,
  capturedAtMs: number,
): ActivityDeleteCandidate {
  return { scope, relPath, capturedAtMs };
}

function plan(
  candidates: readonly ActivityDeleteCandidate[],
  overrides: Partial<Parameters<typeof planActivityDeletion>[0]> = {},
) {
  return planActivityDeletion({
    candidates,
    scopes: ACTIVITY_DELETE_SCOPES,
    retentionDays: 30,
    nowMs: NOW,
    ...overrides,
  });
}

test("expired in-scope activity paths are planned across every owned root", () => {
  const expired = NOW - 40 * MS_PER_DAY;
  const result = plan([
    cand("observations", "activity/2026-01-01.md", expired),
    cand("cards", "wearables/limitless/2026-01-01.md", expired),
    cand("journal", "meetings/2026-01-01/mtg-x.md", expired),
  ]);
  assert.deepEqual(result.deletePaths, [
    "activity/2026-01-01.md",
    "meetings/2026-01-01/mtg-x.md",
    "wearables/limitless/2026-01-01.md",
  ]);
  assert.equal(result.keptCount, 0);
  assert.deepEqual(result.refused, []);
});

test("fresh in-scope candidates are kept, not deleted", () => {
  const result = plan([cand("observations", "activity/2026-08-19.md", NOW - MS_PER_DAY)]);
  assert.deepEqual(result.deletePaths, []);
  assert.equal(result.keptCount, 1);
  assert.deepEqual(result.refused, []);
});

test("retentionDays 0 deletes nothing but counts kept", () => {
  const ancient = NOW - 4000 * MS_PER_DAY;
  const result = plan([cand("weekly", "activity/2015-01-01.md", ancient)], {
    retentionDays: 0,
  });
  assert.deepEqual(result.deletePaths, []);
  assert.equal(result.keptCount, 1);
});

test("facts paths are refused even when expired and in scope", () => {
  const expired = NOW - 40 * MS_PER_DAY;
  const result = plan([cand("observations", "facts/2026-01-01/fact-1.md", expired)]);
  assert.deepEqual(result.deletePaths, []);
  assert.deepEqual(result.refused, ["facts/2026-01-01/fact-1.md"]);
  assert.equal(result.keptCount, 0);
});

test("profile.md, entities, and state files are refused", () => {
  const expired = NOW - 40 * MS_PER_DAY;
  const result = plan([
    cand("journal", "profile.md", expired),
    cand("journal", "entities/person-a.md", expired),
    cand("providerCache", "state/buffer.json", expired),
  ]);
  assert.deepEqual(result.deletePaths, []);
  assert.deepEqual(result.refused, ["entities/person-a.md", "profile.md", "state/buffer.json"]);
});

test("absolute, traversal, and blank paths are refused", () => {
  const expired = NOW - 40 * MS_PER_DAY;
  const result = plan([
    cand("observations", "/etc/passwd", expired),
    cand("observations", "activity/../../facts/fact-1.md", expired),
    cand("observations", "   ", expired),
  ]);
  assert.deepEqual(result.deletePaths, []);
  assert.deepEqual(result.refused, [
    "   ",
    "/etc/passwd",
    "activity/../../facts/fact-1.md",
  ]);
});

test("unknown candidate scope is refused", () => {
  const expired = NOW - 40 * MS_PER_DAY;
  const result = plan([cand("bogus", "activity/2026-01-01.md", expired)]);
  assert.deepEqual(result.deletePaths, []);
  assert.deepEqual(result.refused, ["activity/2026-01-01.md"]);
  assert.equal(result.keptCount, 0);
});

test("scope absent from scopes is skipped entirely", () => {
  const expired = NOW - 40 * MS_PER_DAY;
  const result = plan([cand("cards", "activity/2026-01-01.md", expired)], {
    scopes: ["observations"],
  });
  assert.deepEqual(result.deletePaths, []);
  assert.deepEqual(result.refused, []);
  assert.equal(result.keptCount, 0);
});

test("unknown value in scopes throws RangeError", () => {
  assert.throws(
    () => plan([], { scopes: ["observations", "everything"] }),
    (error: unknown) => error instanceof RangeError && /scope/.test(error.message),
  );
});

test("negative or float retentionDays throws RangeError", () => {
  assert.throws(
    () => plan([], { retentionDays: -1 }),
    (error: unknown) => error instanceof RangeError && /retentionDays/.test(error.message),
  );
  assert.throws(
    () => plan([], { retentionDays: 2.5 }),
    (error: unknown) => error instanceof RangeError && /retentionDays/.test(error.message),
  );
});

test("non-finite nowMs throws RangeError", () => {
  assert.throws(
    () => plan([], { nowMs: Number.POSITIVE_INFINITY }),
    (error: unknown) => error instanceof RangeError && /nowMs/.test(error.message),
  );
  assert.throws(
    () => plan([], { nowMs: Number.NaN }),
    (error: unknown) => error instanceof RangeError && /nowMs/.test(error.message),
  );
});

test("deletePaths and refused are sorted and deduplicated", () => {
  const expired = NOW - 40 * MS_PER_DAY;
  const result = plan([
    cand("observations", "activity/b.md", expired),
    cand("cards", "activity/a.md", expired),
    cand("journal", "activity/b.md", expired),
    cand("observations", "facts/z.md", expired),
    cand("cards", "facts/z.md", expired),
  ]);
  assert.deepEqual(result.deletePaths, ["activity/a.md", "activity/b.md"]);
  assert.deepEqual(result.refused, ["facts/z.md"]);
});

test("half-open boundary: age exactly retentionDays * MS_PER_DAY is deleted", () => {
  const boundary = NOW - 30 * MS_PER_DAY;
  const result = plan([
    cand("observations", "activity/boundary.md", boundary),
    cand("observations", "activity/inside.md", boundary + 1),
  ]);
  assert.deepEqual(result.deletePaths, ["activity/boundary.md"]);
  assert.equal(result.keptCount, 1);
});

test("input candidates are not mutated", () => {
  const candidates = [
    cand("observations", "activity/2026-01-01.md", NOW - 40 * MS_PER_DAY),
    cand("observations", "facts/2026-01-01/fact-1.md", NOW - 40 * MS_PER_DAY),
  ];
  const snapshot = structuredClone(candidates);
  plan(candidates);
  assert.deepEqual(candidates, snapshot);
});

// Review round 1: the planner trimmed relPath before validating it, so
// " activity/x.md" validated as owned and the plan then targeted
// "activity/x.md" — a path the caller never supplied.
test("a path with surrounding whitespace is refused, not normalized into a delete", () => {
  const expired = 0;
  for (const relPath of [" activity/day.md", "activity/day.md ", "\tactivity/day.md"]) {
    const plan = planActivityDeletion({
      candidates: [{ scope: "cards", relPath, capturedAtMs: expired }],
      scopes: ["cards"],
      retentionDays: 1,
      nowMs: 10 * 86_400_000,
    });
    assert.deepEqual(plan.deletePaths, [], `${JSON.stringify(relPath)} must not be planned`);
    assert.deepEqual(plan.refused, [relPath], "the exact candidate path is reported as refused");
  }
});

// Review round 1: every comparison against NaN is false, so shouldRetain
// reported "not retained" and a corrupt timestamp resolved toward deletion.
test("a non-finite capturedAtMs is refused instead of deleted", () => {
  for (const capturedAtMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const plan = planActivityDeletion({
      candidates: [{ scope: "cards", relPath: "activity/corrupt.md", capturedAtMs }],
      scopes: ["cards"],
      retentionDays: 1,
      nowMs: 10 * 86_400_000,
    });
    assert.deepEqual(
      plan.deletePaths,
      [],
      `capturedAtMs ${String(capturedAtMs)} must never resolve toward deletion`,
    );
    assert.deepEqual(plan.refused, ["activity/corrupt.md"]);
    assert.equal(plan.keptCount, 0);
  }
});
