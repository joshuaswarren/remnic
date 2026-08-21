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

test("deep recall enforces the total timeout on pre-policy work, not only before policy calls", async () => {
  // A seed search that never settles used to block the loop forever: the
  // deadline was merely CHECKED before the first policy call, so the check
  // never ran. The invocation must end inside totalTimeoutMs with the partial
  // (here empty) working set and a BUDGET_EXHAUSTED tail.
  const startedMs = Date.now();
  const result = await runBudgetedDeepRecall(
    {
      config: makeConfig({ totalTimeoutMs: 25 }),
      searchSeed: () => Promise.withResolvers<never>().promise,
      loadGraph: async () => ({ nodes: [], anchors: [] }),
      loadMemory: async () => null,
      callPolicy: async () => {
        throw new Error("the policy must never be called after the deadline expires");
      },
    },
    "a query whose seed search stalls",
  );
  assert.equal(result.ok, true, "a timeout is partial, not a backend failure");
  assert.deepEqual(result.entries, []);
  assert.equal(result.trace.at(-1)?.action, "BUDGET_EXHAUSTED");
  assert.ok(
    Date.now() - startedMs < 5000,
    "the invocation returns on the deadline instead of awaiting a stalled dependency",
  );
});

test("deep recall keeps the overall deadline when the per-step timeout is disabled", async () => {
  // stepTimeoutMs: 0 disables only its own axis (§33). A finite totalTimeoutMs
  // must still reach the policy call, otherwise a slow call runs unbounded.
  const budgets: number[] = [];
  const withTotalOnly = await runBudgetedDeepRecall(
    {
      config: makeConfig({ maxSteps: 1, stepTimeoutMs: 0, totalTimeoutMs: 5000 }),
      searchSeed: async () => [],
      loadGraph: async () => ({ nodes: [], anchors: [] }),
      loadMemory: async () => null,
      callPolicy: async (_prompt, timeoutMs) => {
        budgets.push(timeoutMs);
        return JSON.stringify({ action: "STOP", reason: "done" });
      },
    },
    "a query with only a total budget",
  );
  assert.equal(withTotalOnly.ok, true);
  assert.equal(budgets.length, 1);
  assert.ok(
    (budgets[0] ?? 0) > 0 && (budgets[0] ?? 0) <= 5000,
    `the remaining total budget must reach the policy call, got ${budgets[0]}`,
  );

  // Both axes disabled is the only "no timeout" case.
  budgets.length = 0;
  await runBudgetedDeepRecall(
    {
      config: makeConfig({ maxSteps: 1, stepTimeoutMs: 0, totalTimeoutMs: 0 }),
      searchSeed: async () => [],
      loadGraph: async () => ({ nodes: [], anchors: [] }),
      loadMemory: async () => null,
      callPolicy: async (_prompt, timeoutMs) => {
        budgets.push(timeoutMs);
        return JSON.stringify({ action: "STOP", reason: "done" });
      },
    },
    "a query with no budget at all",
  );
  assert.equal(budgets[0], 0, "both axes disabled means no timeout");
});
