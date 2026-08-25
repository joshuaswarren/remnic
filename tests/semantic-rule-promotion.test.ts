import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { StorageManager } from "@remnic/core/storage";
import {
  promoteSemanticRuleFromMemory,
  type SemanticRulePromotionReport,
} from "@remnic/core/semantic-rule-promotion";
import { runSemanticRulePromoteCliCommand } from "@remnic/core/cli";

async function createStore() {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-semantic-rule-"));
  const storage = new StorageManager(memoryDir);
  return { memoryDir, storage };
}

async function readMemory(storage: StorageManager, memoryId: string) {
  const memory = await storage.getMemoryById(memoryId);
  assert.ok(memory, `expected memory ${memoryId} to exist`);
  return memory;
}

function promotedRule(report: SemanticRulePromotionReport) {
  assert.equal(report.promoted.length, 1);
  return report.promoted[0]!;
}

test("promoteSemanticRuleFromMemory dry-run extracts normalized rule from verified episode", async () => {
  const { memoryDir, storage } = await createStore();
  const { id: sourceMemoryId } = await storage.writeMemory(
    "fact",
    "IF Cursor Bugbot is still pending THEN wait for the terminal result before merging.",
    {
      source: "test",
      tags: ["pr-loop", "cursor"],
      confidence: 0.91,
      memoryKind: "episode",
    },
  );

  const report = await promoteSemanticRuleFromMemory({
    memoryDir,
    enabled: true,
    sourceMemoryId,
    dryRun: true,
  });

  const candidate = promotedRule(report);
  assert.equal(candidate.content, "IF Cursor Bugbot is still pending THEN wait for the terminal result before merging.");
  assert.equal(candidate.memoryKind, "note");
  assert.deepEqual(candidate.lineage, [sourceMemoryId]);
  assert.match(candidate.tags.join(" "), /semantic-rule/);

  const allMemories = await storage.readAllMemories();
  assert.equal(allMemories.filter((memory) => memory.frontmatter.category === "rule").length, 0);
});

test("promoteSemanticRuleFromMemory writes a rule memory with lineage and support link", async () => {
  const { memoryDir, storage } = await createStore();
  const { id: sourceMemoryId } = await storage.writeMemory(
    "fact",
    "If the default namespace storage diverges, then verified recall must still use the configured memory root.",
    {
      source: "test",
      tags: ["namespaces", "verified-recall"],
      confidence: 0.88,
      memoryKind: "episode",
    },
  );

  const report = await promoteSemanticRuleFromMemory({
    memoryDir,
    enabled: true,
    sourceMemoryId,
  });

  const promoted = promotedRule(report);
  const memory = await readMemory(storage, promoted.id);
  assert.equal(memory.frontmatter.category, "rule");
  assert.equal(memory.frontmatter.source, "semantic-rule-promotion");
  assert.equal(memory.frontmatter.memoryKind, "note");
  assert.deepEqual(memory.frontmatter.lineage, [sourceMemoryId]);
  assert.equal(memory.frontmatter.sourceMemoryId, sourceMemoryId);
  assert.equal(memory.frontmatter.links?.[0]?.targetId, sourceMemoryId);
  assert.equal(memory.frontmatter.links?.[0]?.linkType, "supports");
  assert.equal(memory.content, "IF the default namespace storage diverges THEN verified recall must still use the configured memory root.");
});

test("promoteSemanticRuleFromMemory skips non-episodic memories and duplicate promoted rules", async () => {
  const { memoryDir, storage } = await createStore();
  const { id: noteMemoryId } = await storage.writeMemory(
    "decision",
    "IF the rollout is risky THEN keep it behind a feature flag.",
    {
      source: "test",
      tags: ["release"],
      confidence: 0.8,
      memoryKind: "note",
    },
  );

  const skipped = await promoteSemanticRuleFromMemory({
    memoryDir,
    enabled: true,
    sourceMemoryId: noteMemoryId,
  });
  assert.equal(skipped.promoted.length, 0);
  assert.equal(skipped.skipped[0]?.reason, "source-memory-not-episode");

  const { id: sourceEpisodeId } = await storage.writeMemory(
    "fact",
    "IF the rollout is risky THEN keep it behind a feature flag.",
    {
      source: "test",
      tags: ["release"],
      confidence: 0.87,
      memoryKind: "episode",
    },
  );

  const first = await promoteSemanticRuleFromMemory({
    memoryDir,
    enabled: true,
    sourceMemoryId: sourceEpisodeId,
  });
  assert.equal(first.promoted.length, 1);

  const second = await promoteSemanticRuleFromMemory({
    memoryDir,
    enabled: true,
    sourceMemoryId: sourceEpisodeId,
  });
  assert.equal(second.promoted.length, 0);
  assert.equal(second.skipped[0]?.reason, "duplicate-rule");
});

