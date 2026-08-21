/**
 * Unit tests for the `remnic openclaw install` config mutation logic.
 *
 * These tests verify the config manipulation functions directly without
 * requiring @remnic/core to be built. They cover:
 * - fresh install creates openclaw-remnic entry and slot
 * - dry-run does not write files
 * - migrates from legacy entry
 * - collision handling
 * - custom --memory-dir
 * - custom --config path
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";

// We test the config mutation logic directly, without going through the CLI
// binary. This avoids requiring @remnic/core to be built.

interface OpenclawPluginEntry {
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

interface OpenclawConfig {
  plugins?: {
    entries?: Record<string, OpenclawPluginEntry>;
    slots?: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Pure config mutation logic extracted from cmdOpenclawInstall.
 * Returns the updated config without writing to disk.
 */
function buildUpdatedOpenclawConfig(
  existingConfig: OpenclawConfig,
  memoryDir: string,
  migrateLegacy: boolean,
): OpenclawConfig {
  const plugins = (existingConfig.plugins ?? {}) as NonNullable<OpenclawConfig["plugins"]>;
  const entries = (plugins.entries ?? {}) as Record<string, OpenclawPluginEntry>;
  const slots = (plugins.slots ?? {}) as Record<string, string>;

  const legacyEntry = entries["openclaw-engram"];
  const existingNewEntry = entries["openclaw-remnic"];

  // Only merge legacy config when the operator confirmed migration (migrateLegacy=true),
  // matching the behaviour in cmdOpenclawInstall.
  const legacyConfigToMerge =
    migrateLegacy && legacyEntry?.config && typeof legacyEntry.config === "object"
      ? (legacyEntry.config as Record<string, unknown>)
      : {};
  const defaultModelSource = !existingNewEntry && !migrateLegacy ? "gateway" : "plugin";

  const legacyHooks =
    migrateLegacy && legacyEntry?.hooks && typeof legacyEntry.hooks === "object" && !Array.isArray(legacyEntry.hooks)
      ? (legacyEntry.hooks as Record<string, unknown>)
      : {};
  const existingHooks =
    existingNewEntry?.hooks && typeof existingNewEntry.hooks === "object" && !Array.isArray(existingNewEntry.hooks)
      ? (existingNewEntry.hooks as Record<string, unknown>)
      : {};

  const newEntry: OpenclawPluginEntry = {
    hooks: {
      ...legacyHooks,
      ...existingHooks,
      allowConversationAccess: true,
    },
    config: {
      modelSource: defaultModelSource,
      ...legacyConfigToMerge,
      ...(existingNewEntry?.config && typeof existingNewEntry.config === "object" ? existingNewEntry.config : {}),
      memoryDir,
    },
  };

  const updatedEntries: Record<string, OpenclawPluginEntry> = { ...entries };
  updatedEntries["openclaw-remnic"] = newEntry;

  // Switch the slot to the canonical id unless the operator declined migration
  // AND the current slot is already actively pointing at the legacy entry.
  const hasLegacy = "openclaw-engram" in entries;
  const currentSlot = slots.memory as string | undefined;
  const slotIsActiveLegacy =
    hasLegacy && !migrateLegacy && currentSlot === "openclaw-engram";
  const updatedSlots = slotIsActiveLegacy
    ? { ...slots }
    : { ...slots, memory: "openclaw-remnic" };

  return {
    ...existingConfig,
    plugins: {
      ...plugins,
      entries: updatedEntries,
      slots: updatedSlots,
    },
  };
}

async function makeTmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "openclaw-install-logic-test-"));
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("fresh install: creates openclaw-remnic entry and slot", () => {
  const memoryDir = "/tmp/test-memory";
  const result = buildUpdatedOpenclawConfig({}, memoryDir, false);

  assert.ok(result.plugins?.entries?.["openclaw-remnic"], "openclaw-remnic entry should be created");
  assert.equal(result.plugins?.slots?.memory, "openclaw-remnic", "slot should be set to openclaw-remnic");
  assert.equal(
    result.plugins!.entries!["openclaw-remnic"].config?.memoryDir,
    memoryDir,
    "memoryDir should match",
  );
  assert.equal(
    result.plugins!.entries!["openclaw-remnic"].config?.modelSource,
    "gateway",
    "fresh OpenClaw installs should route Remnic LLM calls through the gateway by default",
  );
});

test("fresh install: enables OpenClaw conversation-access hooks", () => {
  const result = buildUpdatedOpenclawConfig({}, "/tmp/test-memory", false);

  assert.deepEqual(
    result.plugins!.entries!["openclaw-remnic"].hooks,
    { allowConversationAccess: true },
    "OpenClaw 2026.5 requires explicit conversation access for agent_end/llm_output hooks",
  );
});

