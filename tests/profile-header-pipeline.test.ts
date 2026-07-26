import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { ExtractionResult } from "../src/types.js";

const WRITE_TIME = "2030-01-02T03:04:05.000Z";
const STALE_HEADER = "*Last updated: 2024-01-02T03:04:05.000Z*";
const FRESH_HEADER = `*Last updated: ${WRITE_TIME}*`;

function makeConfig(memoryDir: string) {
  return parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    chunkingEnabled: false,
    topicExtractionEnabled: false,
    summarizationEnabled: false,
    identityEnabled: false,
    entitySummaryEnabled: false,
    semanticConsolidationEnabled: false,
    factArchivalEnabled: false,
    lifecyclePolicyEnabled: false,
  });
}

async function seedStaleProfile(memoryDir: string): Promise<void> {
  await writeFile(
    path.join(memoryDir, "profile.md"),
    [
      "# Behavioral Profile",
      "",
      STALE_HEADER,
      "",
      "- Existing profile note.",
      "",
    ].join("\n"),
    "utf8",
  );
}

test("extraction persistence refreshes profile.md before appending profile updates", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-profile-extraction-"));
  try {
    const orchestrator = new Orchestrator(makeConfig(memoryDir));
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();
    await seedStaleProfile(memoryDir);

    const result: ExtractionResult = {
      facts: [],
      entities: [],
      relationships: [],
      questions: [],
      profileUpdates: ["Prefers concise updates."],
    } as ExtractionResult;

    await orchestrator.persistExtraction(
      result,
      storage,
      null,
      { sessionKey: "profile-extraction", principal: "test" },
    );

    assert.equal(
      await readFile(path.join(memoryDir, "profile.md"), "utf8"),
      [
        "# Behavioral Profile",
        "",
        FRESH_HEADER,
        "",
        "- Existing profile note.",
        "- Prefers concise updates.",
        "",
      ].join("\n"),
    );
  } finally {
    t.mock.timers.reset();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("smart consolidation refreshes profile.md before appending consolidated updates", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-profile-consolidation-"));
  try {
    const orchestrator = new Orchestrator(makeConfig(memoryDir));
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();
    await seedStaleProfile(memoryDir);

    for (let index = 0; index < 5; index += 1) {
      await storage.writeMemory("fact", `seed fact ${index}`, { source: "test" });
    }
    Object.defineProperty(orchestrator, "extraction", {
      configurable: true,
      value: {
        consolidate: async () => ({
          items: [],
          profileUpdates: ["Prefers consolidated updates."],
          entityUpdates: [],
        }),
      },
    });

    const stats = await orchestrator.runConsolidationNow();

    assert.equal(stats.memoriesProcessed, 5);
    assert.equal(
      await readFile(path.join(memoryDir, "profile.md"), "utf8"),
      [
        "# Behavioral Profile",
        "",
        FRESH_HEADER,
        "",
        "- Existing profile note.",
        "- Prefers consolidated updates.",
        "",
      ].join("\n"),
    );
  } finally {
    t.mock.timers.reset();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