test("promoteSemanticRuleFromMemory reports forgotten episode sources distinctly", async () => {
  const { memoryDir, storage } = await createStore();
  const { id: sourceEpisodeId } = await storage.writeMemory(
    "fact",
    "IF a memory has been forgotten THEN keep it out of promoted rules.",
    {
      source: "test",
      tags: ["retention"],
      confidence: 0.87,
      memoryKind: "episode",
    },
  );
  const sourceMemory = await storage.getMemoryById(sourceEpisodeId);
  assert.ok(sourceMemory);
  await storage.writeMemoryFrontmatter(sourceMemory, {
    status: "forgotten",
    forgottenAt: "2026-04-25T12:00:00.000Z",
  });

  const report = await promoteSemanticRuleFromMemory({
    memoryDir,
    enabled: true,
    sourceMemoryId: sourceEpisodeId,
  });

  assert.equal(report.promoted.length, 0);
  assert.equal(report.skipped[0]?.reason, "source-memory-forgotten");
});

test("promoteSemanticRuleFromMemory strips trailing punctuation from THEN outcomes before duplicate checks", async () => {
  const { memoryDir, storage } = await createStore();
  const { id: firstEpisodeId } = await storage.writeMemory(
    "fact",
    "IF deployment drift is detected THEN rollback immediately,",
    {
      source: "test",
      tags: ["deployments"],
      confidence: 0.89,
      memoryKind: "episode",
    },
  );

  const first = await promoteSemanticRuleFromMemory({
    memoryDir,
    enabled: true,
    sourceMemoryId: firstEpisodeId,
  });
  assert.equal(first.promoted.length, 1);
  assert.equal(first.promoted[0]?.content, "IF deployment drift is detected THEN rollback immediately.");

  const { id: secondEpisodeId } = await storage.writeMemory(
    "fact",
    "IF deployment drift is detected THEN rollback immediately.",
    {
      source: "test",
      tags: ["deployments"],
      confidence: 0.89,
      memoryKind: "episode",
    },
  );

  const second = await promoteSemanticRuleFromMemory({
    memoryDir,
    enabled: true,
    sourceMemoryId: secondEpisodeId,
  });
  assert.equal(second.promoted.length, 0);
  assert.equal(second.skipped[0]?.reason, "duplicate-rule");
});

test("promoteSemanticRuleFromMemory dedupes against existing rule memories with different case and punctuation", async () => {
  const { memoryDir, storage } = await createStore();
  const { id: existingRuleId } = await storage.writeMemory(
    "rule",
    "If the build fails, then revert.",
    {
      source: "test",
      tags: ["builds"],
      confidence: 0.9,
      memoryKind: "note",
    },
  );
  const existingRule = await storage.getMemoryById(existingRuleId);
  assert.ok(existingRule);
  await storage.writeMemoryFrontmatter(existingRule, { status: "superseded" });

  const { id: sourceEpisodeId } = await storage.writeMemory(
    "fact",
    "IF the build fails THEN revert",
    {
      source: "test",
      tags: ["builds"],
      confidence: 0.9,
      memoryKind: "episode",
    },
  );

  const report = await promoteSemanticRuleFromMemory({
    memoryDir,
    enabled: true,
    sourceMemoryId: sourceEpisodeId,
  });

  assert.equal(report.promoted.length, 0);
  assert.equal(report.skipped[0]?.reason, "duplicate-rule");
  assert.equal(report.skipped[0]?.existingRuleId, existingRuleId);
});

test("promoteSemanticRuleFromMemory dedupes against existing rule memories with different body-text casing", async () => {
  const { memoryDir, storage } = await createStore();
  const { id: existingRuleId } = await storage.writeMemory(
    "rule",
    "IF The Build Fails THEN Revert.",
    {
      source: "test",
      tags: ["builds"],
      confidence: 0.9,
      memoryKind: "note",
    },
  );

  const { id: sourceEpisodeId } = await storage.writeMemory(
    "fact",
    "if the build fails then revert",
    {
      source: "test",
      tags: ["builds"],
      confidence: 0.9,
      memoryKind: "episode",
    },
  );

  const report = await promoteSemanticRuleFromMemory({
    memoryDir,
    enabled: true,
    sourceMemoryId: sourceEpisodeId,
  });

  assert.equal(report.promoted.length, 0);
  assert.equal(report.skipped[0]?.reason, "duplicate-rule");
  assert.equal(report.skipped[0]?.existingRuleId, existingRuleId);
});

test("semantic-rule-promote CLI command honors the feature flag", async () => {
  const { memoryDir, storage } = await createStore();
  const { id: sourceMemoryId } = await storage.writeMemory(
    "fact",
    "IF a review thread is unresolved THEN rerun the stale thread check before merging.",
    {
      source: "test",
      tags: ["reviews"],
      confidence: 0.9,
      memoryKind: "episode",
    },
  );

  const disabled = await runSemanticRulePromoteCliCommand({
    memoryDir,
    semanticRulePromotionEnabled: false,
    sourceMemoryId,
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.promoted.length, 0);

  const enabled = await runSemanticRulePromoteCliCommand({
    memoryDir,
    semanticRulePromotionEnabled: true,
    sourceMemoryId,
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.promoted.length, 1);
  assert.match(enabled.promoted[0]?.content ?? "", /^IF /);
});
