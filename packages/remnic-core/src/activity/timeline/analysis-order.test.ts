import assert from "node:assert/strict";
import test from "node:test";

import { sortObservationIds } from "./analysis-order.js";

test("empty input returns an empty array", () => {
  assert.deepEqual(sortObservationIds([]), []);
});

test("sorts ids with localeCompare", () => {
  assert.deepEqual(sortObservationIds(["obs-c", "obs-a", "obs-b"]), [
    "obs-a",
    "obs-b",
    "obs-c",
  ]);
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
