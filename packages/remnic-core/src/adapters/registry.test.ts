import assert from "node:assert/strict";
import test from "node:test";

import { AdapterRegistry } from "./registry.js";
import type { AdapterContext, EngramAdapter } from "./types.js";

test("adapter registry falls back to explicit request identity when no adapter matches", () => {
  const registry = new AdapterRegistry([]);

  assert.deepEqual(
    registry.resolve({
      headers: {},
      namespace: " project-a ",
      principal: " user-1 ",
      sessionKey: "session-1",
    }),
    {
      namespace: "project-a",
      principal: "user-1",
      sessionKey: "session-1",
      adapterId: "explicit",
    },
  );
});

test("adapter registry requires complete explicit identity fallback", () => {
  const registry = new AdapterRegistry([]);

  assert.equal(registry.resolve({ headers: {}, sessionKey: "session-1" }), null);
  assert.equal(registry.resolve({ headers: {}, namespace: "project-a" }), null);
  assert.equal(registry.resolve({ headers: {}, principal: "user-1" }), null);
});

test("adapter registry prefers matching adapters over explicit fallback", () => {
  const adapter: EngramAdapter = {
    id: "test-adapter",
    matches(context: AdapterContext) {
      return context.headers["x-test"] === "yes";
    },
    resolveIdentity() {
      return {
        namespace: "adapter-namespace",
        principal: "adapter-principal",
        adapterId: "test-adapter",
      };
    },
  };

  const registry = new AdapterRegistry([adapter]);

  assert.deepEqual(
    registry.resolve({
      headers: { "x-test": "yes" },
      namespace: "explicit-namespace",
      principal: "explicit-principal",
    }),
    {
      namespace: "adapter-namespace",
      principal: "adapter-principal",
      adapterId: "test-adapter",
    },
  );
});
