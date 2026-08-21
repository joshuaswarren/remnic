import assert from "node:assert/strict";
import test from "node:test";

import { parseRequiredActor } from "./envelope-required.js";

test("empty required actor is allowed", () => {
  assert.deepEqual(parseRequiredActor(""), { ok: true, required: "" });
  assert.deepEqual(parseRequiredActor("   "), { ok: true, required: "" });
});

test("ok required actor returns trimmed value", () => {
  assert.deepEqual(parseRequiredActor("agent-a"), { ok: true, required: "agent-a" });
});

test("newline in required actor is invalid_required", () => {
  assert.deepEqual(parseRequiredActor("agent-a\nagent-b"), {
    ok: false,
    error: "invalid_required",
  });
});

test("trims surrounding whitespace", () => {
  assert.deepEqual(parseRequiredActor("  agent-a  "), { ok: true, required: "agent-a" });
});
