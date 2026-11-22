import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { StorageManager } from "@remnic/core/storage";
import { parseConfig } from "@remnic/core/config";
import { buildEntityRecallSection } from "@remnic/core/entity-retrieval";
import {
  dropEntityMentionIndexCache,
  entityMentionFullRebuildsStarted,
  entityMentionIndexScopeKeys,
  settleEntityMentionIndex,
} from "../packages/remnic-core/src/entity-mention-index-cache.js";
import type { PluginConfig } from "@remnic/core/types";

/**
 * Issue #3529: a warm second recall with the same scope, limits and corpus
 * must reuse both full indexes instead of rebuilding them. Recall's call
 * shape (orchestration/recall-internal.ts) always passes explicit
 * maxEntities/maxChars, which the knowledge-index cache used to treat as a
 * bypass; the entity mention index already reuses by scope identity.
 */

async function buildHarness(prefix: string): Promise<{ memoryDir: string; workspaceDir: string; config: PluginConfig; storage: StorageManager }> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-memory-`));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-workspace-`));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir,
    qmdEnabled: false,
    sharedContextEnabled: false,
    hourlySummariesEnabled: false,
    transcriptEnabled: true,
    nativeKnowledge: {
      enabled: false,
      includeFiles: ["IDENTITY.md", "MEMORY.md", "USER.md"],
      maxChunkChars: 400,
      maxResults: 5,
      maxChars: 1600,
      stateDir: "state/native-knowledge",
      obsidianVaults: [],
    },
    knowledgeIndexEnabled: true,
    knowledgeIndexMaxEntities: 50,
    knowledgeIndexMaxChars: 8000,
  });
  const storage = new StorageManager(memoryDir, config.entitySchemas);
  await storage.ensureDirectories();
  return { memoryDir, workspaceDir, config, storage };
}

// Recall's call shape: explicit, stable per-scope limits (recall-internal.ts
// knowledgeIndexOptions). Same values on both calls, same corpus, inside the
// 10-minute reuse window.
const RECALL_LIMITS = { maxEntities: 50, maxChars: 8000 };

test("warm second recall reuses the knowledge index instead of rebuilding the corpus table", async () => {
  const { memoryDir, workspaceDir, config, storage } = await buildHarness("engram-ki-warm");
  try {
    await storage.writeEntity("Alice", "person", ["A1", "A2", "A3"]);
    await storage.writeEntity("Acme Corp", "company", ["C1", "C2"]);

    // Make the full-corpus read observable: selfDeps forwards live to the
    // manager, so an instance stub is what the entity store calls.
    let corpusReads = 0;
    const realReadAllEntityFiles = storage.readAllEntityFiles.bind(storage);
    storage.readAllEntityFiles = async (...args) => {
      corpusReads += 1;
      return realReadAllEntityFiles(...args);
    };

    const first = await storage.buildKnowledgeIndex(config, RECALL_LIMITS);
    assert.equal(first.cached, false);
    assert.match(first.result, /## Knowledge Index/);
    assert.equal(corpusReads, 1);

    const second = await storage.buildKnowledgeIndex(config, RECALL_LIMITS);
    assert.equal(second.cached, true, "warm repeat must hit the cache, not rebuild");
    assert.equal(second.result, first.result, "warm repeat must return the equivalent index section");
    assert.equal(corpusReads, 1, "warm repeat must not re-read the entity corpus");

    // Different limits are a different key: rebuild, and never leak the other
    // limit's rows.
    const narrower = await storage.buildKnowledgeIndex(config, { maxEntities: 1, maxChars: RECALL_LIMITS.maxChars });
    assert.equal(narrower.cached, false);
    assert.equal(corpusReads, 2);
    const rows = narrower.result.split("\n").filter((line) => line.startsWith("| ") && !line.includes("Entity | Type"));
    assert.equal(rows.length, 1);

    // A real entity mutation still invalidates: the next build re-reads.
    await storage.writeEntity("Bob", "person", ["B1"]);
    const afterMutation = await storage.buildKnowledgeIndex(config, RECALL_LIMITS);
    assert.equal(afterMutation.cached, false);
    assert.equal(corpusReads, 3);
    assert.match(afterMutation.result, /\| Bob \|/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("warm second recall reuses the entity mention index instead of rescanning the corpus", async () => {
  const { memoryDir, workspaceDir, config, storage } = await buildHarness("engram-mention-warm");
  try {
    await storage.writeEntity("Alice", "person", ["Alice keeps the lab notes."]);
    await storage.writeMemory("fact", "Alice filed the calibration report.", { entityRef: "Alice", confidence: 0.9 });

    const buildSection = () =>
      buildEntityRecallSection({
        config,
        storage,
        query: "Who is Alice?",
        recentTurns: 6,
        maxHints: 2,
        maxSupportingFacts: 6,
        maxRelatedEntities: 3,
        maxChars: 2400,
        transcriptEntries: [],
      });

    const first = await buildSection();
    assert.ok(first, "first recall must resolve the mention");
    await settleEntityMentionIndex().catch(() => undefined);

    const scopeKeys = entityMentionIndexScopeKeys();
    assert.equal(scopeKeys.length, 1);
    const rebuildsAfterFirst = entityMentionFullRebuildsStarted(scopeKeys[0]);
    assert.ok(rebuildsAfterFirst >= 1, "first recall builds the mention index once");

    const second = await buildSection();
    assert.ok(second);

    const rebuildsAfterSecond = entityMentionFullRebuildsStarted(scopeKeys[0]);
    assert.equal(
      rebuildsAfterSecond,
      rebuildsAfterFirst,
      "warm repeat must not start another full corpus rebuild for the same scope",
    );
    assert.match(second, /## entity_answer_hints/);
  } finally {
    await settleEntityMentionIndex().catch(() => undefined);
    dropEntityMentionIndexCache();
    await rm(memoryDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
