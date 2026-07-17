import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { type GraphConfig, type GraphEdge, GraphIndex, graphFilePath, readEdges } from "./graph.js";

function makeGraphConfig(): GraphConfig {
  return {
    multiGraphMemoryEnabled: true,
    entityGraphEnabled: true,
    timeGraphEnabled: false,
    causalGraphEnabled: false,
    maxGraphTraversalSteps: 2,
    graphActivationDecay: 0.5,
    maxEntityGraphEdgesPerMemory: 10,
    graphLateralInhibitionEnabled: false,
    graphLateralInhibitionBeta: 0,
    graphLateralInhibitionTopM: 0,
    graphTraversalConfidenceFloor: 0.2,
    graphTraversalPageRankIterations: 0,
    graphEdgeCacheIncrementalEnabled: true,
  };
}

test("graph reads skip malformed JSON edge objects before traversal", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-malformed-"));
  try {
    const filePath = graphFilePath(memoryDir, "entity");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      [
        JSON.stringify({
          from: "a",
          type: "entity",
          weight: 1,
          label: "broken",
          ts: "2026-01-01T00:00:00.000Z",
        }),
        JSON.stringify({
          from: "a",
          to: "c",
          type: "entity",
          weight: 1,
          label: "valid",
          ts: "2026-01-01T00:00:00.000Z",
        }),
        "",
      ].join("\n"),
      "utf-8"
    );

    const edges = await readEdges(memoryDir, "entity");
    assert.deepEqual(
      edges.map((edge) => edge.to),
      ["c"]
    );

    const graph = new GraphIndex(memoryDir, makeGraphConfig());
    const activated = await graph.spreadingActivation(["a"]);
    assert.deepEqual(
      activated.map((candidate) => candidate.path),
      ["c"]
    );
    assert.equal(Number.isFinite(activated[0]?.score), true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("spreadingActivation propagates accumulated activation from multiple seeds", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-multi-seed-"));
  try {
    await writeGraphEdges(memoryDir, [
      makeEdge("seed-a", "shared"),
      makeEdge("seed-b", "shared"),
      makeEdge("shared", "downstream"),
    ]);

    const graph = new GraphIndex(memoryDir, makeGraphConfig());
    const activated = await graph.spreadingActivation(["seed-a", "seed-b"]);
    const scores = new Map(activated.map((candidate) => [candidate.path, candidate.score]));

    assert.equal(scores.get("shared"), 1);
    assert.equal(scores.get("downstream"), 0.5);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("spreadingActivation propagates same-depth alternate path activation", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-alt-path-"));
  try {
    await writeGraphEdges(memoryDir, [
      makeEdge("seed", "left"),
      makeEdge("seed", "right"),
      makeEdge("left", "shared"),
      makeEdge("right", "shared"),
      makeEdge("shared", "downstream"),
    ]);

    const graph = new GraphIndex(memoryDir, {
      ...makeGraphConfig(),
      maxGraphTraversalSteps: 3,
    });
    const activated = await graph.spreadingActivation(["seed"]);
    const scores = new Map(activated.map((candidate) => [candidate.path, candidate.score]));

    assert.equal(scores.get("left"), 0.5);
    assert.equal(scores.get("right"), 0.5);
    assert.equal(scores.get("shared"), 0.5);
    assert.equal(scores.get("downstream"), 0.25);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

function makeEdge(from: string, to: string): GraphEdge {
  return {
    from,
    to,
    type: "entity",
    weight: 1,
    label: "test",
    ts: "2026-01-01T00:00:00.000Z",
  };
}

async function writeGraphEdges(memoryDir: string, edges: GraphEdge[]): Promise<void> {
  const filePath = graphFilePath(memoryDir, "entity");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${edges.map((edge) => JSON.stringify(edge)).join("\n")}\n`, "utf-8");
}
