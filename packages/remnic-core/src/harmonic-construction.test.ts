import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getAbstractionNodeStoreStatus, upsertAbstractionNode, validateAbstractionNode } from "./abstraction-nodes.js";
import { parseConfig } from "./config.js";
import { getCueAnchorStoreStatus, pruneOrphanCueAnchors, upsertCueAnchor, validateCueAnchor } from "./cue-anchors.js";
import { extractionCueAnchors } from "./extraction-normalization.js";
import { buildExtractionInstructions } from "./extraction-prompt.js";
import { ExtractionEngine } from "./extraction.js";
import {
  type HarmonicConstructionInput,
  deriveHarmonicRecords,
  normalizeCueAnchorInputs,
} from "./harmonic-construction.js";
import { searchHarmonicRetrieval } from "./harmonic-retrieval.js";
import { readJsonFile } from "./json-store.js";
import { filterHarmonicEntityMentions } from "./orchestration/harmonic-construction-persist.js";
import { Orchestrator } from "./orchestrator.js";
import { ExtractedFactSchema, ExtractionResultSchema } from "./schemas.js";
import type { ExtractionResult } from "./types.js";

type HarmonicStorageHarness = {
  dir: string;
  ensureDirectories(): Promise<void>;
};

type PersistenceHarness = {
  getStorage(namespace: string): Promise<HarmonicStorageHarness>;
  persistExtraction(
    result: ExtractionResult,
    storage: HarmonicStorageHarness,
    threadId: string | null,
    sourceContext: { sessionKey: string },
    baseNamespace?: string
  ): Promise<{ persistedIds: string[] }>;
};

const RECORDED_AT = "2026-08-08T20:00:00.000Z";

function constructionInput(overrides: Partial<HarmonicConstructionInput> = {}): HarmonicConstructionInput {
  return {
    sessionKey: "session:test",
    recordedAt: RECORDED_AT,
    episodeTitle: "Atlas storage decision and deployment",
    persistedFacts: [
      {
        memoryId: "mem-2",
        content: "The Atlas project selected PostgreSQL for durable storage.",
        category: "decision",
        tags: ["storage", "atlas"],
        entityRef: "atlas-project",
        cueAnchors: [
          { type: "tool", value: "PostgreSQL durable storage" },
          { type: "outcome", value: "Atlas storage decision" },
        ],
        validAt: "2026-08-08T12:00:00.000Z",
      },
      {
        memoryId: "mem-1",
        content: "The Atlas project deploys through the release workflow.",
        category: "fact",
        tags: ["atlas", "release"],
        entityRef: "atlas-project",
        cueAnchors: [{ type: "tool", value: "Atlas release workflow" }],
      },
    ],
    entityMentions: [
      {
        name: "atlas-project",
        type: "project",
        facts: ["Atlas uses PostgreSQL.", "Atlas has a release workflow."],
      },
      {
        name: "PostgreSQL",
        type: "tool",
        facts: ["PostgreSQL stores durable project data."],
      },
    ],
    ...overrides,
  };
}

function reverseInputArrays(input: HarmonicConstructionInput): HarmonicConstructionInput {
  return {
    ...input,
    persistedFacts: [...input.persistedFacts].reverse().map((fact) => ({
      ...fact,
      tags: [...fact.tags].reverse(),
      cueAnchors: fact.cueAnchors ? [...fact.cueAnchors].reverse() : fact.cueAnchors,
    })),
    entityMentions: [...input.entityMentions]
      .reverse()
      .map((entity) => ({ ...entity, facts: [...(entity.facts ?? [])].reverse() })),
  };
}

test("deriveHarmonicRecords is deterministic across repeated and shuffled input", () => {
  const input = constructionInput();
  const first = deriveHarmonicRecords(input);
  const second = deriveHarmonicRecords(input);
  const shuffled = deriveHarmonicRecords(reverseInputArrays(input));

  assert.deepEqual(second, first);
  assert.deepEqual(shuffled, first);
  assert.ok(first.nodes.some((node) => node.kind === "episode"));
  assert.equal(first.nodes.filter((node) => node.kind === "project").length, 1);
  assert.equal(first.nodes.filter((node) => node.kind === "topic").length, 1);
});

