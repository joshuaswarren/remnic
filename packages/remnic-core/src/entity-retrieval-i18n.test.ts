import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import { parseConfig } from "./config.js";
import { normalizeEntityText } from "./entity-schema.js";
import { buildEntityRecallSection } from "./entity-retrieval.js";
import { detectNonEnglishEntityQueryMode } from "./entity-retrieval-i18n.js";
import { StorageManager } from "./storage.js";
import type { PluginConfig, TranscriptEntry } from "./types.js";

function dialogueTurn(content: string): TranscriptEntry[] {
  return [{
    timestamp: new Date().toISOString(),
    role: "user",
    content,
    sessionKey: "test-session",
    turnId: "test-turn-1",
  }];
}

function recallBase(
  config: PluginConfig,
  storage: StorageManager,
  transcriptEntries: TranscriptEntry[],
): Parameters<typeof buildEntityRecallSection>[0] {
  return {
    config,
    storage,
    query: "",
    recentTurns: 2,
    maxHints: 2,
    maxSupportingFacts: 2,
    maxRelatedEntities: 2,
    maxChars: 10_000,
    transcriptEntries,
  };
}

test("non-English follow-ups resolve the recently discussed entity like the English pronoun follow-up (#2193)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-i18n-"));
  try {
    const storage = new StorageManager(memoryDir);
    const entityRef = await storage.writeEntity("Alice", "person", []);
    await storage.writeMemory("fact", "Alice leads the platform launch review.", {
      source: "test",
      entityRef,
    });
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
    });
    const dialogue = dialogueTurn("I spoke with Alice about the launch review yesterday.");

    // English pronoun follow-up and its Japanese/Chinese equivalents must
    // resolve to the same recently-discussed entity.
    for (const query of ["What about her?", "それで、どうなった？", "彼はどうなった？", "然后呢？"]) {
      const section = await buildEntityRecallSection({
        ...recallBase(config, storage, dialogue),
        query,
      });
      assert.ok(section, `expected an entity hint section for query: ${query}`);
      assert.match(section, /alice/i);
    }

    // Without recent dialogue both decline identically — no entity to carry.
    for (const query of ["What about him?", "それで、どうなった？"]) {
      const section = await buildEntityRecallSection({
        ...recallBase(config, storage, []),
        query,
      });
      assert.equal(section, null, `expected no entity section without dialogue: ${query}`);
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("zero-pronoun Japanese follow-up retrieves a CJK entity from a particle-bound mention (#2193)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-i18n-cjk-"));
  try {
    const storage = new StorageManager(memoryDir);
    const entityRef = await storage.writeEntity("田中", "person", []);
    await storage.writeMemory("fact", "田中は来週の発表を準備している。", {
      source: "test",
      entityRef,
    });
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
    });

    for (const query of ["それで、どうなった？", "彼女はどうなった？"]) {
      const section = await buildEntityRecallSection({
        ...recallBase(config, storage, dialogueTurn("田中とは昨日打ち合わせをした。")),
        query,
      });
      assert.ok(section, `expected an entity hint section for query: ${query}`);
      assert.match(section, /田中/);
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("non-English query-mode cue table classification (#2193)", () => {
  assert.equal(detectNonEnglishEntityQueryMode(normalizeEntityText("彼はどうなった")), "follow_up");
  assert.equal(detectNonEnglishEntityQueryMode(normalizeEntityText("¿y ella?")), "follow_up");
  assert.equal(detectNonEnglishEntityQueryMode(normalizeEntityText("田中さんの最近の状況")), "timeline");
  assert.equal(detectNonEnglishEntityQueryMode(normalizeEntityText("了解しました")), null);
});
