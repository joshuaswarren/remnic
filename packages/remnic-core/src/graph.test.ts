import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import {
  GraphIndex,
  graphFilePath,
  readEdges,
  type GraphConfig,
} from "./graph.js";

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
      "utf-8",
    );

    const edges = await readEdges(memoryDir, "entity");
    assert.deepEqual(edges.map((edge) => edge.to), ["c"]);

    const graph = new GraphIndex(memoryDir, makeGraphConfig());
    const activated = await graph.spreadingActivation(["a"]);
    assert.deepEqual(activated.map((candidate) => candidate.path), ["c"]);
    assert.equal(Number.isFinite(activated[0]?.score), true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
