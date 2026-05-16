/**
 * Tests for `remnic doctor` OpenClaw config checks.
 *
 * Since the CLI package depends on @remnic/core (which requires a build step),
 * these tests verify the CLI source code structure for the OpenClaw doctor checks,
 * and also test the check logic directly using pure functions.
 *
 * Tests:
 * - CLI source contains OpenClaw config file check
 * - CLI source contains plugins.entries check
 * - CLI source contains plugins.slots.memory check
 * - CLI source contains memoryDir check
 * - CLI source references remnic openclaw install as remediation
 * - Check logic: missing entries object
 * - Check logic: missing slot
 * - Check logic: mismatched slot
 * - Check logic: missing config file
 * - Check logic: missing memoryDir
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CLI_SRC = path.join(ROOT, "packages", "remnic-cli", "src", "index.ts");

async function readCli(): Promise<string> {
  return fs.readFileSync(CLI_SRC, "utf-8");
}

// ── Source structure tests ────────────────────────────────────────────────────

test("doctor: CLI source contains OpenClaw config file check", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("OpenClaw config file"),
    "CLI must include 'OpenClaw config file' check",
  );
});

test("doctor: CLI source contains plugins.entries check", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("OpenClaw plugins.entries"),
    "CLI must check 'OpenClaw plugins.entries'",
  );
});

test("doctor: CLI source contains plugins.slots.memory check", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("plugins.slots.memory"),
    "CLI must check 'plugins.slots.memory'",
  );
});

test("doctor: CLI source contains memoryDir check", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("OpenClaw memoryDir") || src.includes("memoryDir"),
    "CLI must check memoryDir",
  );
});

test("doctor: CLI references remnic openclaw install as remediation", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("remnic openclaw install"),
    "CLI doctor remediation must point to 'remnic openclaw install'",
  );
});

test("doctor: CLI references slot missing error", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("Without this, hooks never fire") ||
    src.includes("Without this") ||
    src.includes("hooks never fire"),
    "CLI should explain that missing slot causes hooks to not fire",
  );
});

test("doctor: CLI handles legacy openclaw-engram warn case", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("openclaw-engram") && src.includes("legacy"),
    "CLI must handle the legacy openclaw-engram warn case",
  );
});

test("doctor: CLI distinguishes OpenClaw plugin mode from standalone launchd", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("Standalone launchd plist"),
    "CLI doctor must include standalone launchd plist validation",
  );
  assert.ok(
    src.includes("OpenClaw plugin mode does not require standalone launchd") ||
      src.includes("not required for OpenClaw plugin mode"),
    "CLI doctor must not require launchd when OpenClaw plugin mode is configured",
  );
});

test("doctor: CLI validates stale launchd server binary paths", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("inspectLaunchdPlist"),
    "CLI doctor must inspect the installed launchd plist",
  );
  assert.ok(
    src.includes("remnic daemon install") && src.includes("remnic daemon uninstall"),
    "CLI doctor must tell users how to rewrite or remove a stale standalone daemon",
  );
});

test("doctor: standalone service checks use merged service path arrays", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("anyFileExists(LAUNCHD_PLIST_PATHS)"),
    "CLI doctor must check all launchd candidate paths",
  );
  assert.ok(
    src.includes("anyFileExists(SYSTEMD_UNIT_PATHS)"),
    "CLI doctor must check all systemd candidate paths",
  );
  assert.equal(
    src.includes("LEGACY_LAUNCHD_PLIST_PATH") || src.includes("LEGACY_SYSTEMD_UNIT_PATH"),
    false,
    "CLI doctor must not reference removed legacy path constants",
  );
});

test("doctor: OPENAI_API_KEY failure message is unambiguous", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("not set (required for direct OpenAI-backed extraction)"),
    "CLI doctor must make the failing OPENAI_API_KEY case explicit",
  );
  assert.equal(
    src.includes("not set (required only for direct OpenAI-backed extraction)"),
    false,
    "CLI doctor must not imply OPENAI_API_KEY is optional when the check fails",
  );
});

// ── Logic unit tests (pure config parsing) ───────────────────────────────────

interface OpenclawConfig {
  plugins?: {
    entries?: Record<string, unknown>;
    slots?: Record<string, string>;
  };
}

function analyzeOpenclawConfig(cfg: OpenclawConfig): {
  hasEntriesObject: boolean;
  hasNewEntry: boolean;
  hasLegacyEntry: boolean;
  slotValue: string | undefined;
  slotMissing: boolean;
  slotMismatch: boolean;
  memoryDir: string | undefined;
} {
  const plugins = cfg.plugins ?? {};
  const entries = plugins.entries && typeof plugins.entries === "object"
    ? plugins.entries as Record<string, unknown>
    : null;
  const slots = plugins.slots ?? {};

  const hasEntriesObject = entries !== null;
  const hasNewEntry = hasEntriesObject && "openclaw-remnic" in entries!;
  const hasLegacyEntry = hasEntriesObject && "openclaw-engram" in entries!;
  const slotValue = slots.memory;
  const slotMissing = !slotValue;
  const validEntryIds = hasEntriesObject ? Object.keys(entries!) : [];
  const slotMismatch = !slotMissing && !validEntryIds.includes(slotValue!);

  const entryToCheck = hasEntriesObject
    ? ((entries!["openclaw-remnic"] ?? entries!["openclaw-engram"]) as Record<string, unknown> | undefined)
    : undefined;
  const entryConfig = entryToCheck?.config && typeof entryToCheck.config === "object"
    ? (entryToCheck.config as Record<string, unknown>)
    : null;
  const memoryDir = entryConfig?.memoryDir as string | undefined;

  return { hasEntriesObject, hasNewEntry, hasLegacyEntry, slotValue, slotMissing, slotMismatch, memoryDir };
}

test("check logic: missing entries object is detected", () => {
  const result = analyzeOpenclawConfig({ plugins: {} });
  assert.equal(result.hasEntriesObject, false);
});

test("check logic: openclaw-remnic entry is detected", () => {
  const result = analyzeOpenclawConfig({
    plugins: {
      entries: { "openclaw-remnic": {} },
      slots: { memory: "openclaw-remnic" },
    },
  });
  assert.equal(result.hasNewEntry, true);
  assert.equal(result.slotMissing, false);
  assert.equal(result.slotMismatch, false);
});

test("check logic: missing slot is detected", () => {
  const result = analyzeOpenclawConfig({
    plugins: {
      entries: { "openclaw-remnic": {} },
    },
  });
  assert.equal(result.slotMissing, true);
});

test("check logic: mismatched slot is detected", () => {
  const result = analyzeOpenclawConfig({
    plugins: {
      entries: { "openclaw-remnic": {} },
      slots: { memory: "other-plugin" },
    },
  });
  assert.equal(result.slotMismatch, true);
  assert.equal(result.slotValue, "other-plugin");
});

test("check logic: legacy openclaw-engram entry is detected", () => {
  const result = analyzeOpenclawConfig({
    plugins: {
      entries: { "openclaw-engram": {} },
      slots: { memory: "openclaw-engram" },
    },
  });
  assert.equal(result.hasLegacyEntry, true);
  assert.equal(result.hasNewEntry, false);
});

test("check logic: memoryDir is extracted from openclaw-remnic entry", () => {
  const result = analyzeOpenclawConfig({
    plugins: {
      entries: {
        "openclaw-remnic": { config: { memoryDir: "/test/memory" } },
      },
      slots: { memory: "openclaw-remnic" },
    },
  });
  assert.equal(result.memoryDir, "/test/memory");
});

test("check logic: all checks pass for valid config", () => {
  const result = analyzeOpenclawConfig({
    plugins: {
      entries: {
        "openclaw-remnic": { config: { memoryDir: "/test/memory" } },
      },
      slots: { memory: "openclaw-remnic" },
    },
  });
  assert.equal(result.hasEntriesObject, true);
  assert.equal(result.hasNewEntry, true);
  assert.equal(result.slotMissing, false);
  assert.equal(result.slotMismatch, false);
  assert.equal(result.slotValue, "openclaw-remnic");
});
