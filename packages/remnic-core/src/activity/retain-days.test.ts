import assert from "node:assert/strict";
import test from "node:test";

import { parseRetainDays } from "./retain-days.js";

test("retainDays 0 keeps forever", () => {
  assert.equal(parseRetainDays(0), 0);
});

test("retainDays 7 is accepted", () => {
  assert.equal(parseRetainDays(7), 7);
});

test("negative retainDays throws", () => {
  assert.throws(() => parseRetainDays(-1), /non-negative integer/);
});

test("float retainDays throws", () => {
  assert.throws(() => parseRetainDays(1.5), /non-negative integer/);
});