test("deriveHarmonicRecords caps model anchors and adds deterministic anchors", () => {
  const input = constructionInput({
    persistedFacts: [
      {
        memoryId: "mem-1",
        content: "Atlas shipped its storage migration on the planned date.",
        category: "moment",
        tags: ["atlas"],
        entityRef: "atlas-project",
        validAt: "2026-08-08T12:00:00.000Z",
        cueAnchors: [
          { type: "tool", value: "migration tool z" },
          { type: "outcome", value: "migration outcome z" },
          { type: "constraint", value: "migration limit z" },
          { type: "file", value: "migration file z" },
          { type: "entity", value: "migration entity z" },
          { type: "date", value: "migration date z" },
          { type: "tool", value: "migration tool a" },
        ],
      },
    ],
    entityMentions: [{ name: "atlas-project", type: "project", facts: ["Atlas shipped the migration."] }],
  });

  const records = deriveHarmonicRecords(input);
  const shuffled = deriveHarmonicRecords(reverseInputArrays(input));
  assert.deepEqual(shuffled, records);
  assert.equal(records.anchors.length, 5, "three model anchors plus entity and date anchors");
  assert.ok(records.anchors.some((anchor) => anchor.anchorValue === "atlas-project"));
  assert.ok(records.anchors.some((anchor) => anchor.anchorValue === "2026-08-08"));
});

test("deriveHarmonicRecords keeps anchor identity stable across case and whitespace", () => {
  const first = deriveHarmonicRecords(
    constructionInput({
      persistedFacts: [
        {
          memoryId: "mem-1",
          content: "Atlas selected PostgreSQL.",
          category: "decision",
          tags: [],
          cueAnchors: [{ type: "tool", value: "Atlas   PostgreSQL" }],
        },
      ],
      entityMentions: [],
    })
  );
  const second = deriveHarmonicRecords(
    constructionInput({
      persistedFacts: [
        {
          memoryId: "mem-1",
          content: "Atlas selected PostgreSQL.",
          category: "decision",
          tags: [],
          cueAnchors: [{ type: "tool", value: "  atlas postgresql  " }],
        },
      ],
      entityMentions: [],
    })
  );

  const firstTool = first.anchors.find((anchor) => anchor.anchorType === "tool");
  const secondTool = second.anchors.find((anchor) => anchor.anchorType === "tool");
  assert.ok(firstTool);
  assert.ok(secondTool);
  assert.equal(secondTool.anchorId, firstTool.anchorId);
  assert.equal(secondTool.normalizedCue, "atlas postgresql");
});

test("deriveHarmonicRecords gives every topic a durable source and summary", () => {
  const records = deriveHarmonicRecords(
    constructionInput({
      persistedFacts: [
        {
          memoryId: "mem-1",
          content: "The release uses a durable build record.",
          category: "fact",
          tags: ["release"],
          entityRef: "release-service",
        },
      ],
      entityMentions: [{ name: "release-service", type: "service" }],
    })
  );
  const topic = records.nodes.find((node) => node.nodeId === "topic-release-service");
  assert.ok(topic);
  assert.deepEqual(topic.sourceMemoryIds, ["mem-1"]);
  assert.equal(topic.summary, "The release uses a durable build record.");
});

test("deriveHarmonicRecords isolates colliding entity names", () => {
  const records = deriveHarmonicRecords(
    constructionInput({
      persistedFacts: [
        {
          memoryId: "mem-slash",
          content: "The slash entity owns the first fact.",
          category: "fact",
          tags: ["slash"],
          entityRef: "A/B",
        },
        {
          memoryId: "mem-space",
          content: "The space entity owns the second fact.",
          category: "fact",
          tags: ["space"],
          entityRef: "A B",
        },
      ],
      entityMentions: [
        { name: "A/B", type: "project", facts: ["Slash summary."] },
        { name: "A B", type: "project", facts: ["Space summary."] },
      ],
    })
  );

  const topics = records.nodes.filter((node) => node.kind === "project");
  assert.equal(topics.length, 2);
  assert.ok(topics.every((node) => node.sourceMemoryIds?.length === 1));
  assert.deepEqual(topics.flatMap((node) => node.sourceMemoryIds ?? []).sort(), ["mem-slash", "mem-space"]);
  assert.notEqual(topics[0]?.nodeId, topics[1]?.nodeId);
});

