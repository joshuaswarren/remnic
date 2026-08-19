import assert from "node:assert/strict";
import test from "node:test";

import { dedupeObservationIds } from "./analysis-dup.js";

test("empty input returns an empty array", () => {
  assert.deepEqual(dedupeObservationIds([]), []);
});

test("keeps first-seen order and drops later duplicates", () => {
  assert.deepEqual(dedupeObservationIds(["obs-b", "obs-a", "obs-b", "obs-c", "obs-a"]), [
    "obs-b",
    "obs-a",
    "obs-c",
  ]);
});

test("does not mutate the input array", () => {
  const input = ["obs-b", "obs-a", "obs-b"];
  const snapshot = input.slice();
  const deduped = dedupeObservationIds(input);
  assert.deepEqual(input, snapshot);
  assert.notEqual(deduped, input);
});

test("drops empty strings", () => {
  assert.deepEqual(dedupeObservationIds(["b", "", "a", "", "b"]), ["b", "a"]);
});
