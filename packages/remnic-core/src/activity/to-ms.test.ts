import assert from "node:assert/strict";
import test from "node:test";

import { parseToMs } from "./to-ms.js";

test("toMs 0 is accepted", () => {
  assert.equal(parseToMs(0), 0);
});

test("epoch toMs is accepted", () => {
  const epoch = 1_700_000_000_000;
  assert.equal(parseToMs(epoch), epoch);
});

test("negative toMs throws", () => {
  assert.throws(() => parseToMs(-1), /non-negative/);
});

test("NaN toMs throws", () => {
  assert.throws(() => parseToMs(Number.NaN), /finite/);
});

test("non-number toMs throws", () => {
  assert.throws(() => parseToMs("0"), /finite/);
});
