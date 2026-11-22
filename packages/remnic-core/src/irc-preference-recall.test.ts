import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { StorageManager } from "./storage.js";
import type { PluginConfig } from "./types.js";

async function makeOrchestrator(
  overrides: Partial<PluginConfig> = {},
): Promise<{ orchestrator: Orchestrator; memoryDir: string }> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-irc-recall-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    multiGraphMemoryEnabled: false,
    entityGraphEnabled: false,
    timeGraphEnabled: false,
    causalGraphEnabled: false,
    extractionJudgeEnabled: false,
    contradictionDetectionEnabled: false,
    chunkingEnabled: false,
    extractionMinChars: 0,
    extractionMinImportanceLevel: "trivial",
    inlineSourceAttributionEnabled: false,
    initGateTimeoutMs: 200,
    ...overrides,
  });
  return { orchestrator: new Orchestrator(config), memoryDir };
}

test("recall injects the consolidated preference section when IRC is enabled", async () => {
  const { orchestrator, memoryDir } = await makeOrchestrator();
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    await storage.writeMemory(
      "preference",
      "The user prefers vim keybindings for editing code.",
      { source: "test", confidence: 0.9 },
    );
    const out = await orchestrator.recall(
      "what editor preferences does the user have",
      "sess-irc-on",
    );
    assert.ok(
      out.includes("## User Preferences (Consolidated)"),
      "IRC-enabled recall injects the consolidated preference section",
    );
    assert.ok(out.includes("vim keybindings"), "sanity: the preference statement is present");
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("recall omits the consolidated preference section when ircEnabled is off", async () => {
  const { orchestrator, memoryDir } = await makeOrchestrator({ ircEnabled: false });
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    await storage.writeMemory(
      "preference",
      "The user prefers vim keybindings for editing code.",
      { source: "test", confidence: 0.9 },
    );
    const out = await orchestrator.recall(
      "what editor preferences does the user have",
      "sess-irc-off",
    );
    assert.ok(
      !out.includes("## User Preferences (Consolidated)"),
      "ircEnabled=false keeps the consolidated preference section out of recall",
    );
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