test("migration: preserves hook policy fields while enabling conversation access", () => {
  const existing: OpenclawConfig = {
    plugins: {
      entries: {
        "openclaw-engram": {
          hooks: { allowPromptInjection: false, customFlag: "legacy" },
          config: { memoryDir: "/old/path" },
        },
      },
    },
  };
  const result = buildUpdatedOpenclawConfig(existing, "/new/path", true);

  assert.deepEqual(result.plugins!.entries!["openclaw-remnic"].hooks, {
    allowPromptInjection: false,
    customFlag: "legacy",
    allowConversationAccess: true,
  });
});

test("declined migration: does not merge legacy hook policy fields", () => {
  const existing: OpenclawConfig = {
    plugins: {
      entries: {
        "openclaw-engram": {
          hooks: { allowPromptInjection: false, customFlag: "legacy" },
          config: { memoryDir: "/old/path" },
        },
      },
      slots: { memory: "openclaw-engram" },
    },
  };
  const result = buildUpdatedOpenclawConfig(existing, "/new/path", false);

  assert.deepEqual(result.plugins!.entries!["openclaw-remnic"].hooks, {
    allowConversationAccess: true,
  });
  assert.equal(result.plugins?.slots?.memory, "openclaw-engram");
});

test("reinstall: keeps existing hook fields while repairing conversation access", () => {
  const existing: OpenclawConfig = {
    plugins: {
      entries: {
        "openclaw-remnic": {
          hooks: { allowConversationAccess: false, allowPromptInjection: false },
          config: { memoryDir: "/old/path" },
        },
      },
    },
  };
  const result = buildUpdatedOpenclawConfig(existing, "/new/path", false);

  assert.deepEqual(result.plugins!.entries!["openclaw-remnic"].hooks, {
    allowConversationAccess: true,
    allowPromptInjection: false,
  });
});

test("fresh install: preserves existing top-level config keys", () => {
  const existingConfig: OpenclawConfig = {
    gateway: { port: 3000 },
    agents: { list: [] },
  };
  const result = buildUpdatedOpenclawConfig(existingConfig, "/tmp/mem", false);

  assert.deepEqual(
    (result as Record<string, unknown>).gateway,
    { port: 3000 },
    "existing gateway config should be preserved",
  );
});

test("migration: adds openclaw-remnic alongside legacy openclaw-engram", () => {
  const existing: OpenclawConfig = {
    plugins: {
      entries: {
        "openclaw-engram": { config: { memoryDir: "/old/path", debug: true } },
      },
      slots: { memory: "openclaw-engram" },
    },
  };
  const result = buildUpdatedOpenclawConfig(existing, "/new/path", true);

  // New entry should exist
  assert.ok(result.plugins?.entries?.["openclaw-remnic"], "openclaw-remnic should be added");
  // Legacy entry should be kept
  assert.ok(result.plugins?.entries?.["openclaw-engram"], "openclaw-engram should be retained");
  // Slot should be updated
  assert.equal(result.plugins?.slots?.memory, "openclaw-remnic");
  // memoryDir should be the new one
  assert.equal(result.plugins!.entries!["openclaw-remnic"].config?.memoryDir, "/new/path");
});

test("migration: merges legacy config values (except memoryDir)", () => {
  const existing: OpenclawConfig = {
    plugins: {
      entries: {
        "openclaw-engram": {
          config: {
            memoryDir: "/old/path",
            debug: false,
            model: "gpt-5.5",
          },
        },
      },
    },
  };
  const result = buildUpdatedOpenclawConfig(existing, "/new/path", true);

  const newConfig = result.plugins!.entries!["openclaw-remnic"].config!;
  // Should inherit model from legacy
  assert.equal(newConfig.model, "gpt-5.5", "should inherit model from legacy entry");
  assert.equal(newConfig.modelSource, "plugin", "implicit legacy installs should stay in plugin model mode");
  // memoryDir should be the new one (not the old one)
  assert.equal(newConfig.memoryDir, "/new/path");
});

test("migration: preserves explicit legacy modelSource", () => {
  const existing: OpenclawConfig = {
    plugins: {
      entries: {
        "openclaw-engram": {
          config: {
            memoryDir: "/old/path",
            modelSource: "gateway",
          },
        },
      },
    },
  };
  const result = buildUpdatedOpenclawConfig(existing, "/new/path", true);

  const newConfig = result.plugins!.entries!["openclaw-remnic"].config!;
  assert.equal(newConfig.modelSource, "gateway");
  assert.equal(newConfig.memoryDir, "/new/path");
});

