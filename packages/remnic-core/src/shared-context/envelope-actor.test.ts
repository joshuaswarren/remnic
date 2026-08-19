import assert from "node:assert/strict";
import test from "node:test";

import { parseEnvelopeActor } from "./envelope-actor.js";

test("ok actor returns trimmed actor", () => {
  assert.deepEqual(parseEnvelopeActor("agent-a"), { ok: true, actor: "agent-a" });
});

test("empty actor is missing_actor", () => {
  assert.deepEqual(parseEnvelopeActor(""), { ok: false, error: "missing_actor" });
  assert.deepEqual(parseEnvelopeActor("   "), { ok: false, error: "missing_actor" });
});

test("newline in actor is invalid_actor", () => {
  assert.deepEqual(parseEnvelopeActor("agent-a\nagent-b"), { ok: false, error: "invalid_actor" });
});

test("trims surrounding whitespace", () => {
  assert.deepEqual(parseEnvelopeActor("  agent-a  "), { ok: true, actor: "agent-a" });
});
