import assert from "node:assert/strict";
import test from "node:test";

import { AdapterRegistry } from "./registry.js";
import { DevinAdapter } from "./devin.js";
import type { AdapterContext } from "./types.js";

function context(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return { headers: {}, ...overrides };
}

test("DevinAdapter matches clientInfo names containing devin", () => {
  const adapter = new DevinAdapter();
  assert.equal(adapter.matches(context({ clientInfo: { name: "devin" } })), true);
  assert.equal(adapter.matches(context({ clientInfo: { name: "devin-cli" } })), true);
  assert.equal(adapter.matches(context({ clientInfo: { name: "Devin" } })), true);
});

test("DevinAdapter matches the configured client-id header", () => {
  const adapter = new DevinAdapter();
  assert.equal(
    adapter.matches(context({ headers: { "X-Engram-Client-Id": "devin-cli" } })),
    true,
  );
  assert.equal(
    adapter.matches(context({ headers: { "X-Engram-Client-Id": "devin" } })),
    true,
  );
});

test("DevinAdapter rejects unrelated clients", () => {
  const adapter = new DevinAdapter();
  assert.equal(adapter.matches(context()), false);
  assert.equal(adapter.matches(context({ clientInfo: { name: "claude-code" } })), false);
  assert.equal(adapter.matches(context({ clientInfo: { name: "codex-mcp-client" } })), false);
  assert.equal(
    adapter.matches(context({ headers: { "X-Engram-Client-Id": "claude-code" } })),
    false,
  );
});

test("DevinAdapter resolves devin namespace and principal with header overrides", () => {
  const adapter = new DevinAdapter();
  assert.deepEqual(
    adapter.resolveIdentity(context({ headers: { "mcp-session-id": "sess-1" } })),
    {
      namespace: "devin",
      namespaceExplicit: false,
      principal: "devin",
      sessionKey: "sess-1",
      adapterId: "devin",
    },
  );
  assert.deepEqual(
    adapter.resolveIdentity(
      context({ headers: { "x-engram-namespace": "team-space" } }),
    ),
    {
      namespace: "team-space",
      namespaceExplicit: true,
      principal: "devin",
      sessionKey: undefined,
      adapterId: "devin",
    },
  );
});

test("registry resolves Devin requests before the Claude Code adapter", () => {
  const registry = new AdapterRegistry();
  const identity = registry.resolve(
    context({ headers: { "x-engram-client-id": "devin-cli" } }),
  );
  assert.equal(identity?.adapterId, "devin");
  assert.equal(identity?.namespace, "devin");
});
