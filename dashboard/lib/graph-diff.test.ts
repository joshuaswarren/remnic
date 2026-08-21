import test from "node:test";
import assert from "node:assert/strict";
import { diffGraphSnapshots } from "./graph-diff.js";
import type { GraphSnapshot } from "./graph-parser.js";

test("diffGraphSnapshots detects added and removed nodes/edges", () => {
  const previous: GraphSnapshot = {
    generatedAt: "2026-02-28T00:00:00.000Z",
    nodes: [{ id: "a" }, { id: "b" }],
    edges: [
      {
        from: "a",
        to: "b",
        type: "entity",
        weight: 1,
        label: "x",
        ts: "2026-02-28T00:00:00.000Z",
      },
    ],
    stats: { nodes: 2, edges: 1, malformedLines: 0, filesMissing: [] },
  };
  const next: GraphSnapshot = {
    generatedAt: "2026-02-28T00:01:00.000Z",
    nodes: [{ id: "b" }, { id: "c" }],
    edges: [
      {
        from: "b",
        to: "c",
        type: "time",
        weight: 1,
        label: "thread",
        ts: "2026-02-28T00:01:00.000Z",
      },
    ],
    stats: { nodes: 2, edges: 1, malformedLines: 0, filesMissing: [] },
  };

  const patch = diffGraphSnapshots(previous, next);
  assert.deepEqual(patch.addedNodes, ["c"]);
  assert.deepEqual(patch.removedNodes, ["a"]);
  assert.equal(patch.addedEdges.length, 1);
  assert.equal(patch.removedEdges.length, 1);
});

