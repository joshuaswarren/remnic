import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyDefaultEnvelope,
  isExpired,
  parseSharedEnvelope,
} from "./governance.js";

test("applyDefaultEnvelope defaults to informational with no expiry", () => {
  assert.deepEqual(applyDefaultEnvelope(), { authority: "informational" });
  assert.deepEqual(applyDefaultEnvelope({}), { authority: "informational" });
  assert.deepEqual(applyDefaultEnvelope({ authority: "advisory", sharedBy: "agent-a" }), {
    authority: "advisory",
    sharedBy: "agent-a",
  });
});

test("applyDefaultEnvelope rejects binding without an explicit flag", () => {
  assert.throws(() => applyDefaultEnvelope({ authority: "binding" }), /binding/);
  assert.deepEqual(applyDefaultEnvelope({ authority: "binding" }, { binding: true }), {
    authority: "binding",
  });
});

test("isExpired treats expiresAt as a half-open upper bound", () => {
  const expiresAt = "2026-08-18T12:00:00.000Z";
  const at = Date.parse(expiresAt);
  const envelope = { authority: "informational" as const, expiresAt };
  assert.equal(isExpired(envelope, at - 1), false);
  assert.equal(isExpired(envelope, at), true);
  assert.equal(isExpired({ authority: "informational" }, at), false);
});

test("parseSharedEnvelope treats a missing legacy envelope as informational with no expiry", () => {
  assert.deepEqual(parseSharedEnvelope(undefined), { authority: "informational" });
  assert.deepEqual(parseSharedEnvelope(null), { authority: "informational" });
  assert.deepEqual(parseSharedEnvelope({ title: "legacy output" }), { authority: "informational" });
  assert.deepEqual(
    parseSharedEnvelope({
      sharedBy: "agent-a",
      authority: "advisory",
      expiresAt: "2026-08-18T12:00:00.000Z",
      supersedes: "item-1",
    }),
    {
      sharedBy: "agent-a",
      authority: "advisory",
      expiresAt: "2026-08-18T12:00:00.000Z",
      supersedes: "item-1",
    },
  );
});
