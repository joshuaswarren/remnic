import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { StorageManager } from "../src/storage.js";
import { HARMONIC_SOURCE_MEMORY_INSERTED_AT_KEY, recordAbstractionNode } from "../src/abstraction-nodes.js";
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
        title: "active sibling source fact",
        summary: "active sibling source fact",
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
    query: "Which active sibling source fact applies?",
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

test("harmonic retrieval applies temporal validity unless expired injection is enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-harmonic-temporal-source-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const { id } = await storage.writeMemory("fact", "expired temporal source", { source: "test" });
    await storage.updateMemoryFrontmatter(id, {
      status: "active",
      invalid_at: "2020-01-01T00:00:00.000Z",
    });
    await recordAbstractionNode({
      memoryDir,
      node: {
        schemaVersion: 1,
        nodeId: "expired-temporal-node",
        recordedAt: "2026-03-08T00:00:00.000Z",
        sessionKey: "agent:temporal-source",
        kind: "topic",
        abstractionLevel: "meso",
        title: "expired temporal source",
        summary: "expired temporal source",
        sourceMemoryIds: [id],
      },
    });

    const filtered = await searchHarmonicRetrieval({
      memoryDir,
      query: "expired temporal source",
      maxResults: 10,
      anchorsEnabled: false,
      temporalExpiredInInjection: false,
    });
    assert.deepEqual(filtered, []);

    const included = await searchHarmonicRetrieval({
      memoryDir,
      query: "expired temporal source",
      maxResults: 10,
      anchorsEnabled: false,
      temporalExpiredInInjection: true,
    });
    assert.deepEqual(
      included.map((result) => result.node.nodeId),
      ["expired-temporal-node"]
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("harmonic retrieval projects mixed source nodes from active memories only", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-harmonic-projection-"));
  const originalReadAllMemories = StorageManager.prototype.readAllMemories;
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const { id: inactiveId } = await storage.writeMemory("fact", "inactive source payload", {
      source: "test",
      tags: ["inactive-tag"],
      entityRef: "inactive-entity",
    });
    const { id: archivedAtId } = await storage.writeMemory("fact", "archived-at source payload", {
      source: "test",
      tags: ["archived-at-tag"],
      entityRef: "archived-at-entity",
    });
    const { id: archivePathId } = await storage.writeMemory("fact", "archive-path source payload", {
      source: "test",
      tags: ["archive-path-tag"],
      entityRef: "archive-path-entity",
    });
    const { id: activeId } = await storage.writeMemory("fact", "active source payload", {
      source: "test",
      tags: ["active-tag"],
      entityRef: "active-entity",
      structuredAttributes: { status: "current" },
    });
    await storage.updateMemoryFrontmatter(inactiveId, { status: "archived" });
    await storage.updateMemoryFrontmatter(archivedAtId, {
      status: "active",
      archivedAt: "2026-03-08T00:00:00.000Z",
    });

    const originalRead = originalReadAllMemories;
    StorageManager.prototype.readAllMemories = async function (options) {
      const memories = await originalRead.call(this, options);
      return memories.map((memory) =>
        memory.frontmatter.id === archivePathId
          ? { ...memory, path: path.join(this.dir, "archive", "2026-03-08", path.basename(memory.path)) }
          : memory
      );
    };

    const sourceMemoryIds = [inactiveId, archivedAtId, archivePathId, activeId];
    await recordAbstractionNode({
      memoryDir,
      node: {
        schemaVersion: 1,
        nodeId: "mixed-source-node",
        recordedAt: "2026-03-08T00:00:00.000Z",
        sessionKey: "agent:source-projection",
        kind: "topic",
        abstractionLevel: "meso",
        title: "inactive title archived-at title archive-path title active title",
        summary: "inactive summary archived-at summary archive-path summary active summary",
        sourceMemoryIds,
        tags: ["inactive-tag", "archived-at-tag", "archive-path-tag", "active-tag"],
        entityRefs: ["inactive-entity", "archived-at-entity", "archive-path-entity", "active-entity"],
        metadata: {
          [HARMONIC_SOURCE_MEMORY_INSERTED_AT_KEY]: JSON.stringify(
            Object.fromEntries(sourceMemoryIds.map((id, index) => [id, `2026-03-08T00:0${index}:00.000Z`]))
          ),
        },
      },
    });
    await recordAbstractionNode({
      memoryDir,
      node: {
        schemaVersion: 1,
        nodeId: "inactive-only-node",
        recordedAt: "2026-03-08T00:00:00.000Z",
        sessionKey: "agent:source-projection",
        kind: "topic",
        abstractionLevel: "meso",
        title: "inactive title",
        summary: "inactive summary",
        sourceMemoryIds: [inactiveId],
      },
    });
    await recordAbstractionNode({
      memoryDir,
      node: {
        schemaVersion: 1,
        nodeId: "missing-only-node",
        recordedAt: "2026-03-08T00:00:00.000Z",
        sessionKey: "agent:source-projection",
        kind: "topic",
        abstractionLevel: "meso",
        title: "missing title",
        summary: "missing summary",
        sourceMemoryIds: ["missing-source"],
      },
    });
    await recordCueAnchor({
      memoryDir,
      anchor: {
        schemaVersion: 1,
        anchorId: "inactive-only-anchor",
        anchorType: "constraint",
        anchorValue: "inactive title",
        normalizedCue: "inactive title",
        recordedAt: "2026-03-08T00:01:00.000Z",
        sessionKey: "agent:source-projection",
        nodeRefs: ["inactive-only-node"],
      },
    });
    await recordCueAnchor({
      memoryDir,
      anchor: {
        schemaVersion: 1,
        anchorId: "legacy-mixed-anchor",
        anchorType: "constraint",
        anchorValue: "retired legacy cue",
        normalizedCue: "retired legacy cue",
        recordedAt: "2026-03-08T00:02:00.000Z",
        sessionKey: "agent:source-projection",
        nodeRefs: ["mixed-source-node"],
      },
    });

    const results = await searchHarmonicRetrieval({
      memoryDir,
      query: "active source payload",
      maxResults: 10,
      anchorsEnabled: true,
    });
    assert.deepEqual(
      results.map((result) => result.node.nodeId),
      ["mixed-source-node"]
    );
    const projected = results[0]?.node;
    assert.ok(projected);
    assert.deepEqual(projected.sourceMemoryIds, [activeId]);
    assert.deepEqual(projected.tags, ["active-tag"]);
    assert.deepEqual(projected.entityRefs, ["active-entity"]);
    assert.equal(projected.title, "active source payload");
    assert.equal(projected.summary, "active source payload");
    assert.deepEqual(JSON.parse(projected.metadata?.[HARMONIC_SOURCE_MEMORY_INSERTED_AT_KEY] ?? "{}"), {
      [activeId]: "2026-03-08T00:03:00.000Z",
    });
    assert.equal(JSON.stringify(projected).includes("inactive"), false);

    const inactiveResults = await searchHarmonicRetrieval({
      memoryDir,
      query: "inactive title",
      maxResults: 10,
      anchorsEnabled: true,
    });
    assert.deepEqual(inactiveResults, []);
    const legacyMixedResults = await searchHarmonicRetrieval({
      memoryDir,
      query: "retired legacy cue",
      maxResults: 10,
      anchorsEnabled: true,
    });
    assert.deepEqual(legacyMixedResults, []);
  } finally {
    StorageManager.prototype.readAllMemories = originalReadAllMemories;
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("harmonic retrieval rebuilds fully active node metadata from retained sources", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-harmonic-active-projection-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const { id: activeId } = await storage.writeMemory("fact", "fully active source", {
      source: "test",
      tags: ["active-tag"],
      entityRef: "active-entity",
    });
    const fullyActiveNode = {
      schemaVersion: 1 as const,
      nodeId: "fully-active-node",
      recordedAt: "2026-03-08T00:00:00.000Z",
      sessionKey: "agent:source-projection",
      kind: "topic" as const,
      abstractionLevel: "meso" as const,
      title: "stale stored title",
      summary: "stale stored summary",
      sourceMemoryIds: [activeId],
      tags: ["stale-tag"],
      entityRefs: ["stale-entity"],
      metadata: undefined,
    };
    await recordAbstractionNode({ memoryDir, node: fullyActiveNode });
    const sourceLessNode = {
      schemaVersion: 1 as const,
      nodeId: "source-less-node",
      recordedAt: "2026-03-08T00:00:00.000Z",
      sessionKey: "agent:source-projection",
      kind: "topic" as const,
      abstractionLevel: "meso" as const,
      title: "source-less title",
      summary: "source-less summary",
    };
    await recordAbstractionNode({ memoryDir, node: sourceLessNode });
    await recordCueAnchor({
      memoryDir,
      anchor: {
        schemaVersion: 1,
        anchorId: "legacy-active-anchor",
        anchorType: "constraint",
        anchorValue: "zephyr quasar",
        normalizedCue: "zephyr quasar",
        recordedAt: "2026-03-08T00:01:00.000Z",
        sessionKey: "agent:source-projection",
        nodeRefs: ["fully-active-node"],
      },
    });

    const activeResults = await searchHarmonicRetrieval({
      memoryDir,
      query: "fully active source",
      maxResults: 10,
      anchorsEnabled: false,
    });
    const activeNode = activeResults.find((result) => result.node.nodeId === "fully-active-node")?.node;
    assert.deepEqual(activeNode, {
      ...fullyActiveNode,
      title: "fully active source",
      summary: "fully active source",
      tags: ["active-tag"],
      entityRefs: ["active-entity"],
    });
    const legacyActiveResults = await searchHarmonicRetrieval({
      memoryDir,
      query: "zephyr quasar",
      maxResults: 10,
      anchorsEnabled: true,
    });
    assert.deepEqual(
      legacyActiveResults.map((result) => result.node.nodeId),
      ["fully-active-node"]
    );

    const sourceLessResults = await searchHarmonicRetrieval({
      memoryDir,
      query: "source-less",
      maxResults: 10,
      anchorsEnabled: false,
    });
    assert.ok(sourceLessResults.some((result) => result.node.nodeId === "source-less-node"));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
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
