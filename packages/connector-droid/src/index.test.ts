/**
 * Tests for the Factory Droid connector package.
 *
 * Verifies the package exports the expected connector ID and MCP helper
 * functions, and that the helper functions round-trip correctly.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONNECTOR_ID,
  REMNIC_MCP_SERVER_KEY,
  resolveFactoryMcpPath,
  upsertFactoryMcpRemnicEntry,
  removeFactoryMcpRemnicEntry,
} from "./index.js";

test("CONNECTOR_ID is 'droid'", () => {
  assert.equal(CONNECTOR_ID, "droid");
});

test("REMNIC_MCP_SERVER_KEY is 'remnic'", () => {
  assert.equal(REMNIC_MCP_SERVER_KEY, "remnic");
});

test("resolveFactoryMcpPath returns an absolute path ending in .factory/mcp.json", () => {
  const p = resolveFactoryMcpPath();
  assert.ok(p.endsWith(".factory/mcp.json"), `expected path ending in .factory/mcp.json, got ${p}`);
  // Must be absolute
  assert.ok(p.startsWith("/"), `expected absolute path, got ${p}`);
});

test("upsertFactoryMcpRemnicEntry creates a new config with remnic entry", () => {
  const config = upsertFactoryMcpRemnicEntry(null, "test-token-123", {});
  const servers = config.mcpServers as Record<string, unknown>;
  assert.ok("remnic" in servers, "remnic entry must exist");
  const remnic = servers.remnic as Record<string, unknown>;
  assert.equal(remnic.type, "http");
  assert.equal(remnic.url, "http://127.0.0.1:4318/mcp");
  const headers = remnic.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer test-token-123");
});

test("upsertFactoryMcpRemnicEntry preserves existing mcpServers entries", () => {
  const prior = JSON.stringify({
    mcpServers: {
      "other-tool": { type: "stdio", command: "npx" },
    },
  });
  const config = upsertFactoryMcpRemnicEntry(prior, "test-token-456", {});
  const servers = config.mcpServers as Record<string, unknown>;
  assert.ok("other-tool" in servers, "existing entry must be preserved");
  assert.ok("remnic" in servers, "remnic entry must be added");
});

test("upsertFactoryMcpRemnicEntry updates remnic entry on re-install", () => {
  const prior = JSON.stringify({
    mcpServers: {
      remnic: { type: "http", url: "http://old-url:4318/mcp", headers: { Authorization: "Bearer old-token" } },
    },
  });
  const config = upsertFactoryMcpRemnicEntry(prior, "new-token-789", {});
  const servers = config.mcpServers as Record<string, unknown>;
  const remnic = servers.remnic as Record<string, unknown>;
  assert.equal(remnic.url, "http://127.0.0.1:4318/mcp");
  const headers = remnic.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer new-token-789");
});

test("upsertFactoryMcpRemnicEntry does not preserve stale X-Engram-Namespace on reinstall", () => {
  const prior = JSON.stringify({
    mcpServers: {
      remnic: { type: "http", url: "http://localhost:4318/mcp", headers: { Authorization: "Bearer old", "X-Engram-Namespace": "old-ns" } },
    },
  });
  // Reinstall without namespace — should NOT preserve the old namespace.
  const config = upsertFactoryMcpRemnicEntry(prior, "new-tok", {});
  const remnic = (config.mcpServers as Record<string, Record<string, unknown>>).remnic;
  const headers = remnic.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer new-tok");
  assert.ok(!("X-Engram-Namespace" in headers), "stale X-Engram-Namespace must not be preserved");
});

test("upsertFactoryMcpRemnicEntry preserves user-managed headers on reinstall", () => {
  const prior = JSON.stringify({
    mcpServers: {
      remnic: { type: "http", url: "http://localhost:4318/mcp", headers: { Authorization: "Bearer old", "X-Custom-Header": "my-value" } },
    },
  });
  const config = upsertFactoryMcpRemnicEntry(prior, "new-tok", {});
  const remnic = (config.mcpServers as Record<string, Record<string, unknown>>).remnic;
  const headers = remnic.headers as Record<string, string>;
  assert.equal(headers["X-Custom-Header"], "my-value");
});

test("upsertFactoryMcpRemnicEntry adds namespace header when configured", () => {
  const config = upsertFactoryMcpRemnicEntry(null, "tok", { namespace: "my-project" });
  const remnic = (config.mcpServers as Record<string, Record<string, unknown>>).remnic;
  const headers = remnic.headers as Record<string, string>;
  assert.equal(headers["X-Engram-Namespace"], "my-project");
});

test("upsertFactoryMcpRemnicEntry uses custom mcpServerUrl when provided", () => {
  const config = upsertFactoryMcpRemnicEntry(null, "tok", { mcpServerUrl: "http://custom:9999/mcp" });
  const remnic = (config.mcpServers as Record<string, Record<string, unknown>>).remnic;
  assert.equal(remnic.url, "http://custom:9999/mcp");
});

test("upsertFactoryMcpRemnicEntry throws on malformed prior JSON instead of silently discarding entries", () => {
  assert.throws(
    () => upsertFactoryMcpRemnicEntry("not valid json", "tok", {}),
    /malformed JSON/,
  );
});

test("removeFactoryMcpRemnicEntry removes the remnic entry and preserves others", () => {
  const prior = JSON.stringify({
    mcpServers: {
      remnic: { type: "http", url: "http://localhost:4318/mcp" },
      "other-tool": { type: "stdio", command: "npx" },
    },
  });
  const result = removeFactoryMcpRemnicEntry(prior);
  assert.ok(result !== null, "should return updated config");
  const servers = result.mcpServers as Record<string, unknown>;
  assert.ok(!("remnic" in servers), "remnic entry must be removed");
  assert.ok("other-tool" in servers, "other entries must be preserved");
});

test("removeFactoryMcpRemnicEntry returns null when remnic is absent", () => {
  const prior = JSON.stringify({
    mcpServers: {
      "other-tool": { type: "stdio", command: "npx" },
    },
  });
  const result = removeFactoryMcpRemnicEntry(prior);
  assert.equal(result, null);
});

test("removeFactoryMcpRemnicEntry returns null for malformed JSON", () => {
  const result = removeFactoryMcpRemnicEntry("not valid json");
  assert.equal(result, null);
});

test("removeFactoryMcpRemnicEntry returns null when mcpServers is missing", () => {
  const prior = JSON.stringify({ otherKey: "value" });
  const result = removeFactoryMcpRemnicEntry(prior);
  assert.equal(result, null);
});
