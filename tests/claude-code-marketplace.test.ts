import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Contract tests for the Claude Code marketplace manifest
// (.claude-plugin/marketplace.json). These guard against documentation /
// packaging drift for the `claude plugin marketplace add joshuaswarren/remnic`
// + `claude plugin install remnic@remnic` install path documented in
// docs/plugins/claude-code.md. They validate the static manifest against the
// on-disk plugin — no `claude` CLI required, so they run in CI.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, ".claude-plugin", "marketplace.json");

function readJson(p: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

test("claude-code marketplace manifest: valid Claude Code marketplace shape", () => {
  const m = readJson(manifestPath);
  assert.equal(typeof m.name, "string");
  assert.ok(m.name.length > 0, "marketplace name must be non-empty");
  assert.equal(typeof m.owner, "object");
  assert.equal(typeof m.owner.name, "string");
  assert.ok(m.owner.name.length > 0, "owner.name must be non-empty");
  assert.ok(Array.isArray(m.plugins));
  assert.equal(m.plugins.length, 1, "expected exactly one plugin entry (claude-code)");
});

test("claude-code marketplace manifest: plugin source resolves to a real plugin", () => {
  const m = readJson(manifestPath);
  const plugin = m.plugins[0];
  assert.equal(typeof plugin.name, "string");
  // Pin the canonical source: the marketplace must point at this exact path.
  // Any other value — even one that happens to resolve to a plugin with a
  // matching name — is a contract change and must fail here.
  assert.equal(
    plugin.source,
    "./packages/plugin-claude-code",
    "marketplace plugin source must be the canonical ./packages/plugin-claude-code"
  );

  // `source` is repo-relative; it must resolve to a real plugin directory that
  // carries its own Claude Code plugin manifest.
  const pluginDir = path.resolve(repoRoot, plugin.source);
  assert.ok(fs.existsSync(pluginDir), `plugin source dir missing: ${plugin.source}`);
  const pluginManifestPath = path.join(pluginDir, ".claude-plugin", "plugin.json");
  assert.ok(
    fs.existsSync(pluginManifestPath),
    `plugin manifest missing at ${plugin.source}/.claude-plugin/plugin.json`
  );

  // Drift guard: if the plugin is renamed or moved, this must be updated too.
  const pluginManifest = readJson(pluginManifestPath);
  assert.equal(
    plugin.name,
    pluginManifest.name,
    "marketplace plugin name must match the plugin's own plugin.json name"
  );
});

test("claude-code marketplace manifest: version lives only in plugin.json (single source)", () => {
  const m = readJson(manifestPath);
  const plugin = m.plugins[0];
  // Claude Code prioritizes plugin.json's version, so a second copy in the
  // marketplace entry only drifts. Keep plugin.json canonical.
  assert.equal(plugin.version, undefined, "marketplace plugin entry must not declare its own version");
});

test("claude-code plugin manifest: author is an object so the plugin is marketplace-installable", () => {
  const m = readJson(manifestPath);
  const pluginDir = path.resolve(repoRoot, m.plugins[0].source);
  const pluginManifest = readJson(path.join(pluginDir, ".claude-plugin", "plugin.json"));
  // Claude Code's manifest validator rejects a string `author`
  // ("expected object, received string"), which blocks `claude plugin install`.
  // Guards the regression fixed in #2268.
  assert.equal(typeof pluginManifest.author, "object", "plugin author must be an object");
  assert.ok(pluginManifest.author && !Array.isArray(pluginManifest.author), "plugin author must be a plain object");
  assert.equal(typeof pluginManifest.author.name, "string");
  assert.ok(pluginManifest.author.name.length > 0, "plugin author.name must be non-empty");
});

test("claude-code marketplace manifest: bundled .mcp.json is a failsafe placeholder, not a working remnic server", () => {
  // The marketplace install copies packages/plugin-claude-code into Claude Code's
  // plugin tree and auto-discovers any root .mcp.json. A literal
  // {{REMNIC_TOKEN}} placeholder + localhost URL would register a `remnic`
  // server that 401s on every call until the user edits the installed copy,
  // and reinstalls would silently overwrite that edit. To avoid that, the
  // bundled file uses a deliberately inert server key + a port-0 URL that
  // fails closed at startup, so the marketplace install leaves the real
  // `remnic` server unregistered and the user registers it explicitly via
  // `claude mcp add` (documented in docs/plugins/claude-code.md).
  const m = readJson(manifestPath);
  const pluginDir = path.resolve(repoRoot, m.plugins[0].source);
  const bundledMcpPath = path.join(pluginDir, ".mcp.json");
  assert.ok(fs.existsSync(bundledMcpPath), `bundled .mcp.json missing at ${pluginDir}/.mcp.json`);
  const bundledMcp = readJson(bundledMcpPath);
  const servers = bundledMcp.mcpServers;
  assert.equal(typeof servers, "object", "mcpServers must be an object");
  // Must NOT register a real `remnic` server — that would shadow the
  // `claude mcp add remnic` the docs ask the user to run.
  assert.equal(
    servers.remnic,
    undefined,
    "bundled .mcp.json must not register a real `remnic` MCP server on marketplace install"
  );
  // The named placeholder server must fail closed at connection time.
  const placeholder = servers["remnic-placeholder"];
  assert.ok(placeholder, "bundled .mcp.json must register a `remnic-placeholder` server with a sentinel URL");
  assert.equal(placeholder.url, "http://127.0.0.1:0/mcp", "placeholder URL must fail closed (port 0)");
});
