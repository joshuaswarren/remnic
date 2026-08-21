import assert from "node:assert/strict";
import test from "node:test";

import { parseDeepPolicyName } from "./recall-deep-policy.js";

test("stop is allowed", () => {
  assert.deepEqual(parseDeepPolicyName("stop"), {
    ok: true,
    policy: "stop",
  });
});

test("expand-once is allowed", () => {
  assert.deepEqual(parseDeepPolicyName("expand-once"), {
    ok: true,
    policy: "expand-once",
  });
});

test("unknown policy is unknown_policy", () => {
  assert.deepEqual(parseDeepPolicyName("refine-twice"), {
    ok: false,
    error: "unknown_policy",
  });
});

test("empty policy is unknown_policy", () => {
  assert.deepEqual(parseDeepPolicyName(""), {
    ok: false,
    error: "unknown_policy",
  });
});
