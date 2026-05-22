/**
 * Regression test for the plugin id split (#403).
 *
 * Asserts that:
 *   - @remnic/plugin-openclaw and the root manifest use the canonical id "openclaw-remnic"
 *   - @joshuaswarren/openclaw-engram (shim) intentionally keeps the legacy id "openclaw-engram"
 *   - The OpenClaw adapter owns the OpenClaw plugin-id constants
 *   - @remnic/core does not export OpenClaw-specific plugin IDs
 *
 * This test locks the id split in place so a future refactor cannot silently
 * revert the rename or break the shim's backwards-compat guarantee.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REMNIC_OPENCLAW_LEGACY_PLUGIN_ID,
  REMNIC_OPENCLAW_PLUGIN_ID,
} from "../packages/plugin-openclaw/src/plugin-id.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PACKAGES_DIR = path.join(ROOT, "packages");

function readManifestId(manifestPath: string): string {
  const raw = fs.readFileSync(manifestPath, "utf-8");
  const manifest = JSON.parse(raw) as { id?: string };
  assert.ok(typeof manifest.id === "string", `${manifestPath} must have a string "id" field`);
  return manifest.id as string;
}

test("REMNIC_OPENCLAW_PLUGIN_ID constant equals 'openclaw-remnic'", () => {
  assert.equal(REMNIC_OPENCLAW_PLUGIN_ID, "openclaw-remnic");
});

test("REMNIC_OPENCLAW_LEGACY_PLUGIN_ID constant equals 'openclaw-engram'", () => {
  assert.equal(REMNIC_OPENCLAW_LEGACY_PLUGIN_ID, "openclaw-engram");
});

test("@remnic/core package does not export OpenClaw plugin-id constants", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(PACKAGES_DIR, "remnic-core", "package.json"), "utf-8"),
  ) as { exports?: Record<string, unknown> };
  assert.equal(packageJson.exports?.["./plugin-id"], undefined);
  assert.equal(packageJson.exports?.["./plugin-id.js"], undefined);
});

test("root openclaw.plugin.json declares id 'openclaw-remnic'", () => {
  const id = readManifestId(path.join(ROOT, "openclaw.plugin.json"));
  assert.equal(
    id,
    REMNIC_OPENCLAW_PLUGIN_ID,
    `Root manifest id must be "${REMNIC_OPENCLAW_PLUGIN_ID}" (got "${id}")`,
  );
});

test("packages/plugin-openclaw/openclaw.plugin.json declares id 'openclaw-remnic'", () => {
  const manifestPath = path.join(PACKAGES_DIR, "plugin-openclaw", "openclaw.plugin.json");
  const id = readManifestId(manifestPath);
  assert.equal(
    id,
    REMNIC_OPENCLAW_PLUGIN_ID,
    `plugin-openclaw manifest id must be "${REMNIC_OPENCLAW_PLUGIN_ID}" (got "${id}") — see #403`,
  );
});

test("packages/shim-openclaw-engram/openclaw.plugin.json declares id 'openclaw-engram' (legacy compat)", () => {
  const manifestPath = path.join(PACKAGES_DIR, "shim-openclaw-engram", "openclaw.plugin.json");
  const id = readManifestId(manifestPath);
  assert.equal(
    id,
    REMNIC_OPENCLAW_LEGACY_PLUGIN_ID,
    `shim manifest id must stay "${REMNIC_OPENCLAW_LEGACY_PLUGIN_ID}" for backwards compat (got "${id}") — see #403`,
  );
});

test("plugin id split: non-shim ids match canonical OpenClaw id and shim id matches legacy id", () => {
  const rootId = readManifestId(path.join(ROOT, "openclaw.plugin.json"));
  const pluginId = readManifestId(path.join(PACKAGES_DIR, "plugin-openclaw", "openclaw.plugin.json"));
  const shimId = readManifestId(path.join(PACKAGES_DIR, "shim-openclaw-engram", "openclaw.plugin.json"));

  assert.equal(rootId, REMNIC_OPENCLAW_PLUGIN_ID, "root manifest must match canonical OpenClaw id");
  assert.equal(pluginId, REMNIC_OPENCLAW_PLUGIN_ID, "plugin-openclaw manifest must match canonical OpenClaw id");
  assert.equal(shimId, REMNIC_OPENCLAW_LEGACY_PLUGIN_ID, "shim manifest must match legacy OpenClaw id");
  assert.notEqual(
    REMNIC_OPENCLAW_PLUGIN_ID,
    REMNIC_OPENCLAW_LEGACY_PLUGIN_ID,
    "canonical and legacy OpenClaw plugin ids must be distinct",
  );
});
