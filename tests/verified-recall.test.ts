import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir } from "node:fs/promises";
import { BoxBuilder } from "@remnic/core/boxes";
import { parseConfig } from "@remnic/core/config";
import { Orchestrator } from "@remnic/core/orchestrator";
import { StorageManager } from "@remnic/core/storage";
import { runVerifiedRecallSearchCliCommand } from "@remnic/core/cli";
import { searchVerifiedEpisodes } from "@remnic/core/verified-recall";

async function seedVerifiedRecallStore(memoryDir: string) {
  const storage = new StorageManager(memoryDir);
  const { id: episodeId } = await storage.writeMemory("fact", "Merged the PR after Cursor turned green.", {
    source: "test",
    tags: ["pr-loop", "cursor"],
    memoryKind: "episode",
  });
  const { id: noteId } = await storage.writeMemory("decision", "Always wait for terminal review state before merge.", {
    source: "test",
    tags: ["policy"],
    memoryKind: "note",
  });

  const builder = new BoxBuilder(memoryDir, {
    memoryBoxesEnabled: true,
    traceWeaverEnabled: false,
    boxTopicShiftThreshold: 0.3,
    boxTimeGapMs: 60 * 60 * 1000,
    boxMaxMemories: 100,
    traceWeaverLookbackDays: 7,
    traceWeaverOverlapThreshold: 0.4,
  });

  await builder.onExtraction({
    topics: ["pr-loop", "cursor", "merge"],
    memoryIds: [episodeId, noteId],
    timestamp: "2026-03-07T23:45:00.000Z",
    goal: "Merge the PR after review is truly complete",
    toolsUsed: ["gh", "cursor"],
  });
  await builder.sealCurrent("forced");

  return { episodeId, noteId };
}

async function buildVerifiedRecallHarness(enabled: boolean, recallSectionEnabled: boolean = true) {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-verified-recall-"));
  await seedVerifiedRecallStore(memoryDir);

  const cfg = parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir,
    qmdEnabled: false,
    transcriptEnabled: false,
    sharedContextEnabled: false,
    conversationIndexEnabled: false,
    hourlySummariesEnabled: false,
    injectQuestions: false,
    memoryBoxesEnabled: true,
    boxRecallDays: 7,
    verifiedRecallEnabled: enabled,
    recallPipeline: [
      {
        id: "verified-episodes",
        enabled: recallSectionEnabled,
        maxResults: 3,
        maxChars: 1800,
      },
    ],
  });

  return { memoryDir, orchestrator: new Orchestrator(cfg) };
}

test("searchVerifiedEpisodes returns only boxes with verified episodic support", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-verified-search-"));
  const { episodeId, noteId } = await seedVerifiedRecallStore(memoryDir);

  const results = await searchVerifiedEpisodes({
    memoryDir,
    query: "Which episode says we merged after Cursor turned green?",
    maxResults: 3,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.verifiedEpisodeCount, 1);
  assert.deepEqual(results[0]?.verifiedMemoryIds, [episodeId]);
  assert.equal(results[0]?.verifiedMemoryIds.includes(noteId), false);
});

test("searchVerifiedEpisodes skips boxes whose cited memories are not verified episodes", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-verified-filter-"));
  const storage = new StorageManager(memoryDir);
  const { id: noteId } = await storage.writeMemory("decision", "Wait for Cursor before merge.", {
    source: "test",
    memoryKind: "note",
  });
  const builder = new BoxBuilder(memoryDir, {
    memoryBoxesEnabled: true,
    traceWeaverEnabled: false,
    boxTopicShiftThreshold: 0.3,
    boxTimeGapMs: 60 * 60 * 1000,
    boxMaxMemories: 100,
    traceWeaverLookbackDays: 7,
    traceWeaverOverlapThreshold: 0.4,
  });
  await builder.onExtraction({
    topics: ["cursor", "merge"],
    memoryIds: [noteId, "missing-memory-id"],
    timestamp: "2026-03-07T23:46:00.000Z",
    goal: "Document merge policy",
  });
  await builder.sealCurrent("forced");

  const results = await searchVerifiedEpisodes({
    memoryDir,
    query: "Which episode says wait for Cursor before merge?",
    maxResults: 3,
  });

  assert.deepEqual(results, []);
});

