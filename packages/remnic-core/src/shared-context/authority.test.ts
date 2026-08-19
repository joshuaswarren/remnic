import assert from "node:assert/strict";
import { test } from "node:test";

import { checkAuthority } from "./authority.js";

test("checkAuthority rejects a missing actor", () => {
  assert.deepEqual(checkAuthority({ actor: "", required: "agent-a" }), {
    ok: false,
    error: "missing_actor",
  });
  assert.deepEqual(checkAuthority({ required: "agent-a" }), {
    ok: false,
    error: "missing_actor",
  });
  assert.deepEqual(checkAuthority({ actor: "   ", required: "agent-a" }), {
    ok: false,
    error: "missing_actor",
  });
});

test("checkAuthority allows an empty required role", () => {
  assert.deepEqual(checkAuthority({ actor: "agent-a", required: "" }), { ok: true });
  assert.deepEqual(checkAuthority({ actor: "agent-a" }), { ok: true });
});

test("checkAuthority allows a matching actor", () => {
  assert.deepEqual(checkAuthority({ actor: "agent-a", required: "agent-a" }), { ok: true });
});

test("checkAuthority rejects a mismatched actor", () => {
  assert.deepEqual(checkAuthority({ actor: "agent-a", required: "agent-b" }), {
    ok: false,
    error: "forbidden",
  });
});
