import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_EXPAND_PER_STEP,
  selectExpandNodeIds,
} from "./recall-deep-expand-select.js";

const FRONTIER = ["n1", "n2", "n3", "n4", "n5"] as const;

test("subset request passes untruncated", () => {
  const result = selectExpandNodeIds({
    frontierIds: FRONTIER,
    requestedIds: ["n3", "n1"],
  });
  assert.deepEqual(result, {
    ok: true,
    nodeIds: ["n3", "n1"],
    truncated: false,
  });
});

test("five-id valid request truncates to three in requested order", () => {
  const result = selectExpandNodeIds({
    frontierIds: FRONTIER,
    requestedIds: ["n5", "n2", "n4", "n1", "n3"],
  });
  assert.deepEqual(result, {
    ok: true,
    nodeIds: ["n5", "n2", "n4"],
    truncated: true,
  });
});

test("one foreign id among valid ones refuses and lists only the foreign id", () => {
  const result = selectExpandNodeIds({
    frontierIds: FRONTIER,
    requestedIds: ["n1", "ghost", "n2"],
  });
  assert.deepEqual(result, {
    ok: false,
    error: "invalid_policy_output",
    foreignIds: ["ghost"],
  });
});

test("several foreign ids are sorted and deduplicated", () => {
  const result = selectExpandNodeIds({
    frontierIds: FRONTIER,
    requestedIds: ["z9", "a1", "z9", "n1"],
  });
  assert.deepEqual(result, {
    ok: false,
    error: "invalid_policy_output",
    foreignIds: ["a1", "z9"],
  });
});

test("duplicates collapse before the cap", () => {
  const result = selectExpandNodeIds({
    frontierIds: FRONTIER,
    requestedIds: ["n1", "n1", "n1", "n2"],
  });
  assert.deepEqual(result, {
    ok: true,
    nodeIds: ["n1", "n2"],
    truncated: false,
  });
});

test("padded and case-different ids are foreign", () => {
  const result = selectExpandNodeIds({
    frontierIds: FRONTIER,
    requestedIds: [" n1", "N1"],
  });
  assert.deepEqual(result, {
    ok: false,
    error: "invalid_policy_output",
    foreignIds: [" n1", "N1"],
  });
});

test("non-array requestedIds refuses with empty foreignIds", () => {
  for (const bad of [undefined, null, "n1"]) {
    const result = selectExpandNodeIds({
      frontierIds: FRONTIER,
      requestedIds: bad,
    });
    assert.deepEqual(result, {
      ok: false,
      error: "invalid_policy_output",
      foreignIds: [],
    });
  }
});

test("non-string array entry is reported as its String form", () => {
  const result = selectExpandNodeIds({
    frontierIds: FRONTIER,
    requestedIds: ["n1", 42],
  });
  assert.deepEqual(result, {
    ok: false,
    error: "invalid_policy_output",
    foreignIds: ["42"],
  });
});

test("blank string entry is foreign", () => {
  const result = selectExpandNodeIds({
    frontierIds: FRONTIER,
    requestedIds: ["   "],
  });
  assert.deepEqual(result, {
    ok: false,
    error: "invalid_policy_output",
    foreignIds: ["   "],
  });
});

test("empty array succeeds and expands nothing", () => {
  const result = selectExpandNodeIds({
    frontierIds: FRONTIER,
    requestedIds: [],
  });
  assert.deepEqual(result, { ok: true, nodeIds: [], truncated: false });
});

test("default cap is three", () => {
  assert.equal(DEFAULT_MAX_EXPAND_PER_STEP, 3);
  const result = selectExpandNodeIds({
    frontierIds: FRONTIER,
    requestedIds: ["n1", "n2", "n3", "n4"],
  });
  assert.deepEqual(result, {
    ok: true,
    nodeIds: ["n1", "n2", "n3"],
    truncated: true,
  });
});

test("maxExpandPerStep 0, -1, and 1.5 throw RangeError naming the field", () => {
  for (const bad of [0, -1, 1.5]) {
    assert.throws(
      () =>
        selectExpandNodeIds({
          frontierIds: FRONTIER,
          requestedIds: ["n1"],
          maxExpandPerStep: bad,
        }),
      (err: unknown) =>
        err instanceof RangeError && /maxExpandPerStep/.test(err.message),
    );
  }
});

test("inputs are not mutated", () => {
  const frontierIds = ["n1", "n2"];
  const requestedIds = ["n2", "n2", "ghost"];
  selectExpandNodeIds({ frontierIds, requestedIds });
  assert.deepEqual(frontierIds, ["n1", "n2"]);
  assert.deepEqual(requestedIds, ["n2", "n2", "ghost"]);
});
