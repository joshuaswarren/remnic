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

test("claude-code plugin manifest: userConfig declares bearer token + daemon URL (#2314)", () => {
  const m = readJson(manifestPath);
  const pluginDir = path.resolve(repoRoot, m.plugins[0].source);
  const pluginManifest = readJson(path.join(pluginDir, ".claude-plugin", "plugin.json"));
  // Claude Code installs the plugin only if userConfig values can be authored
  // as a JSON Schema object with `type`, `title`, `description`, and (for
  // secrets) `sensitive: true`. The bearer token MUST be sensitive — Claude
  // Code routes that to the OS keychain (macOS) or a protected credentials
  // file rather than the on-disk plugin install record. Guard this so a
  // future refactor can't silently demote the field to plaintext.
  const uc = pluginManifest.userConfig;
  assert.ok(uc && typeof uc === "object", "userConfig must be an object");
  const token = uc.remnic_daemon_token;
  assert.ok(token && typeof token === "object", "userConfig.remnic_daemon_token must be a schema object");
  assert.equal(token.type, "string", "userConfig.remnic_daemon_token.type must be 'string'");
  assert.equal(token.sensitive, true, "userConfig.remnic_daemon_token.sensitive must be true (routed to OS keychain)");
  const url = uc.remnic_daemon_url;
  assert.ok(url && typeof url === "object", "userConfig.remnic_daemon_url must be a schema object");
  assert.equal(url.type, "string", "userConfig.remnic_daemon_url.type must be 'string'");
  // The local-loopback default is part of the contract from the package README;
  // a refactor that drops it forces users into a hidden HTTPS-only install path.
  assert.equal(
    url.default,
    "http://localhost:4318/mcp",
    "userConfig.remnic_daemon_url.default must equal the documented local daemon URL"
  );
});

test("claude-code plugin manifest: inline mcpServers proxies via stdio to the user's daemon (#2314)", () => {
  const m = readJson(manifestPath);
  const pluginDir = path.resolve(repoRoot, m.plugins[0].source);
  const pluginManifest = readJson(path.join(pluginDir, ".claude-plugin", "plugin.json"));
  // Inline MCP server registration must (a) name the server `remnic` so the
  // marketplace install registers under that key, (b) launch the stdio proxy
  // that lives next to the manifest (so ${CLAUDE_PLUGIN_ROOT} resolves),
  // (c) forward both userConfig values through env (not argv, which is the
  // path that Claude Code rejects per the security advisory bundled with
  // the `userConfig` feature), and (d) declare itself as the canonical
  // server key so older .mcp.json fallback doesn't get out of sync.
  const ms = pluginManifest.mcpServers;
  assert.ok(ms && typeof ms === "object", "mcpServers must be an object");
  const remnic = ms.remnic;
  assert.ok(remnic, "mcpServers.remnic must exist");
  assert.equal(remnic.type, "stdio", "mcpServers.remnic.type must be stdio (token is forwarded via env)");
  assert.ok(Array.isArray(remnic.args), "mcpServers.remnic.args must be an array");
  assert.ok(
    remnic.args.some((a: unknown) => typeof a === "string" && a.includes("mcp-server-stdio/server.js")),
    "mcpServers.remnic.args must reference mcp-server-stdio/server.js"
  );
  // verify args interpolate ${CLAUDE_PLUGIN_ROOT} (the bit Claude Code expands)
  assert.ok(
    remnic.args.some((a: unknown) => typeof a === "string" && a.includes("${CLAUDE_PLUGIN_ROOT}")),
    "mcpServers.remnic.args must use ${CLAUDE_PLUGIN_ROOT} interpolation"
  );
  // verify the userConfig values are wired in via env (not argv — argv with
  // user_config values is the rejected shell-injection pattern)
  assert.ok(remnic.env && typeof remnic.env === "object", "mcpServers.remnic.env must be an object");
  assert.equal(
    remnic.env.REMNIC_PLUGIN_DAEMON_TOKEN,
    "${user_config.remnic_daemon_token}",
    "mcpServers.remnic.env must forward the userConfig token via env, not argv"
  );
  assert.equal(
    remnic.env.REMNIC_PLUGIN_DAEMON_URL,
    "${user_config.remnic_daemon_url}",
    "mcpServers.remnic.env must forward the userConfig URL via env, not argv"
  );
  // verify the proxy script actually exists at the packaged path
  const proxyPath = path.join(pluginDir, "mcp-server-stdio", "server.js");
  assert.ok(
    fs.existsSync(proxyPath),
    `mcp-server-stdio/server.js must be shipped at ${proxyPath} so plugin install can spawn it`
  );
});
