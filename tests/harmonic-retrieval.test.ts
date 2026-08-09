import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { StorageManager } from "../src/storage.js";
import { recordAbstractionNode } from "../src/abstraction-nodes.js";
import { recordCueAnchor } from "../src/cue-anchors.js";
import { runHarmonicSearchCliCommand } from "../src/cli.js";
import { searchHarmonicRetrieval } from "../src/harmonic-retrieval.js";

async function seedHarmonicStore(memoryDir: string) {
  await recordAbstractionNode({
    memoryDir,
    node: {
      schemaVersion: 1,
      nodeId: "abstraction-pr-loop",
      recordedAt: "2026-03-07T23:30:00.000Z",
      sessionKey: "agent:main",
      kind: "workflow",
      abstractionLevel: "meso",
      title: "PR loop recovery workflow",
      summary: "Explains that PRs stay live until Cursor is terminal and review threads are resolved.",
      tags: ["pr-loop", "cursor"],
      entityRefs: ["project:openclaw-engram"],
    },
  });

  await recordAbstractionNode({
    memoryDir,
    node: {
      schemaVersion: 1,
      nodeId: "abstraction-readme",
      recordedAt: "2026-03-06T18:00:00.000Z",
      sessionKey: "agent:docs",
      kind: "project",
      abstractionLevel: "macro",
      title: "README refresh plan",
      summary: "Summarizes the documentation refresh for the landing page.",
      tags: ["docs"],
      entityRefs: ["page:readme"],
    },
  });

  await recordCueAnchor({
    memoryDir,
    anchor: {
      schemaVersion: 1,
      anchorId: "constraint-cursor-terminal",
      anchorType: "constraint",
      anchorValue: "wait for Cursor terminal state",
      normalizedCue: "wait for cursor terminal state",
      recordedAt: "2026-03-07T23:31:00.000Z",
      sessionKey: "agent:main",
      nodeRefs: ["abstraction-pr-loop"],
      tags: ["cursor", "pr-loop"],
    },
  });

  await recordCueAnchor({
    memoryDir,
    anchor: {
      schemaVersion: 1,
      anchorId: "entity-openclaw-engram",
      anchorType: "entity",
      anchorValue: "project:openclaw-engram",
      normalizedCue: "project openclaw engram",
      recordedAt: "2026-03-07T23:32:00.000Z",
      sessionKey: "agent:main",
      nodeRefs: ["abstraction-pr-loop"],
    },
  });

  await recordCueAnchor({
    memoryDir,
    anchor: {
      schemaVersion: 1,
      anchorId: "file-readme-md",
      anchorType: "file",
      anchorValue: "README.md",
      normalizedCue: "readme md",
      recordedAt: "2026-03-06T18:01:00.000Z",
      sessionKey: "agent:docs",
      nodeRefs: ["abstraction-readme"],
      tags: ["docs"],
    },
  });
}

async function buildHarmonicRecallHarness(options: {
  harmonicRetrievalEnabled: boolean;
  abstractionAnchorsEnabled: boolean;
  recallSectionEnabled?: boolean;
}) {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-harmonic-recall-"));
  await seedHarmonicStore(memoryDir);

  const cfg = parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir,
    qmdEnabled: false,
    transcriptEnabled: false,
    sharedContextEnabled: false,
    conversationIndexEnabled: false,
    hourlySummariesEnabled: false,
    injectQuestions: false,
    harmonicRetrievalEnabled: options.harmonicRetrievalEnabled,
    abstractionAnchorsEnabled: options.abstractionAnchorsEnabled,
    recallPipeline: [
      {
        id: "harmonic-retrieval",
        enabled: options.recallSectionEnabled ?? true,
        maxResults: 2,
        maxChars: 1800,
      },
    ],
  });

  return new Orchestrator(cfg);
}

test("searchHarmonicRetrieval blends abstraction-node and cue-anchor evidence", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-harmonic-search-"));
  await seedHarmonicStore(memoryDir);

  const results = await searchHarmonicRetrieval({
    memoryDir,
    query: "What rule says the PR loop must wait for Cursor terminal state?",
    maxResults: 2,
    sessionKey: "agent:main",
    anchorsEnabled: true,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.node.nodeId, "abstraction-pr-loop");
  assert.match(results[0]?.matchedFields.join(",") ?? "", /title|summary|anchor/i);
  assert.equal(
    results[0]?.matchedAnchors.some((anchor) => anchor.anchorType === "constraint"),
    true
  );
  assert.equal((results[0]?.anchorScore ?? 0) > 0, true);
});

test("searchHarmonicRetrieval does not double-count identical anchor value and normalized cue matches", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-harmonic-anchor-score-"));
  await seedHarmonicStore(memoryDir);

  const results = await searchHarmonicRetrieval({
    memoryDir,
    query: "cursor terminal state",
    maxResults: 1,
    sessionKey: "agent:main",
    anchorsEnabled: true,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.node.nodeId, "abstraction-pr-loop");
  assert.equal(results[0]?.anchorScore, 14);
});

