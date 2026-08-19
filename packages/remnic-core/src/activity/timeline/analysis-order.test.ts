import assert from "node:assert/strict";
import test from "node:test";

import { sortObservationIds } from "./analysis-order.js";

test("empty input returns an empty array", () => {
  assert.deepEqual(sortObservationIds([]), []);
});

test("sorts ids deterministically by code unit", () => {
  assert.deepEqual(sortObservationIds(["obs-c", "obs-a", "obs-b"]), [
    "obs-a",
    "obs-b",
    "obs-c",
  ]);
});

test("sorts uppercase before lowercase regardless of host locale", () => {
  assert.deepEqual(sortObservationIds(["b", "A", "a", "B"]), ["A", "B", "a", "b"]);
});

test("sorts non-ascii ids by code unit, not locale collation", () => {
  assert.deepEqual(sortObservationIds(["é", "z", "e"]), ["e", "z", "é"]);
});

test("does not mutate the input array", () => {
  const input = ["obs-c", "obs-a"];
  const snapshot = input.slice();
  const sorted = sortObservationIds(input);
  assert.deepEqual(input, snapshot);
  assert.notEqual(sorted, input);
});

test("drops empty strings", () => {
  assert.deepEqual(sortObservationIds(["b", "", "a", ""]), ["a", "b"]);
});
