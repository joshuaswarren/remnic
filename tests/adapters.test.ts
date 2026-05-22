import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { ReplitAdapter } from "../src/adapters/replit.js";
import { HermesAdapter } from "../src/adapters/hermes.js";

// -- Registry --

test("AdapterRegistry returns null when no adapter matches", () => {
  const registry = new AdapterRegistry();
  const result = registry.resolve({ headers: {} });
  assert.equal(result, null);
});

test("AdapterRegistry lists registered adapter IDs", () => {
  const registry = new AdapterRegistry();
  const ids = registry.list();
  assert.deepEqual(ids, ["hermes", "replit", "codex", "claude-code"]);
});

test("AdapterRegistry resolves first matching adapter (Hermes before Claude Code)", () => {
  const registry = new AdapterRegistry();
  const result = registry.resolve({
    headers: { "x-hermes-session-id": "herm-abc" },
    clientInfo: { name: "claude-code" },
  });
  assert.equal(result?.adapterId, "hermes");
});

// -- Claude Code (real detection: clientInfo.name = "claude-code", User-Agent) --

test("ClaudeCodeAdapter matches on exact clientInfo.name 'claude-code'", () => {
  const adapter = new ClaudeCodeAdapter();
  assert.equal(adapter.matches({ headers: {}, clientInfo: { name: "claude-code", version: "2.1.92" } }), true);
  assert.equal(adapter.matches({ headers: {} }), false);
});

test("ClaudeCodeAdapter matches on User-Agent header", () => {
  const adapter = new ClaudeCodeAdapter();
  assert.equal(adapter.matches({ headers: { "user-agent": "claude-code/2.1.92" } }), true);
  assert.equal(adapter.matches({ headers: { "User-Agent": "claude-code/2.1.92" } }), true);
  assert.equal(adapter.matches({ headers: { "user-agent": "Mozilla/5.0" } }), false);
});

test("ClaudeCodeAdapter matches on X-Engram-Client-Id header", () => {
  const adapter = new ClaudeCodeAdapter();
  assert.equal(adapter.matches({ headers: { "x-engram-client-id": "claude-code" } }), true);
  assert.equal(adapter.matches({ headers: { "X-Engram-Client-Id": "claude-code" } }), true);
});

test("ClaudeCodeAdapter uses Mcp-Session-Id and X-Engram-Namespace", () => {
  const adapter = new ClaudeCodeAdapter();
  const identity = adapter.resolveIdentity({
    headers: {
      "mcp-session-id": "mcp-sess-123",
      "x-engram-namespace": "my-project",
    },
    clientInfo: { name: "claude-code" },
  });
  assert.equal(identity.adapterId, "claude-code");
  assert.equal(identity.namespace, "my-project");
  assert.equal(identity.principal, "claude-code");
  assert.equal(identity.sessionKey, "mcp-sess-123");
});

test("ClaudeCodeAdapter resolves mixed-case session and namespace headers", () => {
  const adapter = new ClaudeCodeAdapter();
  const identity = adapter.resolveIdentity({
    headers: {
      "Mcp-Session-Id": "mcp-sess-mixed",
      "X-Engram-Namespace": "mixed-project",
    },
    clientInfo: { name: "claude-code" },
  });
  assert.equal(identity.namespace, "mixed-project");
  assert.equal(identity.sessionKey, "mcp-sess-mixed");
});

test("ClaudeCodeAdapter defaults namespace and principal without custom headers", () => {
  const adapter = new ClaudeCodeAdapter();
  const identity = adapter.resolveIdentity({
    headers: {},
    clientInfo: { name: "claude-code" },
  });
  assert.equal(identity.namespace, "claude-code");
  assert.equal(identity.principal, "claude-code");
});

// -- Codex CLI (real detection: clientInfo.name = "codex-mcp-client") --

test("CodexAdapter matches on exact clientInfo.name 'codex-mcp-client'", () => {
  const adapter = new CodexAdapter();
  assert.equal(adapter.matches({ headers: {}, clientInfo: { name: "codex-mcp-client" } }), true);
  assert.equal(adapter.matches({ headers: {} }), false);
});

test("CodexAdapter matches on X-Engram-Client-Id header", () => {
  const adapter = new CodexAdapter();
  assert.equal(adapter.matches({ headers: { "x-engram-client-id": "codex" } }), true);
  assert.equal(adapter.matches({ headers: { "X-Engram-Client-Id": "codex" } }), true);
});

test("CodexAdapter uses X-Engram-Namespace and ignores X-Engram-Principal", () => {
  const adapter = new CodexAdapter();
  const identity = adapter.resolveIdentity({
    headers: { "x-engram-namespace": "my-app", "x-engram-principal": "pm-agent" },
    clientInfo: { name: "codex-mcp-client" },
  });
  assert.equal(identity.adapterId, "codex");
  assert.equal(identity.namespace, "my-app");
  assert.equal(identity.principal, "codex");
});

