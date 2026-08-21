import assert from "node:assert/strict";
import test from "node:test";

import { sortRecapCardIds } from "./recap-id.js";

test("empty input returns an empty array", () => {
  assert.deepEqual(sortRecapCardIds([]), []);
});

test("sorts ids with localeCompare", () => {
  assert.deepEqual(sortRecapCardIds(["card-c", "card-a", "card-b"]), [
    "card-a",
    "card-b",
    "card-c",
  ]);
});

test("does not mutate the input array", () => {
  const input = ["card-c", "card-a"];
  const snapshot = input.slice();
  const sorted = sortRecapCardIds(input);
  assert.deepEqual(input, snapshot);
  assert.notEqual(sorted, input);
});

test("drops empty strings", () => {
  assert.deepEqual(sortRecapCardIds(["b", "", "a", ""]), ["a", "b"]);
});
