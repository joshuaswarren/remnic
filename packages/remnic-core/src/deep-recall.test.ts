/**
 * Deep-recall loop regression (issue #2332).
 *
 * The acceptance-criterion scenario: memory A and memory B share a cue
 * anchor, only A matches the query text, and B is retrieved via EXPAND.
 * The graph fixture is written through the REAL store writers
 * (recordAbstractionNode / recordCueAnchor) and read back through the
 * same readers the access service uses — no fabricated store shapes.
 * All paths are synthetic temp dirs; no operator data.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { recordAbstractionNode } from "./abstraction-nodes.js";
import { recordCueAnchor } from "./cue-anchors.js";
import { readAbstractionNodes, readCueAnchors } from "./harmonic-retrieval.js";
import {
  runBudgetedDeepRecall,
  type DeepRecallConfig,
  type DeepRecallDeps,
  type DeepRecallGraphSnapshot,
  type DeepRecallMemoryView,
} from "./deep-recall.js";
import { DEEP_RECALL_CONFIG_DEFAULTS } from "./deep-recall-config.js";

function makeConfig(overrides: Partial<DeepRecallConfig> = {}): DeepRecallConfig {
  return { ...DEEP_RECALL_CONFIG_DEFAULTS, enabled: true, ...overrides };
}

async function writeAnchorGraphFixture(memoryDir: string): Promise<void> {
  const recordedAt = "2026-08-01T00:00:00.000Z";
  await recordAbstractionNode({
    memoryDir,
    node: {
      schemaVersion: 1,
      nodeId: "node-alpha",
      recordedAt,
      sessionKey: "test-session",
      kind: "topic",
      abstractionLevel: "meso",
      title: "Alpha topic seeded by query",
      summary: "Synthetic alpha summary",
      sourceMemoryIds: ["mem-alpha"],
    },
  });
  await recordAbstractionNode({
    memoryDir,
    node: {
      schemaVersion: 1,
      nodeId: "node-beta",
      recordedAt,
      sessionKey: "test-session",
      kind: "topic",
      abstractionLevel: "meso",
      title: "Beta topic linked only by anchor",
      summary: "Synthetic beta summary",
      sourceMemoryIds: ["mem-beta"],
    },
  });
  await recordCueAnchor({
    memoryDir,
    anchor: {
      schemaVersion: 1,
      anchorId: "anchor-shared",
      anchorType: "entity",
      anchorValue: "acme+payments",
      normalizedCue: "acme payments",
      recordedAt,
      sessionKey: "test-session",
      nodeRefs: ["node-alpha", "node-beta"],
    },
  });
}

const MEMORY_STORE: DeepRecallMemoryView[] = [
  { memoryId: "mem-alpha", content: "Alpha holds the payments routing decision.", active: true },
  { memoryId: "mem-beta", content: "Beta holds the fallback processor contract.", active: true },
];

function makeDeps(options: {
  config?: Partial<DeepRecallConfig>;
  graph?: DeepRecallGraphSnapshot;
  seedHits?: Array<{ memoryId: string; score: number }>;
  script: string[];
  seedThrows?: boolean;
}): DeepRecallDeps {
  const graph = options.graph ?? { nodes: [], anchors: [] };
  return {
    config: makeConfig(options.config),
    searchSeed: async () => {
      if (options.seedThrows) throw new Error("qmd unavailable");
      return options.seedHits ?? [];
    },
    loadGraph: async () => graph,
    loadMemory: async (memoryId) =>
      MEMORY_STORE.find((memory) => memory.memoryId === memoryId) ?? null,
    callPolicy: async () => options.script.shift() ?? null,
  };
}

test("deep recall retrieves an anchor-linked memory via EXPAND when only the seed matches the query", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-deep-recall-"));
  await writeAnchorGraphFixture(memoryDir);
  const graph: DeepRecallGraphSnapshot = {
    nodes: await readAbstractionNodes({ memoryDir }),
    anchors: await readCueAnchors({ memoryDir }),
  };
  assert.equal(graph.nodes.length, 2, "fixture nodes written and read through the real store");
  assert.equal(graph.anchors.length, 1, "fixture anchor written and read through the real store");

  const result = await runBudgetedDeepRecall(
    makeDeps({
      graph,
      seedHits: [{ memoryId: "mem-alpha", score: 0.9 }],
      script: [
        JSON.stringify({ action: "EXPAND", expandNodeIds: ["node-beta"], reason: "follow the shared anchor" }),
        JSON.stringify({ action: "STOP", reason: "sufficient" }),
      ],
    }),
    "acme payments routing",
  );

  assert.equal(result.ok, true, "successful invocation is ok even though it is multi-hop");
  const beta = result.entries.find((entry) => entry.memoryId === "mem-beta");
  assert.ok(beta, "anchor-linked mem-beta is retrieved even though it never matched the query text");
  assert.equal(beta?.origin, "expand");
  assert.equal(beta?.viaAnchor, "acme+payments");
  assert.ok(Math.abs((beta?.score ?? 0) - 0.9 * 0.8) < 1e-9, "expansion inherits parent score * 0.8");
  const alpha = result.entries.find((entry) => entry.memoryId === "mem-alpha");
  assert.ok(alpha, "seeded mem-alpha stays in the working set");
  assert.equal(alpha?.origin, "seed");
  assert.equal(result.trace[0]?.action, "EXPAND");
  assert.equal(result.trace[result.trace.length - 1]?.action, "STOP");
  assert.ok(result.trace.every((step) => step.durationMs >= 0), "every trace step records telemetry");
});

test("deep recall distinguishes a seed backend failure from an empty store", async () => {
  const failure = await runBudgetedDeepRecall(
    makeDeps({ script: [], seedThrows: true }),
    "anything",
  );
  assert.equal(failure.ok, false, "backend failure is ok:false");
  assert.equal(failure.error, "backend_unavailable");

  const empty = await runBudgetedDeepRecall(makeDeps({ script: [] }), "anything");
  assert.equal(empty.ok, true, "empty stores are ok:true with empty entries");
  assert.deepEqual(empty.entries, []);
});
