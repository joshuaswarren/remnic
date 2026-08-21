import assert from "node:assert/strict";
import test from "node:test";

import { parseFromMs } from "./from-ms.js";

test("fromMs 0 is accepted", () => {
  assert.equal(parseFromMs(0), 0);
});

test("epoch fromMs is accepted", () => {
  const epoch = 1_700_000_000_000;
  assert.equal(parseFromMs(epoch), epoch);
});

test("negative fromMs throws", () => {
  assert.throws(() => parseFromMs(-1), /non-negative/);
});

test("NaN fromMs throws", () => {
  assert.throws(() => parseFromMs(Number.NaN), /finite/);
});

test("non-number fromMs throws", () => {
  assert.throws(() => parseFromMs("0"), /finite/);
});