test("CodexAdapter resolves mixed-case namespace and session headers", () => {
  const adapter = new CodexAdapter();
  const identity = adapter.resolveIdentity({
    headers: {
      "Mcp-Session-Id": "codex-mcp-session",
      "X-Engram-Namespace": "codex-project",
      "X-Engram-Principal": "ignored-principal",
    },
    clientInfo: { name: "codex-mcp-client" },
  });
  assert.equal(identity.namespace, "codex-project");
  assert.equal(identity.principal, "codex");
  assert.equal(identity.sessionKey, "codex-mcp-session");
});

test("CodexAdapter defaults without custom headers", () => {
  const adapter = new CodexAdapter();
  const identity = adapter.resolveIdentity({
    headers: {},
    clientInfo: { name: "codex-mcp-client" },
  });
  assert.equal(identity.namespace, "codex");
  assert.equal(identity.principal, "codex");
});

// -- Replit (detection: X-Engram-Client-Id or clientInfo containing "replit") --

test("ReplitAdapter matches on X-Engram-Client-Id header", () => {
  const adapter = new ReplitAdapter();
  assert.equal(adapter.matches({ headers: { "x-engram-client-id": "replit" } }), true);
  assert.equal(adapter.matches({ headers: {} }), false);
});

test("ReplitAdapter matches on clientInfo containing 'replit'", () => {
  const adapter = new ReplitAdapter();
  assert.equal(adapter.matches({ headers: {}, clientInfo: { name: "replit-agent" } }), true);
});

test("ReplitAdapter uses X-Engram-Namespace and ignores X-Engram-Principal", () => {
  const adapter = new ReplitAdapter();
  const identity = adapter.resolveIdentity({
    headers: {
      "x-engram-client-id": "replit",
      "x-engram-namespace": "my-repl",
      "x-engram-principal": "replit-user-123",
    },
  });
  assert.equal(identity.adapterId, "replit");
  assert.equal(identity.namespace, "my-repl");
  assert.equal(identity.principal, "replit-agent");
});

test("ReplitAdapter defaults without custom headers", () => {
  const adapter = new ReplitAdapter();
  const identity = adapter.resolveIdentity({
    headers: { "x-engram-client-id": "replit" },
  });
  assert.equal(identity.namespace, "replit");
  assert.equal(identity.principal, "replit-agent");
});

// -- Hermes (detection: X-Hermes-Session-Id, X-Engram-Client-Id, or clientInfo) --

test("HermesAdapter matches on X-Hermes-Session-Id header (confirmed in v0.7.0)", () => {
  const adapter = new HermesAdapter();
  assert.equal(adapter.matches({ headers: { "x-hermes-session-id": "herm-abc" } }), true);
  assert.equal(adapter.matches({ headers: {} }), false);
});

test("HermesAdapter matches on X-Engram-Client-Id header", () => {
  const adapter = new HermesAdapter();
  assert.equal(adapter.matches({ headers: { "x-engram-client-id": "hermes" } }), true);
});

test("HermesAdapter matches on clientInfo containing 'hermes'", () => {
  const adapter = new HermesAdapter();
  assert.equal(adapter.matches({ headers: {}, clientInfo: { name: "hermes-agent" } }), true);
});

test("HermesAdapter uses X-Hermes-Session-Id and X-Engram-Namespace", () => {
  const adapter = new HermesAdapter();
  const identity = adapter.resolveIdentity({
    headers: {
      "x-hermes-session-id": "herm-abc",
      "x-engram-namespace": "research-profile",
    },
  });
  assert.equal(identity.adapterId, "hermes");
  assert.equal(identity.namespace, "research-profile");
  assert.equal(identity.principal, "hermes-agent");
  assert.equal(identity.sessionKey, "herm-abc");
});

test("HermesAdapter defaults without custom headers", () => {
  const adapter = new HermesAdapter();
  const identity = adapter.resolveIdentity({
    headers: { "x-hermes-session-id": "herm-abc" },
  });
  assert.equal(identity.namespace, "hermes");
  assert.equal(identity.principal, "hermes-agent");
});

// -- Cross-cutting: X-Engram-Principal is gated by access-http --

test("X-Engram-Principal header does not override adapter-resolved principal", () => {
  const adapter = new ClaudeCodeAdapter();
  const identity = adapter.resolveIdentity({
    headers: { "x-engram-principal": "custom-principal" },
    clientInfo: { name: "claude-code" },
  });
  assert.equal(identity.principal, "claude-code");
});

// -- MCP clientInfo storage --

test("MCP server stores clientInfo from initialize handshake", async () => {
  // This is tested via access-mcp.test.ts initialize flow;
  // here we verify the adapter can use it
  const registry = new AdapterRegistry();
  const result = registry.resolve({
    headers: {},
    clientInfo: { name: "claude-code", version: "2.1.92" },
  });
  assert.equal(result?.adapterId, "claude-code");

  const codexResult = registry.resolve({
    headers: {},
    clientInfo: { name: "codex-mcp-client", version: "0.0.0" },
  });
  assert.equal(codexResult?.adapterId, "codex");
});
