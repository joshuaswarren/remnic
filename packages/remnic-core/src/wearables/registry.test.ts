import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  clearWearableConnectors,
  ensureBuiltInWearableConnectors,
  getWearableConnector,
  listWearableConnectors,
  registerWearableConnector,
} from "./registry.js";

afterEach(() => {
  clearWearableConnectors();
});

function registration(id = "testsource") {
  return {
    id,
    displayName: "Test Source",
    factory: () => ({
      id,
      displayName: "Test Source",
      verifyAuth: async () => ({ ok: true }),
      fetchConversations: async () => ({ conversations: [], nextCursor: null }),
    }),
  };
}

test("register + get + list round-trip", () => {
  registerWearableConnector(registration());
  assert.ok(getWearableConnector("testsource"));
  assert.deepEqual(listWearableConnectors(), ["testsource"]);
  assert.equal(getWearableConnector("missing"), undefined);
  assert.equal(getWearableConnector(""), undefined);
});

test("duplicate registration throws; ids are trimmed", () => {
  registerWearableConnector(registration());
  assert.throws(() => registerWearableConnector(registration()), /already registered/);
  registerWearableConnector(registration("  spaced  ") as never);
  assert.ok(getWearableConnector("spaced"));
});

test("invalid registrations are rejected", () => {
  assert.throws(
    () => registerWearableConnector({ id: "", displayName: "x", factory: () => ({}) } as never),
    /non-empty string/,
  );
  assert.throws(
    () => registerWearableConnector({ id: "x", displayName: "x" } as never),
    /factory function/,
  );
});

test("ensureBuiltInWearableConnectors tolerates absent optional packages", async () => {
  // In the core package's own test environment the connector packages
  // may or may not be installed; the loader must succeed either way and
  // never throw for a missing optional package.
  await ensureBuiltInWearableConnectors();
  await ensureBuiltInWearableConnectors();
  assert.ok(Array.isArray(listWearableConnectors()));
});