test("searchVerifiedEpisodes reads the memory corpus once per search", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-verified-corpus-"));
  await seedVerifiedRecallStore(memoryDir);
  await seedVerifiedRecallStore(memoryDir);

  const originalReadAllMemories = StorageManager.prototype.readAllMemories;
  let readAllCount = 0;
  StorageManager.prototype.readAllMemories = async function patchedReadAllMemories(this: StorageManager) {
    readAllCount += 1;
    return originalReadAllMemories.call(this);
  };

  try {
    const results = await searchVerifiedEpisodes({
      memoryDir,
      query: "Which episode says we merged after Cursor turned green?",
      maxResults: 5,
    });

    assert.equal(results.length > 0, true);
    assert.equal(readAllCount, 1);
  } finally {
    StorageManager.prototype.readAllMemories = originalReadAllMemories;
  }
});

test("verified-recall-search CLI command returns verified episodic matches", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-verified-cli-"));
  await seedVerifiedRecallStore(memoryDir);

  const results = await runVerifiedRecallSearchCliCommand({
    memoryDir,
    verifiedRecallEnabled: true,
    query: "Find the verified episode about merging after Cursor turned green",
    maxResults: 2,
  });

  assert.equal(results.length, 1);
  assert.equal((results[0]?.matchedFields ?? []).length > 0, true);
  assert.equal((results[0]?.verifiedEpisodeCount ?? 0) > 0, true);
});

test("recall injects verified episodes when the feature is enabled", async () => {
  const { orchestrator } = await buildVerifiedRecallHarness(true);

  const context = await (orchestrator as any).recallInternal(
    "Which episode says we merged the PR after Cursor turned green?",
    "agent:main",
  );

  assert.match(context, /## Verified Episodes/);
  assert.match(context, /Merge the PR after review is truly complete/i);
  assert.match(context, /verified episodes: 1/i);
});

test("recall verified episodes use the configured memory root even when default namespace storage is redirected", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-verified-namespace-"));
  // When namespaces are enabled and the namespace directory exists, the storage
  // router resolves the default namespace to the namespace subdirectory.
  // Seed the store in that subdirectory so verified episodes are found.
  const nsDir = path.join(memoryDir, "namespaces", "default");
  await mkdir(nsDir, { recursive: true });
  await seedVerifiedRecallStore(nsDir);

  const cfg = parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir,
    qmdEnabled: false,
    transcriptEnabled: false,
    sharedContextEnabled: false,
    conversationIndexEnabled: false,
    hourlySummariesEnabled: false,
    injectQuestions: false,
    memoryBoxesEnabled: true,
    boxRecallDays: 7,
    verifiedRecallEnabled: true,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    recallPipeline: [
      {
        id: "verified-episodes",
        enabled: true,
        maxResults: 3,
        maxChars: 1800,
      },
    ],
  });

  const orchestrator = new Orchestrator(cfg);
  const context = await (orchestrator as any).recallInternal(
    "Which episode says we merged the PR after Cursor turned green?",
    "agent:main:discord:channel:123",
  );

  assert.match(context, /## Verified Episodes/);
  assert.match(context, /Merge the PR after review is truly complete/i);
});

test("recall omits verified episodes when the feature flag is disabled", async () => {
  const { orchestrator } = await buildVerifiedRecallHarness(false);

  const context = await (orchestrator as any).recallInternal(
    "Which episode says we merged the PR after Cursor turned green?",
    "agent:main",
  );

  assert.equal(context.includes("## Verified Episodes"), false);
});

test("recall omits verified episodes when the pipeline section is disabled", async () => {
  const { orchestrator } = await buildVerifiedRecallHarness(true, false);

  const context = await (orchestrator as any).recallInternal(
    "Which episode says we merged the PR after Cursor turned green?",
    "agent:main",
  );

  assert.equal(context.includes("## Verified Episodes"), false);
});
