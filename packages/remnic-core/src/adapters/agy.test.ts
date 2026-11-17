import assert from "node:assert/strict";
import test from "node:test";

import { AdapterRegistry } from "./registry.js";
import { AgyAdapter } from "./agy.js";
import type { AdapterContext } from "./types.js";

function context(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return { headers: {}, ...overrides };
}

test("AgyAdapter matches clientInfo names containing agy", () => {
  const adapter = new AgyAdapter();
  assert.equal(adapter.matches(context({ clientInfo: { name: "agy" } })), true);
  assert.equal(adapter.matches(context({ clientInfo: { name: "agy-cli" } })), true);
  assert.equal(adapter.matches(context({ clientInfo: { name: "Agy" } })), true);
});

test("AgyAdapter matches the configured client-id header", () => {
  const adapter = new AgyAdapter();
  assert.equal(
    adapter.matches(context({ headers: { "X-Engram-Client-Id": "agy-cli" } })),
    true,
  );
  assert.equal(
    adapter.matches(context({ headers: { "X-Engram-Client-Id": "agy" } })),
    true,
  );
});

test("AgyAdapter rejects unrelated clients", () => {
  const adapter = new AgyAdapter();
  assert.equal(adapter.matches(context()), false);
  assert.equal(adapter.matches(context({ clientInfo: { name: "claude-code" } })), false);
  assert.equal(adapter.matches(context({ clientInfo: { name: "codex-mcp-client" } })), false);
  assert.equal(
    adapter.matches(context({ headers: { "X-Engram-Client-Id": "claude-code" } })),
    false,
  );
});

test("AgyAdapter resolves agy namespace and principal with header overrides", () => {
  const adapter = new AgyAdapter();
  assert.deepEqual(
    adapter.resolveIdentity(context({ headers: { "mcp-session-id": "sess-1" } })),
    {
      namespace: "agy",
      namespaceExplicit: false,
      principal: "agy",
      sessionKey: "sess-1",
      adapterId: "agy",
    },
  );
  assert.deepEqual(
    adapter.resolveIdentity(
      context({ headers: { "x-engram-namespace": "team-space" } }),
    ),
    {
      namespace: "team-space",
      namespaceExplicit: true,
      principal: "agy",
      sessionKey: undefined,
      adapterId: "agy",
    },
  );
});

test("registry resolves Agy requests before the Claude Code adapter", () => {
  const registry = new AdapterRegistry();
  const identity = registry.resolve(
    context({ headers: { "x-engram-client-id": "agy-cli" } }),
  );
  assert.equal(identity?.adapterId, "agy");
  assert.equal(identity?.namespace, "agy");
});
