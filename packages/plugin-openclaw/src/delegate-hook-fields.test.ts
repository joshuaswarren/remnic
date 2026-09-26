import test from "node:test";
import assert from "node:assert/strict";

import {
  isSubagentSessionKey,
  isSubagentSessionKeyDetected,
  openClawRoutingModule,
  sessionKeyFrom,
} from "./delegate-hook-fields.js";

test("isSubagentSessionKey matches the upstream OpenClaw spawn-child key grammar", () => {
  assert.equal(isSubagentSessionKey("agent:reviewer:subagent:abc123"), true);
  assert.equal(isSubagentSessionKey("agent:main:subagent:parent:subagent:child"), true);
  assert.equal(isSubagentSessionKey("subagent:worker"), true);
  assert.equal(isSubagentSessionKey("AGENT:Reviewer:SUBAGENT:abc"), true);
  assert.equal(isSubagentSessionKey("  agent:reviewer:subagent:abc  "), true);
});

test("isSubagentSessionKey keeps main, cron, and malformed keys out", () => {
  assert.equal(isSubagentSessionKey("agent:main:main"), false);
  assert.equal(isSubagentSessionKey("agent:generalist:cron:nightly-sync"), false);
  assert.equal(isSubagentSessionKey("main"), false);
  assert.equal(isSubagentSessionKey("session-a"), false);
  assert.equal(isSubagentSessionKey("agent:main:subagents"), false);
  assert.equal(isSubagentSessionKey("agent:main:subagentish:thing"), false);
  assert.equal(isSubagentSessionKey("agent:main:"), false);
  assert.equal(isSubagentSessionKey("agent::subagent:x"), false);
  assert.equal(isSubagentSessionKey("agent:nocolon"), false);
});

test("isSubagentSessionKey is false for missing or empty hook context keys", () => {
  assert.equal(isSubagentSessionKey(""), false);
  assert.equal(isSubagentSessionKey("   "), false);
  assert.equal(isSubagentSessionKey(undefined), false);
  assert.equal(isSubagentSessionKey(null), false);
  assert.equal(isSubagentSessionKey(sessionKeyFrom({}, {})), false, "missing ctx falls back to the default session, which is not a spawn child");
});

test("isSubagentSessionKeyDetected agrees with the mirrored grammar in any environment", async () => {
  const fixtures = [
    "agent:reviewer:subagent:abc123",
    "subagent:worker",
    "agent:main:main",
    "agent:generalist:cron:nightly-sync",
    "default",
    "",
  ];
  // Deterministic in both host-installed and host-free environments: the
  // detector must answer exactly the mirrored grammar whichever helper is
  // active, and when the host SDK resolves, it must agree with the mirror.
  for (const key of fixtures) {
    assert.equal(await isSubagentSessionKeyDetected(key), isSubagentSessionKey(key));
  }
  const routing = await openClawRoutingModule();
  if (routing?.isSubagentSessionKey) {
    for (const key of fixtures) {
      assert.equal(
        routing.isSubagentSessionKey(key),
        isSubagentSessionKey(key),
        `upstream helper disagrees with the mirrored grammar for ${JSON.stringify(key)}`,
      );
    }
  }
});