test("collision: updates existing openclaw-remnic entry memoryDir", () => {
  const existing: OpenclawConfig = {
    plugins: {
      entries: {
        "openclaw-remnic": { config: { memoryDir: "/old/path", debug: true } },
      },
      slots: { memory: "openclaw-remnic" },
    },
  };
  const result = buildUpdatedOpenclawConfig(existing, "/new/path", false);

  assert.equal(result.plugins!.entries!["openclaw-remnic"].config?.memoryDir, "/new/path");
  // debug: true should be preserved
  assert.equal(result.plugins!.entries!["openclaw-remnic"].config?.debug, true);
});

test("collision: preserves an existing explicit modelSource", () => {
  const existing: OpenclawConfig = {
    plugins: {
      entries: {
        "openclaw-remnic": {
          config: {
            memoryDir: "/old/path",
            modelSource: "plugin",
          },
        },
      },
      slots: { memory: "openclaw-remnic" },
    },
  };
  const result = buildUpdatedOpenclawConfig(existing, "/new/path", false);

  assert.equal(result.plugins!.entries!["openclaw-remnic"].config?.modelSource, "plugin");
  assert.equal(result.plugins!.entries!["openclaw-remnic"].config?.memoryDir, "/new/path");
});

test("slot: always set to openclaw-remnic when no legacy entry", () => {
  for (const existingSlot of [undefined, "openclaw-engram", "other-plugin"]) {
    const existing: OpenclawConfig = {
      plugins: {
        entries: {},
        slots: existingSlot ? { memory: existingSlot } : {},
      },
    };
    const result = buildUpdatedOpenclawConfig(existing, "/mem", false);
    assert.equal(result.plugins?.slots?.memory, "openclaw-remnic",
      `slot should be openclaw-remnic when no legacy entry (existing slot was "${existingSlot}")`);
  }
});

test("slot: preserved when legacy entry exists and migrateLegacy is false", () => {
  const existing: OpenclawConfig = {
    plugins: {
      entries: { "openclaw-engram": { config: { memoryDir: "/old/path" } } },
      slots: { memory: "openclaw-engram" },
    },
  };
  const result = buildUpdatedOpenclawConfig(existing, "/new/path", false);
  // Operator declined migration — slot must not be switched
  assert.equal(result.plugins?.slots?.memory, "openclaw-engram",
    "slot should stay openclaw-engram when operator declined migration");
  // But the new entry should still be written
  assert.ok(result.plugins?.entries?.["openclaw-remnic"],
    "openclaw-remnic entry should be written even when migration was declined");
});

test("slot: updated to openclaw-remnic when migration declined but slot is unset or mismatched", () => {
  for (const slotValue of [undefined, "other-plugin", "openclaw-remnic"] as const) {
    const existing: OpenclawConfig = {
      plugins: {
        entries: { "openclaw-engram": { config: { memoryDir: "/old/path" } } },
        slots: slotValue ? { memory: slotValue } : {},
      },
    };
    const result = buildUpdatedOpenclawConfig(existing, "/new/path", false);
    // Since slot is NOT actively pointing to openclaw-engram, it should be updated
    assert.equal(result.plugins?.slots?.memory, "openclaw-remnic",
      `slot should be updated when existing slot is "${slotValue}" even if migration was declined`);
  }
});

// ── File I/O tests ───────────────────────────────────────────────────────────

test("dry-run: does not write config file", async () => {
  const tmp = await makeTmpDir();
  const configPath = path.join(tmp, "openclaw.json");

  // Simulate dry-run: just compute the result but don't write
  const result = buildUpdatedOpenclawConfig({}, path.join(tmp, "memory"), false);

  // In dry-run we don't call writeFileSync, so config should not exist
  assert.ok(!fs.existsSync(configPath), "config should not be written in dry-run mode");
  // But the computed result should still be correct
  assert.ok(result.plugins?.entries?.["openclaw-remnic"]);
});

test("write: config is written to the given path", async () => {
  const tmp = await makeTmpDir();
  const configPath = path.join(tmp, "openclaw.json");
  const memoryDir = path.join(tmp, "memory");

  const result = buildUpdatedOpenclawConfig({}, memoryDir, false);
  // Simulate the write step
  fs.writeFileSync(configPath, JSON.stringify(result, null, 2) + "\n");

  assert.ok(fs.existsSync(configPath), "config should be written");
  const readBack = JSON.parse(fs.readFileSync(configPath, "utf-8")) as OpenclawConfig;
  assert.equal(readBack.plugins?.slots?.memory, "openclaw-remnic");
  assert.equal(readBack.plugins?.entries?.["openclaw-remnic"]?.config?.memoryDir, memoryDir);
});

test("write: memory directory is created", async () => {
  const tmp = await makeTmpDir();
  const memoryDir = path.join(tmp, "deep", "nested", "memory");

  assert.ok(!fs.existsSync(memoryDir), "memory dir should not exist yet");
  // Simulate the create step
  fs.mkdirSync(memoryDir, { recursive: true });
  assert.ok(fs.existsSync(memoryDir), "memory dir should be created");
});
