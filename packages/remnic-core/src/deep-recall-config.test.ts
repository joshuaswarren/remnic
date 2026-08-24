/**
 * Strict `maxSteps` request parsing (issue #2915) — the one parser MCP,
 * HTTP, and CLI share. Absent means absent; everything else must be a
 * non-negative integer. Malformed (`"abc"`), empty (`""`), fractional
 * (`"1.5"` / `1.5`), negative, and non-number values throw instead of
 * silently falling back to the configured default (§39).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { parseDeepRecallMaxSteps } from "./deep-recall-config.js";

test("parseDeepRecallMaxSteps: absence stays absent", () => {
  assert.equal(parseDeepRecallMaxSteps(undefined), undefined);
  assert.equal(parseDeepRecallMaxSteps(null), undefined);
});

test("parseDeepRecallMaxSteps: accepts non-negative integers in number and digit-string form", () => {
  assert.equal(parseDeepRecallMaxSteps(0), 0);
  assert.equal(parseDeepRecallMaxSteps(4), 4);
  assert.equal(parseDeepRecallMaxSteps("0"), 0);
  assert.equal(parseDeepRecallMaxSteps("3"), 3);
  assert.equal(parseDeepRecallMaxSteps(" 3 "), 3);
});

test("parseDeepRecallMaxSteps: rejects malformed, empty, fractional, negative, and non-number input", () => {
  const invalid: unknown[] = ["abc", "", " ", "1.5", "1e2", "0x3", "-1", "-1", 1.5, -0.5, -1, true, {}, [], Number.NaN];
  for (const raw of invalid) {
    assert.throws(
      () => parseDeepRecallMaxSteps(raw),
      /maxSteps must be a non-negative integer/,
      `must reject ${JSON.stringify(raw)}`,
    );
  }
});
