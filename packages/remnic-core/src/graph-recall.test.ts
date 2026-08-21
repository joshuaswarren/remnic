import assert from "node:assert/strict";
import test from "node:test";

import {
  type GraphRecallConfig,
  type GraphRecallOptions,
  runGraphRecall,
} from "./graph-recall.js";
import { mergeGraphExpandedResults } from "./orchestration/graph-recall-coordinator.js";
import type { MemoryEdgeSource } from "./graph-retrieval.js";

test("mergeGraphExpandedResults preserves same paths from different namespaces", () => {
  const merged = mergeGraphExpandedResults(
    [
      {
        docid: "default-memory",
        path: "facts/same-id.md",
        namespace: "default",
        snippet: "default",
        score: 0.8,
      },
      {
        docid: "project-memory",
        path: "facts/same-id.md",
        namespace: "project-x",
        snippet: "project",
        score: 0.7,
      },
    ],
    [],
  );

  assert.deepEqual(
    merged.map((result) => [result.namespace, result.path]),
    [
      ["default", "facts/same-id.md"],
      ["project-x", "facts/same-id.md"],
    ],
  );
});

const DEFAULT_CONFIG: GraphRecallConfig = {
  recallGraphEnabled: true,
  recallGraphDamping: 0.85,
  recallGraphIterations: 20,
  recallGraphTopK: 50,
};

function disabledConfig(): GraphRecallConfig {
  return { ...DEFAULT_CONFIG, recallGraphEnabled: false };
}

function sampleMemories(): MemoryEdgeSource[] {
  return [
    { id: "m1", entityRef: "person:Jane" },
    { id: "m2", entityRef: "person:Jane" },
    { id: "m3", lineage: ["m1"], entityRefs: ["person:Jane", "org:Acme"] },
    { id: "m4", supersedes: "m3" },
    { id: "m5", entityRef: "org:Acme" },
  ];
}

test("runGraphRecall short-circuits when recallGraphEnabled=false", () => {
  const run = runGraphRecall(disabledConfig(), {
    memories: sampleMemories(),
    seedIds: ["m1"],
  });
  assert.equal(run.ran, false);
  assert.equal(run.reason, "disabled");
  assert.equal(run.results.length, 0);
  assert.equal(run.graph, null);
});

test("runGraphRecall short-circuits when recallGraphTopK<=0", () => {
  for (const topK of [0, -1]) {
    const cfg: GraphRecallConfig = { ...DEFAULT_CONFIG, recallGraphTopK: topK };
    const run = runGraphRecall(cfg, {
      memories: sampleMemories(),
      seedIds: ["m1"],
    });
    assert.equal(run.ran, false);
    assert.equal(run.reason, "topk-zero");
    assert.equal(run.results.length, 0);
    assert.equal(run.graph, null);
  }
});

test("runGraphRecall short-circuits when memory pool is empty", () => {
  const run = runGraphRecall(DEFAULT_CONFIG, {
    memories: [],
    seedIds: ["m1"],
  });
  assert.equal(run.ran, false);
  assert.equal(run.reason, "empty-input");
});

test("runGraphRecall returns memory-typed results only", () => {
  const run = runGraphRecall(DEFAULT_CONFIG, {
    memories: sampleMemories(),
    seedIds: ["m1"],
  });
  assert.equal(run.ran, true);
  assert.equal(run.reason, "ran");
  assert.ok(run.graph !== null);
  for (const r of run.results) {
    assert.equal(run.graph!.nodes.get(r.id)?.type, "memory");
  }
  assert.ok(run.results.length > 0);
  assert.equal(run.results[0]?.id, "m1");
});

test("runGraphRecall respects recallGraphTopK after projection", () => {
  const chain: MemoryEdgeSource[] = [
    { id: "m1" },
    { id: "m2", supersedes: "m1" },
    { id: "m3", supersedes: "m2" },
    { id: "m4", supersedes: "m3" },
  ];
  const cfg: GraphRecallConfig = { ...DEFAULT_CONFIG, recallGraphTopK: 2 };
  const run = runGraphRecall(cfg, {
    memories: chain,
    seedIds: ["m4"],
  });
  assert.equal(run.ran, true);
  assert.equal(run.results.length, 2);
});

test("runGraphRecall threads damping + iteration cap through to PPR", () => {
  const cfg: GraphRecallConfig = {
    ...DEFAULT_CONFIG,
    recallGraphDamping: 0.5,
    recallGraphIterations: 5,
  };
  const run = runGraphRecall(cfg, {
    memories: sampleMemories(),
    seedIds: ["m1"],
  });
  assert.ok(run.iterations <= 5, `expected <= 5 iterations, got ${run.iterations}`);
});

test("runGraphRecall uniform-fallback when seed ids are empty", () => {
  const run = runGraphRecall(DEFAULT_CONFIG, {
    memories: sampleMemories(),
    seedIds: [],
  });
  assert.equal(run.ran, true);
  assert.ok(run.results.length > 0);
  for (const r of run.results) {
    assert.equal(run.graph!.nodes.get(r.id)?.type, "memory");
  }
});

test("runGraphRecall accepts seedWeights and biases ranking accordingly", () => {
  const weightedM1 = runGraphRecall(DEFAULT_CONFIG, {
    memories: sampleMemories(),
    seedIds: ["m1", "m2"],
    seedWeights: { m1: 0.9, m2: 0.1 },
  });
  const weightedM2 = runGraphRecall(DEFAULT_CONFIG, {
    memories: sampleMemories(),
    seedIds: ["m1", "m2"],
    seedWeights: { m1: 0.1, m2: 0.9 },
  });

  const m1_scoreA = weightedM1.results.find((r) => r.id === "m1")?.score ?? 0;
  const m2_scoreA = weightedM1.results.find((r) => r.id === "m2")?.score ?? 0;
  const m1_scoreB = weightedM2.results.find((r) => r.id === "m1")?.score ?? 0;
  const m2_scoreB = weightedM2.results.find((r) => r.id === "m2")?.score ?? 0;

  assert.ok(m1_scoreA > m1_scoreB, "m1 should rank higher when weighted on m1");
  assert.ok(m2_scoreB > m2_scoreA, "m2 should rank higher when weighted on m2");
});

test("runGraphRecall is deterministic", () => {
  const memories = sampleMemories();
  const seedIds = ["m1"];
  const r1 = runGraphRecall(DEFAULT_CONFIG, { memories, seedIds });
  const r2 = runGraphRecall(DEFAULT_CONFIG, { memories, seedIds });
  assert.deepEqual(r1.results, r2.results);
});

test("runGraphRecall default-off: disabled config with defaults does nothing", () => {
  const defaults: GraphRecallConfig = {
    recallGraphEnabled: false,
    recallGraphDamping: 0.85,
    recallGraphIterations: 20,
    recallGraphTopK: 50,
  };
  const run = runGraphRecall(defaults, {
    memories: sampleMemories(),
    seedIds: ["m1"],
  });
  assert.equal(run.ran, false);
  assert.equal(run.reason, "disabled");
});
