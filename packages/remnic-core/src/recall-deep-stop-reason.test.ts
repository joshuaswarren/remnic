import assert from "node:assert/strict";
import test from "node:test";

import { parseDeepStopReason } from "./recall-deep-stop-reason.js";

test("budget_exhausted is allowed", () => {
  assert.deepEqual(parseDeepStopReason("budget_exhausted"), {
    ok: true,
    reason: "budget_exhausted",
  });
});

test("policy_stop is allowed", () => {
  assert.deepEqual(parseDeepStopReason("policy_stop"), {
    ok: true,
    reason: "policy_stop",
  });
});

test("expand_once is allowed", () => {
  assert.deepEqual(parseDeepStopReason("expand_once"), {
    ok: true,
    reason: "expand_once",
  });
});

test("refine_done is allowed", () => {
  assert.deepEqual(parseDeepStopReason("refine_done"), {
    ok: true,
    reason: "refine_done",
  });
});

test("unknown reason is unknown_reason", () => {
  assert.deepEqual(parseDeepStopReason("stop"), {
    ok: false,
    error: "unknown_reason",
  });
});

test("empty reason is unknown_reason", () => {
  assert.deepEqual(parseDeepStopReason(""), {
    ok: false,
    error: "unknown_reason",
  });
});