test("filterHarmonicEntityMentions keeps safe aliases and replaces model summaries", () => {
  const mentions: ExtractionResult["entities"] = [
    { name: "Atlas Project", type: "project", facts: ["Pending private detail."] },
    { name: "private-project", type: "project", facts: ["Private summary."] },
  ];
  const filtered = filterHarmonicEntityMentions(
    [
      {
        memoryId: "mem-local",
        content: "The local project fact.",
        category: "fact",
        tags: [],
        entityRef: "Atlas/Project",
      },
    ],
    mentions
  );

  assert.deepEqual(filtered, [{ name: "Atlas Project", type: "project", facts: ["The local project fact."] }]);
});
test("filterHarmonicEntityMentions rejects ambiguous safe-segment aliases", () => {
  const filtered = filterHarmonicEntityMentions(
    [
      {
        memoryId: "mem-slash",
        content: "The slash project fact.",
        category: "fact",
        tags: [],
        entityRef: "A/B",
      },
    ],
    [
      { name: "A/B", type: "project", facts: ["Slash summary."] },
      { name: "A B", type: "project", facts: ["Space summary."] },
    ]
  );

  assert.deepEqual(filtered, [{ name: "A/B", type: "project", facts: ["The slash project fact."] }]);
});

test("upsertAbstractionNode merges links and keeps the newest description", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-harmonic-node-upsert-"));
  const firstPath = await upsertAbstractionNode({
    memoryDir,
    node: {
      schemaVersion: 1,
      nodeId: "topic-atlas-project",
      recordedAt: "2026-08-07T20:00:00.000Z",
      sessionKey: "session:old",
      kind: "project",
      abstractionLevel: "meso",
      title: "Old Atlas title",
      summary: "Old Atlas summary.",
      sourceMemoryIds: ["m2"],
      entityRefs: ["atlas-project"],
      tags: ["old"],
    },
  });

  const secondPath = await upsertAbstractionNode({
    memoryDir,
    node: {
      schemaVersion: 1,
      nodeId: "topic-atlas-project",
      recordedAt: RECORDED_AT,
      sessionKey: "session:new",
      kind: "project",
      abstractionLevel: "meso",
      title: "Current Atlas title",
      summary: "Current Atlas summary.",
      sourceMemoryIds: ["m1", "m3"],
      entityRefs: ["atlas-project"],
      tags: ["current"],
    },
  });

  assert.equal(secondPath, firstPath, "a stable topic node updates one existing file");
  const merged = validateAbstractionNode(await readJsonFile(secondPath));
  assert.deepEqual(merged.sourceMemoryIds, ["m1", "m2", "m3"]);
  assert.deepEqual(merged.tags, ["current", "old"]);
  assert.equal(merged.title, "Current Atlas title");
  assert.equal(merged.summary, "Current Atlas summary.");
  assert.equal(merged.recordedAt, RECORDED_AT);
});
test("upsertAbstractionNode caps links by insertion recency", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-harmonic-node-cap-"));
  try {
    await upsertAbstractionNode({
      memoryDir,
      node: {
        schemaVersion: 1,
        nodeId: "topic-atlas-project",
        recordedAt: "2026-08-07T20:00:00.000Z",
        sessionKey: "session:old",
        kind: "project",
        abstractionLevel: "meso",
        title: "Old Atlas title",
        summary: "Old Atlas summary.",
        sourceMemoryIds: Array.from({ length: 50 }, (_, index) => `old-${String(index).padStart(2, "0")}`),
      },
    });
    const cappedPath = await upsertAbstractionNode({
      memoryDir,
      node: {
        schemaVersion: 1,
        nodeId: "topic-atlas-project",
        recordedAt: "2026-08-09T20:00:00.000Z",
        sessionKey: "session:new",
        kind: "project",
        abstractionLevel: "meso",
        title: "New Atlas title",
        summary: "New Atlas summary.",
        sourceMemoryIds: ["new-00", "new-01"],
      },
    });
    await upsertAbstractionNode({
      memoryDir,
      node: {
        schemaVersion: 1,
        nodeId: "topic-atlas-project",
        recordedAt: "2026-08-06T20:00:00.000Z",
        sessionKey: "session:replay",
        kind: "project",
        abstractionLevel: "meso",
        title: "Replayed Atlas title",
        summary: "Replayed Atlas summary.",
        sourceMemoryIds: ["ancient-replay"],
      },
    });
    await upsertAbstractionNode({
      memoryDir,
      node: {
        schemaVersion: 1,
        nodeId: "topic-atlas-project",
        recordedAt: "2026-08-10T20:00:00.000Z",
        sessionKey: "session:duplicate-retry",
        kind: "project",
        abstractionLevel: "meso",
        title: "Duplicate Atlas title",
        summary: "Duplicate Atlas summary.",
        sourceMemoryIds: ["old-03"],
      },
    });
    await upsertAbstractionNode({
      memoryDir,
      node: {
        schemaVersion: 1,
        nodeId: "topic-atlas-project",
        recordedAt: "2026-08-11T20:00:00.000Z",
        sessionKey: "session:latest",
        kind: "project",
        abstractionLevel: "meso",
        title: "Latest Atlas title",
        summary: "Latest Atlas summary.",
        sourceMemoryIds: ["latest-new"],
      },
    });

    const capped = validateAbstractionNode(await readJsonFile(cappedPath));
    assert.equal(capped.sourceMemoryIds?.length, 50);
    assert.ok(capped.sourceMemoryIds?.includes("new-00"));
    assert.ok(capped.sourceMemoryIds?.includes("new-01"));
    assert.ok(capped.sourceMemoryIds?.includes("ancient-replay"));
    assert.ok(capped.sourceMemoryIds?.includes("latest-new"));
    assert.ok(!capped.sourceMemoryIds?.includes("old-03"));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("derived insertion timestamps retain the newest links within one large batch", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-harmonic-node-batch-cap-"));
  try {
    const baseTime = Date.parse("2026-08-08T00:00:00.000Z");
    const memoryIds = [
      "z-oldest",
      ...Array.from({ length: 49 }, (_, index) => `middle-${String(index).padStart(2, "0")}`),
      "a-newest",
    ];
    const records = deriveHarmonicRecords(
      constructionInput({
        persistedFacts: memoryIds.map((memoryId, index) => ({
          memoryId,
          content: `Fact ${index}`,
          category: "fact",
          tags: [],
          insertedAt: new Date(baseTime + index).toISOString(),
          entityRef: "atlas-project",
        })),
        entityMentions: [
          {
            name: "atlas-project",
            type: "project",
            facts: ["A large accepted fact batch."],
          },
        ],
      })
    );
    const topic = records.nodes.find((node) => node.nodeId === "topic-atlas-project");
    assert.ok(topic);
    const topicPath = await upsertAbstractionNode({ memoryDir, node: topic });
    const capped = validateAbstractionNode(await readJsonFile(topicPath));

    assert.equal(capped.sourceMemoryIds?.length, 50);
    assert.ok(capped.sourceMemoryIds?.includes("a-newest"));
    assert.ok(!capped.sourceMemoryIds?.includes("z-oldest"));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("upsertCueAnchor unions node references and keeps newest fields", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-harmonic-anchor-upsert-"));
  try {
    const firstPath = await upsertCueAnchor({
      memoryDir,
      anchor: {
        schemaVersion: 1,
        anchorId: "cue-atlas-storage",
        anchorType: "tool",
        anchorValue: "old atlas storage",
        normalizedCue: "atlas storage",
        recordedAt: "2026-08-07T20:00:00.000Z",
        sessionKey: "session:old",
        nodeRefs: ["ep-old"],
        tags: ["old"],
      },
    });
    const secondPath = await upsertCueAnchor({
      memoryDir,
      anchor: {
        schemaVersion: 1,
        anchorId: "cue-atlas-storage",
        anchorType: "tool",
        anchorValue: "current atlas storage",
        normalizedCue: "atlas storage",
        recordedAt: RECORDED_AT,
        sessionKey: "session:new",
        nodeRefs: ["ep-new"],
        tags: ["current"],
      },
    });
    assert.equal(secondPath, firstPath);
    const merged = validateCueAnchor(await readJsonFile(secondPath));
    assert.deepEqual(merged.nodeRefs, ["ep-new", "ep-old"]);
    assert.deepEqual(merged.tags, ["current", "old"]);
    assert.equal(merged.anchorValue, "current atlas storage");
    assert.equal(merged.recordedAt, RECORDED_AT);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("concurrent cue-anchor upserts preserve every node reference", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-harmonic-anchor-concurrent-"));
  try {
    const paths = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        upsertCueAnchor({
          memoryDir,
          anchor: {
            schemaVersion: 1,
            anchorId: "cue-concurrent",
            anchorType: "tool",
            anchorValue: "concurrent tool",
            normalizedCue: "concurrent tool",
            recordedAt: RECORDED_AT,
            sessionKey: "session:test",
            nodeRefs: [`ep-${String(index).padStart(2, "0")}`],
          },
        })
      )
    );
    const merged = validateCueAnchor(await readJsonFile(paths[0] as string));
    assert.deepEqual(
      merged.nodeRefs,
      Array.from({ length: 20 }, (_, index) => `ep-${String(index).padStart(2, "0")}`)
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("cross-process cue-anchor upserts preserve every node reference", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-harmonic-anchor-processes-"));
  try {
    const workerPath = path.join(memoryDir, "upsert-worker.mjs");
    const cueAnchorModuleUrl = new URL("./cue-anchors.ts", import.meta.url).href;
    await writeFile(
      workerPath,
      `import { upsertCueAnchor } from ${JSON.stringify(cueAnchorModuleUrl)};
const [memoryDir, nodeRef] = process.argv.slice(2);
await upsertCueAnchor({
  memoryDir,
  anchor: {
    schemaVersion: 1,
    anchorId: "cue-processes",
    anchorType: "tool",
    anchorValue: "process tool",
    normalizedCue: "process tool",
    recordedAt: ${JSON.stringify(RECORDED_AT)},
    sessionKey: "session:test",
    nodeRefs: [nodeRef],
  },
});`,
      "utf8"
    );
    const runWorker = (nodeRef: string): Promise<void> => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const child = spawn(process.execPath, ["--import", "tsx", workerPath, memoryDir, nodeRef], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`harmonic upsert worker exited ${String(code)}: ${stderr}`));
      });
      return promise;
    };
    const nodeRefs = Array.from({ length: 8 }, (_, index) => `ep-process-${index}`);
    await Promise.all(nodeRefs.map(runWorker));

    const anchorFiles = await getCueAnchorStoreStatus({
      memoryDir,
      enabled: true,
      anchorsEnabled: true,
    });
    assert.equal(anchorFiles.anchors.total, 1);
    const merged = anchorFiles.anchors.byType.tool;
    assert.equal(merged, 1);
    const anchorPath = path.join(memoryDir, "state", "abstraction-nodes", "anchors", "tool", "cue-processes.json");
    assert.deepEqual(validateCueAnchor(await readJsonFile(anchorPath)).nodeRefs, nodeRefs);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("pruneOrphanCueAnchors removes only anchors without a live node", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-harmonic-prune-"));
  const liveNodePath = await upsertAbstractionNode({
    memoryDir,
    node: {
      schemaVersion: 1,
      nodeId: "ep-live",
      recordedAt: RECORDED_AT,
      sessionKey: "session:test",
      kind: "episode",
      abstractionLevel: "micro",
      title: "Live episode",
      summary: "The live episode remains available.",
      sourceMemoryIds: ["m1"],
    },
  });
  const deletedNodePath = await upsertAbstractionNode({
    memoryDir,
    node: {
      schemaVersion: 1,
      nodeId: "ep-deleted",
      recordedAt: RECORDED_AT,
      sessionKey: "session:test",
      kind: "episode",
      abstractionLevel: "micro",
      title: "Deleted episode",
      summary: "This episode will be deleted.",
      sourceMemoryIds: ["m2"],
    },
  });
  const orphanPath = await upsertCueAnchor({
    memoryDir,
    anchor: {
      schemaVersion: 1,
      anchorId: "cue-orphan",
      anchorType: "tool",
      anchorValue: "orphan tool",
      normalizedCue: "orphan tool",
      recordedAt: RECORDED_AT,
      sessionKey: "session:test",
      nodeRefs: ["ep-deleted"],
    },
  });
  const liveAnchorPath = await upsertCueAnchor({
    memoryDir,
    anchor: {
      schemaVersion: 1,
      anchorId: "cue-live",
      anchorType: "tool",
      anchorValue: "live tool",
      normalizedCue: "live tool",
      recordedAt: RECORDED_AT,
      sessionKey: "session:test",
      nodeRefs: ["ep-deleted", "ep-live"],
    },
  });

  await unlink(deletedNodePath);
  const removed = await pruneOrphanCueAnchors({ memoryDir });

  assert.equal(removed, 1);
  await assert.rejects(stat(orphanPath), { code: "ENOENT" });
  assert.ok((await stat(liveAnchorPath)).isFile());
  assert.ok((await stat(liveNodePath)).isFile());
  await rm(memoryDir, { recursive: true, force: true });
});

test("pruneOrphanCueAnchors preserves anchors when the node scan fails", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-harmonic-prune-error-"));
  try {
    const anchorPath = await upsertCueAnchor({
      memoryDir,
      anchor: {
        schemaVersion: 1,
        anchorId: "cue-scan-failure",
        anchorType: "tool",
        anchorValue: "scan failure tool",
        normalizedCue: "scan failure tool",
        recordedAt: RECORDED_AT,
        sessionKey: "session:test",
        nodeRefs: ["ep-live"],
      },
    });
    const nodesPath = path.join(memoryDir, "state", "abstraction-nodes", "nodes");
    await writeFile(nodesPath, "not a directory", "utf8");

    await assert.rejects(
      pruneOrphanCueAnchors({ memoryDir }),
      (error: NodeJS.ErrnoException) => error.code === "ENOTDIR"
    );
    assert.ok((await stat(anchorPath)).isFile());
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("pruneOrphanCueAnchors aborts when a node record is malformed", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-harmonic-prune-malformed-"));
  try {
    const anchorPath = await upsertCueAnchor({
      memoryDir,
      anchor: {
        schemaVersion: 1,
        anchorId: "cue-malformed-node",
        anchorType: "tool",
        anchorValue: "malformed node tool",
        normalizedCue: "malformed node tool",
        recordedAt: RECORDED_AT,
        sessionKey: "session:test",
        nodeRefs: ["ep-malformed"],
      },
    });
    const malformedNodePath = path.join(
      memoryDir,
      "state",
      "abstraction-nodes",
      "nodes",
      "2026-08-08",
      "ep-malformed.json"
    );
    await mkdir(path.dirname(malformedNodePath), { recursive: true });
    await writeFile(malformedNodePath, "{}", "utf8");

    await assert.rejects(pruneOrphanCueAnchors({ memoryDir }));
    assert.ok((await stat(anchorPath)).isFile());
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("consolidation prunes orphan cue anchors when harmonic construction is enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-harmonic-consolidation-prune-"));
  try {
    const orphanPath = await upsertCueAnchor({
      memoryDir,
      anchor: {
        schemaVersion: 1,
        anchorId: "cue-consolidation-orphan",
        anchorType: "tool",
        anchorValue: "orphan consolidation tool",
        normalizedCue: "orphan consolidation tool",
        recordedAt: RECORDED_AT,
        sessionKey: "session:test",
        nodeRefs: ["ep-missing"],
      },
    });
    const orchestrator = new Orchestrator(
      parseConfig({
        openaiApiKey: "sk-test",
        memoryDir,
        workspaceDir: path.join(memoryDir, "workspace"),
        qmdEnabled: false,
        harmonicRetrievalEnabled: true,
        abstractionAnchorsEnabled: true,
      })
    );

    const result = await orchestrator.runConsolidationNow();

    assert.equal(result.memoriesProcessed, 0);
    await assert.rejects(stat(orphanPath), { code: "ENOENT" });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("extraction schema, prompt, and normalizer carry bounded harmonic fields", () => {
  const parsedFact = ExtractedFactSchema.parse({
    category: "fact",
    content: "Atlas uses PostgreSQL.",
    confidence: 0.9,
    tags: ["atlas"],
    cueAnchors: [{ type: "tool", value: "Atlas PostgreSQL" }],
  });
  const parsedResult = ExtractionResultSchema.parse({
    facts: [parsedFact],
    profileUpdates: [],
    entities: [],
    questions: [],
    episodeTitle: "Atlas storage choice",
  });
  assert.equal(parsedResult.episodeTitle, "Atlas storage choice");
  assert.equal(parsedResult.facts[0]?.cueAnchors?.[0]?.value, "Atlas PostgreSQL");

  const memoryDir = path.join(os.tmpdir(), "remnic-harmonic-normalize");
  const engine = new ExtractionEngine(
    parseConfig({
      openaiApiKey: "test-key",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
    })
  );
  const normalizer = engine as unknown as {
    normalizeExtractionResultPayload: (payload: unknown) => ExtractionResult;
  };
  const normalized = normalizer.normalizeExtractionResultPayload({
    facts: [
      {
        category: "fact",
        content: "Atlas uses PostgreSQL.",
        confidence: 0.9,
        tags: [],
        structuredAttributes: { zeta: "last", alpha: "first" },
        cueAnchors: [
          { type: "date", value: "x".repeat(121) },
          { type: "invalid", value: "drop invalid type" },
          { type: "entity", value: "   " },
          { type: "tool", value: "first" },
          { type: "outcome", value: "second" },
          { type: "constraint", value: "third" },
          { type: "file", value: "fourth" },
        ],
      },
    ],
    entities: [],
    profileUpdates: [],
    questions: [],
    episodeTitle: "  Atlas storage choice  ",
  });

  assert.deepEqual(normalized.facts[0]?.cueAnchors, [
    { type: "constraint", value: "third" },
    { type: "file", value: "fourth" },
    { type: "outcome", value: "second" },
  ]);
  assert.deepEqual(Object.keys(normalized.facts[0]?.structuredAttributes ?? {}), ["alpha", "zeta"]);
  assert.equal(normalized.episodeTitle, "Atlas storage choice");

  const instructions = buildExtractionInstructions(
    parseConfig({ memoryDir, workspaceDir: path.join(memoryDir, "workspace") })
  );
  assert.match(instructions, /cueAnchors/);
  assert.match(instructions, /episodeTitle/);
});

test("cue-anchor normalization is canonical before the three-anchor cap", () => {
  const candidates = [
    { type: "tool", value: "Atlas Tool" },
    { type: "date", value: "2026-08-08" },
    { type: "entity", value: "Atlas" },
    { type: "tool", value: "atlas tool" },
    { type: "outcome", value: "Shipped" },
  ];
  const forward = extractionCueAnchors(candidates);
  const reversed = extractionCueAnchors([...candidates].reverse());

  assert.deepEqual(reversed, forward);
  assert.equal(forward?.length, 3);
  assert.deepEqual(normalizeCueAnchorInputs([{ type: "toString", value: "invalid" }]), []);
});

test("persistExtraction writes nodes with harmonic retrieval and gates cue anchors separately", async () => {
  for (const [harmonicRetrievalEnabled, abstractionAnchorsEnabled] of [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ] as const) {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-harmonic-persist-"));
    try {
      const config = parseConfig({
        openaiApiKey: "sk-test",
        memoryDir,
        workspaceDir: path.join(memoryDir, "workspace"),
        qmdEnabled: false,
        embeddingFallbackEnabled: false,
        chunkingEnabled: false,
        harmonicRetrievalEnabled,
        abstractionAnchorsEnabled,
      });
      const orchestrator = new Orchestrator(config) as unknown as PersistenceHarness;
      const storage = await orchestrator.getStorage("default");
      await storage.ensureDirectories();
      const result: ExtractionResult = {
        facts: [
          {
            category: "decision",
            content: "The Atlas project selected PostgreSQL for durable storage.",
            confidence: 0.99,
            tags: ["atlas", "storage"],
            entityRef: "atlas-project",
            cueAnchors: [{ type: "tool", value: "PostgreSQL durable storage" }],
          },
        ],
        entities: [
          {
            name: "atlas-project",
            type: "project",
            facts: ["Pending private detail."],
          },
          {
            name: "private-project",
            type: "project",
            facts: ["Unpersisted private summary."],
          },
        ],
        profileUpdates: [],
        questions: [],
        relationships: [],
        episodeTitle: "Atlas selects durable database storage",
      };
      const { persistedIds } = await orchestrator.persistExtraction(result, storage, null, {
        sessionKey: "session:harmonic-persist",
      });
      assert.ok(persistedIds.length >= 1);

      if (!harmonicRetrievalEnabled) {
        await assert.rejects(
          stat(path.join(storage.dir, "state", "abstraction-nodes")),
          (error: NodeJS.ErrnoException) => error.code === "ENOENT"
        );
        continue;
      }

      const nodeStatus = await getAbstractionNodeStoreStatus({
        memoryDir: storage.dir,
        enabled: true,
        anchorsEnabled: abstractionAnchorsEnabled,
      });
      const anchorStatus = await getCueAnchorStoreStatus({
        memoryDir: storage.dir,
        enabled: true,
        anchorsEnabled: abstractionAnchorsEnabled,
      });
      assert.equal(nodeStatus.nodes.total, 2);
      assert.equal(anchorStatus.anchors.total, abstractionAnchorsEnabled ? 2 : 0);
      const searchResults = await searchHarmonicRetrieval({
        memoryDir: storage.dir,
        query: "PostgreSQL durable storage",
        maxResults: 5,
        anchorsEnabled: abstractionAnchorsEnabled,
      });
      assert.ok(
        searchResults.some((item) =>
          persistedIds.some((persistedId) => item.node.sourceMemoryIds?.includes(persistedId))
        )
      );
      const pendingResults = await searchHarmonicRetrieval({
        memoryDir: storage.dir,
        query: "pending private detail",
        maxResults: 5,
        anchorsEnabled: abstractionAnchorsEnabled,
      });
      assert.ok(pendingResults.every((item) => !item.node.summary.includes("Pending private detail.")));
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  }
});

test("non-default namespace construction ignores the default store override", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-harmonic-namespace-"));
  try {
    const defaultStoreOverride = path.join(memoryDir, "default-harmonic-store");
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      embeddingFallbackEnabled: false,
      chunkingEnabled: false,
      namespacesEnabled: true,
      harmonicRetrievalEnabled: true,
      abstractionAnchorsEnabled: true,
      abstractionNodeStoreDir: defaultStoreOverride,
    });
    const orchestrator = new Orchestrator(config) as unknown as PersistenceHarness;
    const storage = await orchestrator.getStorage("tenant-b");
    await storage.ensureDirectories();
    const result: ExtractionResult = {
      facts: [
        {
          category: "fact",
          content: "The tenant-local release stores durable build records.",
          confidence: 0.99,
          tags: ["release"],
          cueAnchors: [{ type: "outcome", value: "tenant release records" }],
        },
      ],
      entities: [],
      profileUpdates: [],
      questions: [],
      relationships: [],
      episodeTitle: "Tenant release stores durable build records",
    };

    const { persistedIds } = await orchestrator.persistExtraction(
      result,
      storage,
      null,
      { sessionKey: "session:harmonic-tenant" },
      "tenant-b"
    );

    assert.equal(persistedIds.length, 1);
    const localStatus = await getAbstractionNodeStoreStatus({
      memoryDir: storage.dir,
      enabled: true,
      anchorsEnabled: true,
    });
    assert.ok(localStatus.nodes.total >= 1);
    await assert.rejects(stat(defaultStoreOverride), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("persistExtraction keeps the fact when harmonic storage creation fails", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-harmonic-fail-open-"));
  try {
    const blockedStorePath = path.join(memoryDir, "blocked-store");
    await writeFile(blockedStorePath, "not a directory", "utf8");
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      embeddingFallbackEnabled: false,
      chunkingEnabled: false,
      harmonicRetrievalEnabled: true,
      abstractionAnchorsEnabled: true,
      abstractionNodeStoreDir: blockedStorePath,
    });
    const orchestrator = new Orchestrator(config) as unknown as PersistenceHarness;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();
    const result: ExtractionResult = {
      facts: [
        {
          category: "fact",
          content: "The release workflow stores durable build records.",
          confidence: 0.99,
          tags: ["release"],
          cueAnchors: [{ type: "outcome", value: "release build records" }],
        },
      ],
      entities: [],
      profileUpdates: [],
      questions: [],
      relationships: [],
      episodeTitle: "Release workflow stores durable records",
    };
    const { persistedIds } = await orchestrator.persistExtraction(result, storage, null, {
      sessionKey: "session:harmonic-fail-open",
    });
    assert.equal(persistedIds.length, 1);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
