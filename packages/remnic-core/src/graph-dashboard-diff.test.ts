import assert from "node:assert/strict";
import test from "node:test";

import type { GraphEdge } from "./graph.js";
import type { GraphSnapshot } from "./graph-dashboard-parser.js";
import { diffGraphSnapshots } from "./graph-dashboard-diff.js";

function snapshot(edges: GraphEdge[]): GraphSnapshot {
  return {
    generatedAt: "2026-05-21T00:00:00.000Z",
    nodes: [{ id: "a" }, { id: "b" }],
    edges,
    stats: { nodes: 2, edges: edges.length, malformedLines: 0, filesMissing: [] },
  };
}

test("diffGraphSnapshots emits updatedEdges when existing edge confidence changes", () => {
  const previousEdge: GraphEdge = {
    type: "entity",
    from: "facts/a.md",
    to: "facts/b.md",
    label: "person:alex",
    ts: "2026-05-21T00:00:00.000Z",
    weight: 1,
    confidence: 1,
  };
  const nextEdge: GraphEdge = {
    ...previousEdge,
    confidence: 0.4,
    lastReinforcedAt: "2026-05-21T01:00:00.000Z",
  };

  const patch = diffGraphSnapshots(snapshot([previousEdge]), snapshot([nextEdge]));

  assert.equal(patch.addedEdges.length, 0);
  assert.equal(patch.removedEdges.length, 0);
  assert.deepEqual(patch.updatedEdges, [{ previous: previousEdge, next: nextEdge }]);
});

test("diffGraphSnapshots treats missing confidence as legacy confidence one", () => {
  const previousEdge: GraphEdge = {
    type: "entity",
    from: "facts/a.md",
    to: "facts/b.md",
    label: "person:alex",
    ts: "2026-05-21T00:00:00.000Z",
    weight: 1,
  };
  const nextEdge: GraphEdge = {
    ...previousEdge,
    confidence: 1,
  };

  const patch = diffGraphSnapshots(snapshot([previousEdge]), snapshot([nextEdge]));

  assert.equal(patch.updatedEdges.length, 0);
});
