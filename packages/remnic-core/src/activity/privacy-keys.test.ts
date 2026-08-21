import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDropKeys } from "./privacy-keys.js";

test("empty keys return []", () => {
  assert.deepEqual(normalizeDropKeys([]), []);
});

test("trims keys and drops empty", () => {
  assert.deepEqual(normalizeDropKeys(["  secret  ", "", "  ", "title"]), ["secret", "title"]);
});

test("unique keys sort by localeCompare", () => {
  assert.deepEqual(normalizeDropKeys(["zeta", "alpha", "zeta", "beta"]), ["alpha", "beta", "zeta"]);
});

test("does not mutate the input list", () => {
  const keys = ["  zeta  ", "alpha", "alpha"];
  normalizeDropKeys(keys);
  assert.deepEqual(keys, ["  zeta  ", "alpha", "alpha"]);
});
