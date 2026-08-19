import assert from "node:assert/strict";
import test from "node:test";

import { countRecapCards } from "./recap-card-count.js";

test("empty list is 0", () => {
  assert.equal(countRecapCards([]), 0);
});

test("counts unique ids", () => {
  assert.equal(countRecapCards(["card-a", "card-b", "card-a"]), 2);
  assert.equal(countRecapCards(["card-a", "card-b", "card-c"]), 3);
});

test("drops empty strings and does not mutate", () => {
  const cards = ["card-a", "", "card-b", "", "card-a"];
  assert.equal(countRecapCards(cards), 2);
  assert.deepEqual(cards, ["card-a", "", "card-b", "", "card-a"]);
});
