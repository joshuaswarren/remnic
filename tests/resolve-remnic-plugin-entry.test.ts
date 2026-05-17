/**
 * Regression tests for {@link resolveRemnicPluginEntry} and the shim's
 * access-cli `preferredId` plumbing (#403).
 *
 * Context:
 *   OpenClaw gates memory plugin registration on `plugins.slots.memory`
 *   matching the plugin id.  Remnic ships two plugin ids:
 *     - canonical:  "openclaw-remnic" (PLUGIN_ID)
 *     - legacy shim: "openclaw-engram" (LEGACY_PLUGIN_ID)
 *
 *   When a user runs the shim binary `engram-access` and has both config
 *   blocks in `plugins.entries` with no `plugins.slots.memory` override, the
 *   resolver must target their own legacy entry — otherwise the shim CLI
 *   silently reads/writes against the canonical block's `memoryDir` and
 *   policy, corrupting migration.
 *
 *   An earlier revision of the split refactor called
 *   `resolveRemnicPluginEntry(raw)` without a `preferredId`, so the shim CLI
 *   fell through to `PLUGIN_ID` first.  Codex P1 flagged this.  The fix
 *   threads `preferredId` through runCli → main → buildRuntime →
 *   loadPluginConfig → resolveRemnicPluginEntry, and the shim's bin wrapper
 *   hardcodes `preferredId: "openclaw-engram"`.
 *
 *   These tests lock that behaviour in place.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEGACY_PLUGIN_ID,
  PLUGIN_ID,
  resolveRemnicPluginEntry,
} from "../packages/remnic-core/src/plugin-id.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHIM_BIN_PATH = path.resolve(
  __dirname,
  "..",
  "packages",
  "shim-openclaw-engram",
  "bin",
  "engram-access.js",
);
const ROOT_ENGRAM_ACCESS_BIN_PATH = path.resolve(
  __dirname,
  "..",
  "bin",
  "engram-access.js",
);

function configWithBothEntries() {
  return {
    plugins: {
      entries: {
        [PLUGIN_ID]: {
          config: { memoryDir: "/tmp/canonical", marker: "canonical" },
        },
        [LEGACY_PLUGIN_ID]: {
          config: { memoryDir: "/tmp/legacy", marker: "legacy" },
        },
      },
    },
  };
}

test("resolveRemnicPluginEntry returns undefined for non-object input", () => {
  assert.equal(resolveRemnicPluginEntry(null), undefined);
  assert.equal(resolveRemnicPluginEntry(undefined), undefined);
  assert.equal(resolveRemnicPluginEntry("nope"), undefined);
  assert.equal(resolveRemnicPluginEntry(42), undefined);
});

test("resolveRemnicPluginEntry returns undefined when plugins.entries is missing", () => {
  assert.equal(resolveRemnicPluginEntry({}), undefined);
  assert.equal(resolveRemnicPluginEntry({ plugins: {} }), undefined);
  assert.equal(resolveRemnicPluginEntry({ plugins: { entries: null } }), undefined);
});

test("resolveRemnicPluginEntry prefers canonical entry when no preferredId and no slot", () => {
  const entry = resolveRemnicPluginEntry(configWithBothEntries());
  assert.ok(entry, "entry must be defined");
  const cfg = entry["config"] as { marker: string };
  assert.equal(cfg.marker, "canonical");
});

test("resolveRemnicPluginEntry returns legacy entry when preferredId='openclaw-engram' and no slot (#403)", () => {
  // This is the regression test for the shim access-cli Codex P1.  When the
  // shim binary passes its own plugin id, the helper must pick the legacy
  // entry even though both blocks exist.
  const entry = resolveRemnicPluginEntry(configWithBothEntries(), LEGACY_PLUGIN_ID);
  assert.ok(entry, "entry must be defined");
  const cfg = entry["config"] as { marker: string };
  assert.equal(
    cfg.marker,
    "legacy",
    "shim CLI (preferredId='openclaw-engram') must resolve to the legacy entry",
  );
});

test("resolveRemnicPluginEntry returns canonical entry when preferredId='openclaw-remnic' and no slot", () => {
  const entry = resolveRemnicPluginEntry(configWithBothEntries(), PLUGIN_ID);
  assert.ok(entry, "entry must be defined");
  const cfg = entry["config"] as { marker: string };
  assert.equal(cfg.marker, "canonical");
});

test("resolveRemnicPluginEntry ignores unknown preferredId (safety guard)", () => {
  // An unexpected preferredId must fall through to the hardcoded canonical
  // fallback — never trust a caller-supplied value that isn't a known
  // Remnic id.
  const entry = resolveRemnicPluginEntry(configWithBothEntries(), "some-other-plugin");
  assert.ok(entry, "entry must be defined");
  const cfg = entry["config"] as { marker: string };
  assert.equal(cfg.marker, "canonical");
});

test("resolveRemnicPluginEntry honours plugins.slots.memory over preferredId", () => {
  const raw = {
    plugins: {
      slots: { memory: PLUGIN_ID },
      entries: configWithBothEntries().plugins.entries,
    },
  };
  // Even though the shim says "use legacy", the active slot forces canonical.
  const entry = resolveRemnicPluginEntry(raw, LEGACY_PLUGIN_ID);
  assert.ok(entry, "entry must be defined");
  const cfg = entry["config"] as { marker: string };
  assert.equal(cfg.marker, "canonical");
});

test("resolveRemnicPluginEntry ignores foreign slot and honours preferredId", () => {
  // Mixed-plugin installs: plugins.slots.memory points at a non-Remnic plugin.
  // The slot must be ignored so we don't accidentally apply someone else's
  // config to Remnic.  With the foreign slot ignored, preferredId still wins.
  const raw = {
    plugins: {
      slots: { memory: "some-other-memory-plugin" },
      entries: configWithBothEntries().plugins.entries,
    },
  };
  const entry = resolveRemnicPluginEntry(raw, LEGACY_PLUGIN_ID);
  assert.ok(entry, "entry must be defined");
  const cfg = entry["config"] as { marker: string };
  assert.equal(cfg.marker, "legacy");
});

test("resolveRemnicPluginEntry falls back to legacy entry when only legacy exists and no preferredId", () => {
  const raw = {
    plugins: {
      entries: {
        [LEGACY_PLUGIN_ID]: {
          config: { memoryDir: "/tmp/legacy", marker: "legacy" },
        },
      },
    },
  };
  const entry = resolveRemnicPluginEntry(raw);
  assert.ok(entry, "entry must be defined");
  const cfg = entry["config"] as { marker: string };
  assert.equal(cfg.marker, "legacy");
});

test("shim engram-access bin wrapper passes preferredId='openclaw-engram' to runCli (#403)", () => {
  // Lock the shim bin wrapper so it never regresses to calling runCli without
  // preferredId.  The bin wrapper is hand-written (not generated) so a plain
  // string check is sufficient — if this file ever gets rewritten, the test
  // forces the author to re-read the #403 rationale comment.
  const src = fs.readFileSync(SHIM_BIN_PATH, "utf8");
  assert.match(
    src,
    /preferredId:\s*"openclaw-engram"/,
    "shim bin wrapper must pass preferredId='openclaw-engram' so resolveRemnicPluginEntry targets the legacy entry for shim CLI users — see #403",
  );
  assert.match(
    src,
    /runCli\s*\(\s*process\.argv\.slice\(2\)\s*,/,
    "shim bin wrapper must forward process.argv AND options to runCli",
  );
});

test("root engram-access bin wrapper passes preferredId='openclaw-engram'", () => {
  const src = fs.readFileSync(ROOT_ENGRAM_ACCESS_BIN_PATH, "utf8");
  assert.match(
    src,
    /preferredId:\s*"openclaw-engram"/,
    "root engram-access bin must identify itself as the legacy caller so mixed canonical/legacy configs target the legacy entry",
  );
  assert.match(
    src,
    /runCli\s*\(\s*process\.argv\.slice\(2\)\s*,/,
    "root engram-access bin wrapper must forward process.argv AND options to runCli",
  );
});
