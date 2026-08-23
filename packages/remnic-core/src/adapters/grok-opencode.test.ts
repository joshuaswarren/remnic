import assert from "node:assert/strict";
import test from "node:test";

import { AdapterRegistry } from "./registry.js";
import { GrokAdapter } from "./grok.js";
import { OpenCodeAdapter } from "./opencode.js";
import type { AdapterContext } from "./types.js";

function context(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return { headers: {}, ...overrides };
}

test("GrokAdapter matches clientInfo names containing grok", () => {
  const adapter = new GrokAdapter();
  assert.equal(adapter.matches(context({ clientInfo: { name: "grok" } })), true);
  assert.equal(adapter.matches(context({ clientInfo: { name: "grok-cli" } })), true);
  assert.equal(adapter.matches(context({ clientInfo: { name: "Grok-Desktop" } })), true);
});

test("GrokAdapter matches User-Agent and configured client-id headers", () => {
  const adapter = new GrokAdapter();
  assert.equal(adapter.matches(context({ headers: { "user-agent": "grok/4.6" } })), true);
  assert.equal(
    adapter.matches(context({ headers: { "X-Engram-Client-Id": "grok" } })),
    true,
  );
});

test("GrokAdapter rejects unrelated clients", () => {
  const adapter = new GrokAdapter();
  assert.equal(adapter.matches(context()), false);
  assert.equal(adapter.matches(context({ clientInfo: { name: "claude-code" } })), false);
  assert.equal(adapter.matches(context({ clientInfo: { name: "codex-mcp-client" } })), false);
  assert.equal(adapter.matches(context({ clientInfo: { name: "opencode" } })), false);
  assert.equal(
    adapter.matches(context({ headers: { "X-Engram-Client-Id": "codex" } })),
    false,
  );
});

test("GrokAdapter resolves identity with adapter-owned principal and header namespace", () => {
  const adapter = new GrokAdapter();
  assert.deepEqual(
    adapter.resolveIdentity(context({
      headers: {
        "mcp-session-id": "sess-grok-1",
        "x-engram-namespace": "my-project",
      },
    })),
    {
      namespace: "my-project",
      principal: "grok",
      sessionKey: "sess-grok-1",
      adapterId: "grok",
    },
  );
  assert.deepEqual(
    adapter.resolveIdentity(context({ sessionKey: "session-1" })).principal,
    "grok",
  );
  // Default namespace when no explicit header is present.
  assert.equal(
    adapter.resolveIdentity(context()).namespace,
    "grok",
  );
});

test("OpenCodeAdapter matches clientInfo, User-Agent, and configured client-id headers", () => {
  const adapter = new OpenCodeAdapter();
  assert.equal(adapter.matches(context({ clientInfo: { name: "opencode" } })), true);
  assert.equal(adapter.matches(context({ clientInfo: { name: "OpenCode/1.0" } })), true);
  assert.equal(adapter.matches(context({ headers: { "user-agent": "opencode/2.3.0" } })), true);
  assert.equal(
    adapter.matches(context({ headers: { "X-Engram-Client-Id": "opencode" } })),
    true,
  );
});

test("OpenCodeAdapter rejects unrelated clients", () => {
  const adapter = new OpenCodeAdapter();
  assert.equal(adapter.matches(context()), false);
  assert.equal(adapter.matches(context({ clientInfo: { name: "claude-code" } })), false);
  assert.equal(adapter.matches(context({ clientInfo: { name: "codex-mcp-client" } })), false);
  assert.equal(adapter.matches(context({ clientInfo: { name: "grok" } })), false);
});

test("OpenCodeAdapter resolves identity with adapter-owned principal", () => {
  const adapter = new OpenCodeAdapter();
  const resolved = adapter.resolveIdentity(context({
    headers: { "mcp-session-id": "sess-oc-1" },
  }));
  assert.deepEqual(resolved, {
    namespace: "opencode",
    principal: "opencode",
    sessionKey: "sess-oc-1",
    adapterId: "opencode",
  });
});

test("default registry registers grok and opencode adapters in order", () => {
  const registry = new AdapterRegistry();
  assert.deepEqual(registry.list(), [
    "hermes",
    "replit",
    "codex",
    "claude-code",
    "grok",
    "opencode",
  ]);
});

test("issue #2782 reproduction: Grok headers resolve a transport principal without a session key", () => {
  const registry = new AdapterRegistry();
  const resolved = registry.resolve({
    headers: {
      "x-engram-client-id": "grok",
      "x-engram-principal": "grok",
    },
  });
  assert.ok(resolved, "expected the Grok adapter to resolve the request");
  assert.equal(resolved.principal, "grok");
  assert.equal(resolved.adapterId, "grok");
  assert.equal(resolved.sessionKey, undefined);
});

test("issue #2782 reproduction: OpenCode headers resolve a transport principal without a session key", () => {
  const registry = new AdapterRegistry();
  const resolved = registry.resolve({
    headers: { "x-engram-client-id": "opencode" },
    clientInfo: { name: "opencode" },
  });
  assert.ok(resolved, "expected the OpenCode adapter to resolve the request");
  assert.equal(resolved.principal, "opencode");
});

test("adapters never adopt X-Engram-Principal as their own resolution source", () => {
  const registry = new AdapterRegistry();
  for (const clientId of ["grok", "opencode"]) {
    const resolved = registry.resolve({
      headers: { "x-engram-client-id": clientId, "x-engram-principal": "spoofed-principal" },
    });
    assert.ok(resolved);
    assert.equal(resolved.principal, clientId);
    assert.notEqual(resolved.principal, "spoofed-principal");
  }
});
