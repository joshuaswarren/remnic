/**
 * Integration tests for the Droid connector install/remove/doctor flow.
 *
 * Tests validate:
 * - droid appears in BUILTIN_CONNECTORS with the expected manifest
 * - installConnector writes ~/.factory/mcp.json with HTTP MCP + bearer token
 * - the token is NOT written into the connector.json registry file
 * - existing mcpServers entries in ~/.factory/mcp.json are preserved
 * - removeConnector removes the remnic entry from ~/.factory/mcp.json
 * - doctorConnector checks the ~/.factory/mcp.json remnic entry
 *
 * All tests use a temp HOME so no real user config is modified.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const CONNECTORS_SRC = path.join(ROOT, "packages/remnic-core/src/connectors/index.ts");
const DROID_MCP_SRC = path.join(ROOT, "packages/remnic-core/src/connectors/droid-mcp.ts");

// ── Source-level checks ───────────────────────────────────────────────────

test("droid is in BUILTIN_CONNECTORS", () => {
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");
  assert.ok(content.includes("DROID_CONNECTOR_MANIFEST"), "index.ts must reference DROID_CONNECTOR_MANIFEST");
  const droidContent = fs.readFileSync(DROID_MCP_SRC, "utf-8");
  assert.ok(droidContent.includes('id: "droid"'), "droid manifest must exist in droid-mcp.ts");
  assert.ok(droidContent.includes('name: "Factory Droid"'), "Must have correct name");
});

test("droid connector has expected capabilities", () => {
  const content = fs.readFileSync(DROID_MCP_SRC, "utf-8");
  const droidIdx = content.indexOf('id: "droid"');
  assert.ok(droidIdx >= 0, "droid block must exist");
  const window = content.slice(droidIdx, droidIdx + 600);
  assert.ok(window.includes("observe: true"), "droid must support observe");
  assert.ok(window.includes("recall: true"), "droid must support recall");
  assert.ok(window.includes("store: true"), "droid must support store");
  assert.ok(window.includes("search: true"), "droid must support search");
  assert.ok(window.includes('connectionType: "mcp"'), "droid must use mcp connection type");
});

test("droid connector requires a token", () => {
  const content = fs.readFileSync(DROID_MCP_SRC, "utf-8");
  const droidIdx = content.indexOf('id: "droid"');
  const window = content.slice(droidIdx, droidIdx + 800);
  assert.ok(window.includes("requiresToken: true"), "droid must require a token");
});

test("resolveFactoryMcpPath is exported", () => {
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");
  assert.ok(
    content.includes("resolveFactoryMcpPath"),
    "resolveFactoryMcpPath must be exported from connectors/index.ts",
  );
});

test("upsertFactoryMcpRemnicEntry is exported", () => {
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");
  assert.ok(
    content.includes("upsertFactoryMcpRemnicEntry"),
    "upsertFactoryMcpRemnicEntry must be exported from connectors/index.ts",
  );
});

test("removeFactoryMcpRemnicEntry is exported", () => {
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");
  assert.ok(
    content.includes("removeFactoryMcpRemnicEntry"),
    "removeFactoryMcpRemnicEntry must be exported from connectors/index.ts",
  );
});

test("installConnector has a droid-specific block that writes ~/.factory/mcp.json", () => {
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");
  assert.ok(
    content.includes('options.connectorId === "droid"'),
    "installConnector must have a droid-specific block",
  );
  assert.ok(
    content.includes("droidInstallStep"),
    "installConnector must call droidInstallStep for droid",
  );
  // The actual implementation lives in droid-mcp.ts
  const droidMcpSrc = fs.readFileSync(
    path.join(ROOT, "packages/remnic-core/src/connectors/droid-mcp.ts"),
    "utf-8",
  );
  assert.ok(
    droidMcpSrc.includes("resolveFactoryMcpPath"),
    "droid-mcp.ts must resolve the factory MCP path",
  );
  assert.ok(
    droidMcpSrc.includes("upsertFactoryMcpRemnicEntry"),
    "droid-mcp.ts must upsert the remnic entry",
  );
});

test("removeConnector has a droid-specific block that removes the remnic entry", () => {
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");
  // Find the removeConnector section
  const removeIdx = content.indexOf("export function removeConnector");
  assert.ok(removeIdx >= 0, "removeConnector must exist");
  const removeSection = content.slice(removeIdx);
  assert.ok(
    removeSection.includes('connectorId === "droid"'),
    "removeConnector must have a droid-specific block",
  );
  assert.ok(
    removeSection.includes("removeDroidMcpEntry"),
    "removeConnector must call removeDroidMcpEntry for droid",
  );
  // The actual implementation lives in droid-mcp.ts
  const droidMcpSrc = fs.readFileSync(
    path.join(ROOT, "packages/remnic-core/src/connectors/droid-mcp.ts"),
    "utf-8",
  );
  assert.ok(
    droidMcpSrc.includes("removeFactoryMcpRemnicEntry"),
    "droid-mcp.ts must call removeFactoryMcpRemnicEntry",
  );
});

test("doctorConnector has a droid-specific check for ~/.factory/mcp.json", () => {
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");
  const doctorIdx = content.indexOf("export async function doctorConnector");
  assert.ok(doctorIdx >= 0, "doctorConnector must exist");
  const doctorSection = content.slice(doctorIdx);
  assert.ok(
    doctorSection.includes('connectorId === "droid"'),
    "doctorConnector must have a droid-specific check",
  );
});

// ── Functional tests (tsx import) ─────────────────────────────────────────

test("droid install/remove/doctor flow with temp HOME", async () => {
  // Set up a temp HOME so we don't touch the real ~/.factory or ~/.remnic
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-droid-test-"));
  const origHome = process.env.HOME;
  const origRemnicHome = process.env.REMNIC_HOME;
  const origXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.HOME = tmpHome;
  process.env.REMNIC_HOME = path.join(tmpHome, ".remnic");
  // Clear XDG_CONFIG_HOME so the connectors dir resolves under tmpHome/.config
  delete process.env.XDG_CONFIG_HOME;

  try {
    // Dynamic import so env vars take effect
    const {
      installConnector,
      removeConnector,
      listConnectors,
      resolveFactoryMcpPath,
      getConnectorsDir,
    } = await import("../../packages/remnic-core/src/connectors/index.js");

    // Verify droid appears in available connectors
    const { available } = listConnectors();
    const droidManifest = available.find((c) => c.id === "droid");
    assert.ok(droidManifest, "droid must appear in available connectors");
    assert.equal(droidManifest.name, "Factory Droid");

    // ── Pre-existing mcp.json with other entries ──
    const mcpPath = resolveFactoryMcpPath();
    fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
    const existingConfig = {
      mcpServers: {
        "other-tool": { type: "stdio", command: "npx", args: ["-y", "other-tool"] },
      },
    };
    fs.writeFileSync(mcpPath, JSON.stringify(existingConfig, null, 2));

    // ── Install ──
    const installResult = installConnector({ connectorId: "droid" });
    assert.equal(installResult.status, "installed", `install should succeed: ${installResult.message}`);

    // Verify droid is now listed as installed
    const { installed } = listConnectors();
    const droidInstalled = installed.find((c) => c.connectorId === "droid");
    assert.ok(droidInstalled, "droid must appear in installed connectors");

    // Verify ~/.factory/mcp.json has the remnic entry
    assert.ok(fs.existsSync(mcpPath), "~/.factory/mcp.json must exist after install");
    const mcpContent = JSON.parse(fs.readFileSync(mcpPath, "utf8")) as Record<string, unknown>;
    const servers = mcpContent.mcpServers as Record<string, unknown>;
    assert.ok("remnic" in servers, "remnic entry must be in mcpServers");
    const remnicEntry = servers.remnic as Record<string, unknown>;
    assert.equal(remnicEntry.type, "http");
    assert.ok((remnicEntry.url as string).includes("/mcp"), "URL must point to MCP endpoint");
    const headers = remnicEntry.headers as Record<string, string>;
    assert.ok(headers["Authorization"], "Authorization header must be present");
    assert.ok(headers["Authorization"].startsWith("Bearer "), "Authorization must be a Bearer token");

    // Verify existing entries are preserved
    assert.ok("other-tool" in servers, "existing mcpServers entries must be preserved");

    // Verify token is NOT in the connector.json registry file
    const connectorsDir = getConnectorsDir();
    const droidJsonPath = path.join(connectorsDir, "droid.json");
    assert.ok(fs.existsSync(droidJsonPath), `droid.json must exist at ${droidJsonPath}`);
    const droidJson = JSON.parse(fs.readFileSync(droidJsonPath, "utf8")) as Record<string, unknown>;
    assert.ok(!("token" in droidJson), "token must NOT be in connector.json");

    // ── Doctor ──
    const { doctorConnector } = await import("../../packages/remnic-core/src/connectors/index.js");
    const doctorResult = await doctorConnector("droid");
    // Config file and config valid should pass
    const configCheck = doctorResult.checks.find((c) => c.name === "Config file");
    assert.ok(configCheck?.ok, "Config file check should pass");
    const droidMcpCheck = doctorResult.checks.find((c) => c.name === "Droid MCP config");
    assert.ok(droidMcpCheck, "Droid MCP config check must exist");
    assert.ok(droidMcpCheck?.ok, "Droid MCP config check should pass");

    // ── Remove ──
    const removeResult = removeConnector("droid");
    assert.equal(removeResult.status, "removed", `remove should succeed: ${removeResult.message}`);

    // Verify remnic entry is removed from ~/.factory/mcp.json but other-tool preserved
    const mcpAfterRemove = JSON.parse(fs.readFileSync(mcpPath, "utf8")) as Record<string, unknown>;
    const serversAfter = mcpAfterRemove.mcpServers as Record<string, unknown>;
    assert.ok(!("remnic" in serversAfter), "remnic entry must be removed");
    assert.ok("other-tool" in serversAfter, "other entries must be preserved");

    // Verify droid.json is deleted
    assert.ok(!fs.existsSync(droidJsonPath), "droid.json must be deleted after remove");
  } finally {
    if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
    if (origRemnicHome !== undefined) {
      process.env.REMNIC_HOME = origRemnicHome;
    } else {
      delete process.env.REMNIC_HOME;
    }
    if (origXdgConfigHome !== undefined) {
      process.env.XDG_CONFIG_HOME = origXdgConfigHome;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    // Clean up temp dir
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

test("droid install preserves user-level mcp.json and never touches project-level", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-droid-privacy-"));
  const origHome = process.env.HOME;
  const origRemnicHome = process.env.REMNIC_HOME;
  const origXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.HOME = tmpHome;
  process.env.REMNIC_HOME = path.join(tmpHome, ".remnic");
  delete process.env.XDG_CONFIG_HOME;

  try {
    const { installConnector, resolveFactoryMcpPath } = await import(
      "../../packages/remnic-core/src/connectors/index.js"
    );

    // Create a user-level mcp.json with existing config
    const userMcpPath = resolveFactoryMcpPath();
    fs.mkdirSync(path.dirname(userMcpPath), { recursive: true });
    const userConfig = {
      mcpServers: {
        "my-existing-server": { type: "http", url: "http://localhost:3000/mcp" },
      },
    };
    fs.writeFileSync(userMcpPath, JSON.stringify(userConfig, null, 2));

    // Install droid
    const result = installConnector({ connectorId: "droid" });
    assert.equal(result.status, "installed");

    // Verify user-level file still has the existing entry plus remnic
    const after = JSON.parse(fs.readFileSync(userMcpPath, "utf8")) as Record<string, unknown>;
    const servers = after.mcpServers as Record<string, unknown>;
    assert.ok("my-existing-server" in servers, "user's existing server must be preserved");
    assert.ok("remnic" in servers, "remnic must be added");

    // Verify NO project-level .factory/mcp.json was created
    const projectMcpPath = path.join(process.cwd(), ".factory", "mcp.json");
    assert.ok(
      !fs.existsSync(projectMcpPath),
      "project-level .factory/mcp.json must NOT be created by install",
    );
  } finally {
    if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
    if (origRemnicHome !== undefined) {
      process.env.REMNIC_HOME = origRemnicHome;
    } else {
      delete process.env.REMNIC_HOME;
    }
    if (origXdgConfigHome !== undefined) {
      process.env.XDG_CONFIG_HOME = origXdgConfigHome;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});