test("searchHarmonicRetrieval returns no matches when query normalization strips all tokens", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-harmonic-stopwords-"));
  await seedHarmonicStore(memoryDir);

  const results = await searchHarmonicRetrieval({
    memoryDir,
    query: "why did it go?",
    maxResults: 3,
    sessionKey: "agent:main",
    anchorsEnabled: true,
  });

  assert.deepEqual(results, []);
});

test("harmonic-search CLI command returns blended harmonic results", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-harmonic-cli-"));
  await seedHarmonicStore(memoryDir);

  const results = await runHarmonicSearchCliCommand({
    memoryDir,
    abstractionNodeStoreDir: undefined,
    harmonicRetrievalEnabled: true,
    abstractionAnchorsEnabled: true,
    query: "Which workflow depends on Cursor terminal state?",
    maxResults: 2,
    sessionKey: "agent:main",
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.node.nodeId, "abstraction-pr-loop");
  assert.equal(results[0]?.matchedAnchors.length, 1);
});

test("recall injects harmonic retrieval section when the feature is enabled", async () => {
  const orchestrator = await buildHarmonicRecallHarness({
    harmonicRetrievalEnabled: true,
    abstractionAnchorsEnabled: true,
  });

  const context = await (orchestrator as any).recallInternal(
    "What rule says the PR loop waits for Cursor terminal state?",
    "agent:main"
  );

  assert.match(context, /## Harmonic Retrieval/);
  assert.match(context, /PR loop recovery workflow/i);
  assert.match(context, /anchors:/i);
  assert.equal(context.includes("## Relevant Memories"), false);
});

test("recall omits harmonic retrieval section when the feature flag is disabled", async () => {
  const orchestrator = await buildHarmonicRecallHarness({
    harmonicRetrievalEnabled: false,
    abstractionAnchorsEnabled: true,
  });

  const context = await (orchestrator as any).recallInternal(
    "What rule says the PR loop waits for Cursor terminal state?",
    "agent:main"
  );

  assert.equal(context.includes("## Harmonic Retrieval"), false);
});

test("recall omits harmonic retrieval section when the pipeline section is disabled", async () => {
  const orchestrator = await buildHarmonicRecallHarness({
    harmonicRetrievalEnabled: true,
    abstractionAnchorsEnabled: true,
    recallSectionEnabled: false,
  });

  const context = await (orchestrator as any).recallInternal(
    "What rule says the PR loop waits for Cursor terminal state?",
    "agent:main"
  );

  assert.equal(context.includes("## Harmonic Retrieval"), false);
});

test("harmonic retrieval drops inactive and missing sources but keeps an active sibling source", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-harmonic-active-source-"));
  const storage = new StorageManager(memoryDir);
  await storage.ensureDirectories();
  const { id: inactiveId } = await storage.writeMemory("fact", "inactive source fact", { source: "test" });
  const { id: activeId } = await storage.writeMemory("fact", "active sibling source fact", { source: "test" });
  await storage.updateMemoryFrontmatter(inactiveId, { status: "archived" });

  const sourceBackedNode = (nodeId: string, sourceMemoryIds: string[]) =>
    recordAbstractionNode({
      memoryDir,
      node: {
        schemaVersion: 1,
        nodeId,
        recordedAt: "2026-03-08T00:00:00.000Z",
        sessionKey: "agent:source-filter",
        kind: "topic",
        abstractionLevel: "meso",
        title: "source lifecycle rule",
        summary: "source lifecycle rule summary",
        sourceMemoryIds,
      },
    });
  await sourceBackedNode("inactive-only", [inactiveId]);
  await sourceBackedNode("missing-only", ["missing-source"]);
  await sourceBackedNode("active-sibling", [inactiveId, activeId]);
  await recordCueAnchor({
    memoryDir,
    anchor: {
      schemaVersion: 1,
      anchorId: "inactive-anchor",
      anchorType: "constraint",
      anchorValue: "source lifecycle rule",
      normalizedCue: "source lifecycle rule",
      recordedAt: "2026-03-08T00:01:00.000Z",
      sessionKey: "agent:source-filter",
      nodeRefs: ["inactive-only"],
    },
  });

  const results = await searchHarmonicRetrieval({
    memoryDir,
    query: "Which source lifecycle rule applies?",
    maxResults: 10,
    anchorsEnabled: true,
  });

  assert.deepEqual(
    results.map((result) => result.node.nodeId),
    ["active-sibling"]
  );
  assert.equal(
    results.some((result) => result.node.nodeId === "inactive-only"),
    false
  );
  assert.equal(
    results.some((result) => result.node.nodeId === "missing-only"),
    false
  );
});

test("harmonic retrieval rejects an unreadable sidecar store", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-harmonic-unreadable-"));
  const unreadableStore = path.join(memoryDir, "not-a-directory");
  await writeFile(unreadableStore, "not a directory");

  await assert.rejects(
    () =>
      searchHarmonicRetrieval({
        memoryDir,
        abstractionNodeStoreDir: unreadableStore,
        query: "unreadable sidecar",
        maxResults: 3,
        anchorsEnabled: true,
      }),
    (error: unknown) => error instanceof Error && /ENOTDIR|not a directory/i.test(error.message)
  );
});
