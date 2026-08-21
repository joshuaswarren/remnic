import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PPR_DAMPING,
  DEFAULT_PPR_ITERATIONS,
  DEFAULT_PPR_TOLERANCE,
  type EdgeType,
  type MemoryEdgeSource,
  type NodeType,
  type QueryGraphResult,
  type RemnicGraph,
  type RemnicGraphEdge,
  type RemnicGraphNode,
  buildGraphFromMemories,
  extractGraphEdges,
  isEdgeType,
  isNodeType,
  queryGraph,
} from "./graph-retrieval.js";

test("RemnicGraph can be constructed with nodes and edges", () => {
  const nodes = new Map<string, RemnicGraphNode>();
  nodes.set("m1", { id: "m1", type: "memory" });
  nodes.set("e1", { id: "e1", type: "entity", weight: 0.8 });

  const edges: RemnicGraphEdge[] = [
    { from: "m1", to: "e1", type: "mentions" },
    { from: "m1", to: "e1", type: "authored-by", weight: 0.5 },
  ];

  const graph: RemnicGraph = { nodes, edges };

  assert.equal(graph.nodes.size, 2);
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.nodes.get("m1")?.type, "memory");
  assert.equal(graph.nodes.get("e1")?.weight, 0.8);
  assert.equal(graph.edges[0]?.type, "mentions");
  assert.equal(graph.edges[1]?.weight, 0.5);
});

test("RemnicGraphNode weight is optional (undefined is valid)", () => {
  const node: RemnicGraphNode = { id: "m1", type: "memory" };
  assert.equal(node.weight, undefined);
});

test("RemnicGraphEdge weight is optional (undefined is valid)", () => {
  const edge: RemnicGraphEdge = { from: "a", to: "b", type: "related-to" };
  assert.equal(edge.weight, undefined);
});

test("nodes can be added and retrieved after construction", () => {
  const graph: RemnicGraph = { nodes: new Map(), edges: [] };
  graph.nodes.set("mem-1", { id: "mem-1", type: "memory" });
  graph.edges.push({ from: "mem-1", to: "mem-2", type: "supersedes" });

  assert.equal(graph.nodes.size, 1);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0]?.type, "supersedes");
});

test("queryGraph returns an empty ranked list for an empty graph", () => {
  const graph: RemnicGraph = { nodes: new Map(), edges: [] };
  const result: QueryGraphResult = queryGraph(graph, []);
  assert.deepEqual(result.rankedNodes, []);
  assert.equal(result.iterations, 0);
  assert.equal(result.converged, true);
});

test("queryGraph ranks a tiny two-node graph with the seeded node higher", () => {
  const nodes = new Map<string, RemnicGraphNode>();
  nodes.set("m1", { id: "m1", type: "memory" });
  nodes.set("m2", { id: "m2", type: "memory" });
  const graph: RemnicGraph = {
    nodes,
    edges: [{ from: "m1", to: "m2", type: "references" }],
  };

  const result = queryGraph(graph, ["m1"], { topK: 10 });
  assert.ok(result.rankedNodes.length > 0);
  // m1 should rank highest (seeded + receives no inbound edges).
  assert.equal(result.rankedNodes[0]?.id, "m1");
});

test("queryGraph tolerates seed ids not present in the graph", () => {
  const graph: RemnicGraph = { nodes: new Map(), edges: [] };
  const result = queryGraph(graph, ["does-not-exist", "also-missing"], {});
  assert.deepEqual(result.rankedNodes, []);
});

test("isNodeType accepts every documented node type", () => {
  const expected: NodeType[] = [
    "memory",
    "entity",
    "episode",
    "concept",
    "reflection",
  ];
  for (const t of expected) {
    assert.equal(isNodeType(t), true, `expected ${t} to be a NodeType`);
  }
});

test("isNodeType rejects unknown values", () => {
  assert.equal(isNodeType("fact"), false);
  assert.equal(isNodeType(""), false);
  assert.equal(isNodeType(null), false);
  assert.equal(isNodeType(undefined), false);
  assert.equal(isNodeType(42), false);
  assert.equal(isNodeType({ type: "memory" }), false);
});

test("isEdgeType accepts every documented edge type", () => {
  const expected: EdgeType[] = [
    "references",
    "supersedes",
    "authored-by",
    "mentions",
    "derived-from",
    "temporal-next",
    "related-to",
  ];
  for (const t of expected) {
    assert.equal(isEdgeType(t), true, `expected ${t} to be an EdgeType`);
  }
});

test("isEdgeType rejects unknown values", () => {
  assert.equal(isEdgeType("points-to"), false);
  assert.equal(isEdgeType(""), false);
  assert.equal(isEdgeType(null), false);
  assert.equal(isEdgeType(undefined), false);
  assert.equal(isEdgeType(0), false);
  assert.equal(isEdgeType({ type: "references" }), false);
});

// ---------------------------------------------------------------------------
// Edge extraction (PR 2)
// ---------------------------------------------------------------------------

test("extractGraphEdges returns empty result for empty input", () => {
  const { nodes, edges } = extractGraphEdges([]);
  assert.equal(nodes.size, 0);
  assert.equal(edges.length, 0);
});

test("extractGraphEdges registers a memory node per input", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m1" },
    { id: "m2" },
    { id: "m3" },
  ];
  const { nodes, edges } = extractGraphEdges(memories);
  assert.equal(nodes.size, 3);
  assert.equal(nodes.get("m1")?.type, "memory");
  assert.equal(nodes.get("m2")?.type, "memory");
  assert.equal(nodes.get("m3")?.type, "memory");
  assert.equal(edges.length, 0);
});

test("extractGraphEdges produces a supersedes edge when target is known", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m-new", supersedes: "m-old" },
    { id: "m-old" },
  ];
  const { edges } = extractGraphEdges(memories);
  assert.equal(edges.length, 1);
  assert.deepEqual(edges[0], { from: "m-new", to: "m-old", type: "supersedes" });
});

test("extractGraphEdges skips dangling supersedes unless includeDanglingEdges is set", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m-new", supersedes: "m-missing" },
  ];
  const skipped = extractGraphEdges(memories);
  assert.equal(skipped.edges.length, 0);

  const kept = extractGraphEdges(memories, { includeDanglingEdges: true });
  assert.equal(kept.edges.length, 1);
  assert.equal(kept.edges[0]?.type, "supersedes");
  assert.equal(kept.nodes.get("m-missing")?.type, "memory");
});

test("extractGraphEdges emits derived-from edges from lineage and derived_from", () => {
  const memories: MemoryEdgeSource[] = [
    {
      id: "m-child",
      lineage: ["m-parent-1"],
      derived_from: ["m-parent-2:3", "m-parent-3"],
    },
    { id: "m-parent-1" },
    { id: "m-parent-2" },
    { id: "m-parent-3" },
  ];
  const { edges } = extractGraphEdges(memories);
  const derived = edges.filter((e) => e.type === "derived-from");
  assert.equal(derived.length, 3);
  const targets = derived.map((e) => e.to).sort();
  assert.deepEqual(targets, ["m-parent-1", "m-parent-2", "m-parent-3"]);
});

test("extractGraphEdges strips trailing :<version> only when numeric", () => {
  const memories: MemoryEdgeSource[] = [
    {
      id: "m-child",
      derived_from: ["facts/preferences.md:7", "entity:person:Jane"],
    },
    { id: "facts/preferences.md" },
    { id: "entity:person:Jane" },
  ];
  const { edges } = extractGraphEdges(memories);
  const derived = edges.filter((e) => e.type === "derived-from").map((e) => e.to).sort();
  assert.deepEqual(derived, ["entity:person:Jane", "facts/preferences.md"]);
});

test("extractGraphEdges dedupes identical edges from overlapping lineage and derived_from", () => {
  const memories: MemoryEdgeSource[] = [
    {
      id: "m-child",
      lineage: ["m-parent"],
      derived_from: ["m-parent:1", "m-parent:2"],
    },
    { id: "m-parent" },
  ];
  const { edges } = extractGraphEdges(memories);
  const derived = edges.filter((e) => e.type === "derived-from");
  assert.equal(derived.length, 1);
});

test("extractGraphEdges creates entity nodes and mentions edges from entityRef / entityRefs", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m1", entityRef: "person:Jane" },
    { id: "m2", entityRefs: ["person:Jane", "org:Acme"] },
  ];
  const { nodes, edges } = extractGraphEdges(memories);
  assert.equal(nodes.get("person:Jane")?.type, "entity");
  assert.equal(nodes.get("org:Acme")?.type, "entity");

  const mentions = edges.filter((e) => e.type === "mentions");
  assert.equal(mentions.length, 3);
  const pairs = mentions.map((e) => `${e.from}->${e.to}`).sort();
  assert.deepEqual(pairs, [
    "m1->person:Jane",
    "m2->org:Acme",
    "m2->person:Jane",
  ]);
});

test("extractGraphEdges parses inline [Source: agent=...] blocks into authored-by edges", () => {
  const memories: MemoryEdgeSource[] = [
    {
      id: "m1",
      content: "Fact body. [Source: agent=planner, session=abc, ts=2026-04-10T14:25:07Z]",
    },
    {
      id: "m2",
      content: "Multi-citation [Source: agent=extractor] and [Source: agent=judge]",
    },
  ];
  const { nodes, edges } = extractGraphEdges(memories);
  const authored = edges.filter((e) => e.type === "authored-by");
  const pairs = authored.map((e) => `${e.from}->${e.to}`).sort();
  assert.deepEqual(pairs, [
    "m1->agent:planner",
    "m2->agent:extractor",
    "m2->agent:judge",
  ]);
  assert.equal(nodes.get("agent:planner")?.type, "entity");
  assert.equal(nodes.get("agent:extractor")?.type, "entity");
  assert.equal(nodes.get("agent:judge")?.type, "entity");
});

test("extractGraphEdges ignores malformed citations with no agent field", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m1", content: "[Source: session=abc, ts=2026-01-01T00:00:00Z]" },
    { id: "m2", content: "[Source:]" },
    { id: "m3", content: "[Source: agent=]" },
  ];
  const { edges } = extractGraphEdges(memories);
  assert.equal(edges.filter((e) => e.type === "authored-by").length, 0);
});

test("extractGraphEdges does not emit self-loops", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m1", supersedes: "m1", lineage: ["m1"], derived_from: ["m1:1"] },
  ];
  const { edges } = extractGraphEdges(memories);
  assert.equal(edges.length, 0);
});

test("extractGraphEdges is deterministic across invocations", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m-a", lineage: ["m-b", "m-c"], entityRefs: ["x", "y"] },
    { id: "m-b" },
    { id: "m-c" },
    { id: "m-d", supersedes: "m-a", content: "[Source: agent=alpha]" },
  ];
  const first = extractGraphEdges(memories);
  const second = extractGraphEdges(memories);
  assert.deepEqual(first.edges, second.edges);
  assert.deepEqual([...first.nodes.keys()], [...second.nodes.keys()]);
});

test("extractGraphEdges returns a realistic 8-memory fixture end-to-end", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m1", entityRef: "person:Jane" },
    { id: "m2", entityRef: "person:Jane", content: "[Source: agent=extractor]" },
    { id: "m3", lineage: ["m1", "m2"], entityRefs: ["person:Jane", "org:Acme"] },
    { id: "m4", supersedes: "m3", derived_from: ["m3:1"] },
    { id: "m5", entityRef: "org:Acme", content: "[Source: agent=judge]" },
    { id: "m6", lineage: ["m4"], entityRefs: ["person:Bob"] },
    { id: "m7", derived_from: ["m6:2"] },
    { id: "m8" },
  ];
  const { nodes, edges } = extractGraphEdges(memories);

  // 8 memory nodes + 3 distinct entities + 2 distinct agents = 13 nodes.
  assert.equal(nodes.size, 13);
  const memoryNodes = [...nodes.values()].filter((n) => n.type === "memory");
  assert.equal(memoryNodes.length, 8);
  const entityNodes = [...nodes.values()].filter((n) => n.type === "entity");
  assert.equal(entityNodes.length, 5);

  // Count edges by type for clarity.
  const counts: Record<string, number> = {};
  for (const e of edges) counts[e.type] = (counts[e.type] ?? 0) + 1;
  // m4 → m3 supersedes
  assert.equal(counts["supersedes"], 1);
  // m3 lineage → m1, m2 (2); m4 derived_from m3:1 → m3 (1); m6 lineage → m4 (1);
  // m7 derived_from m6:2 → m6 (1). Total: 5 derived-from edges.
  assert.equal(counts["derived-from"], 5);
  // m1→Jane, m2→Jane, m3→Jane, m3→Acme, m5→Acme, m6→Bob = 6 mentions.
  assert.equal(counts["mentions"], 6);
  // m2 → agent:extractor; m5 → agent:judge = 2 authored-by.
  assert.equal(counts["authored-by"], 2);
});

test("buildGraphFromMemories wraps extractGraphEdges into a RemnicGraph", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m1", entityRef: "person:Jane" },
    { id: "m2", supersedes: "m1" },
  ];
  const graph: RemnicGraph = buildGraphFromMemories(memories);
  assert.ok(graph.nodes instanceof Map);
  assert.ok(Array.isArray(graph.edges));
  assert.equal(graph.nodes.size, 3); // m1, m2, person:Jane
  assert.equal(graph.edges.length, 2); // m1→Jane mentions, m2→m1 supersedes
});

test("extractGraphEdges rejects type mismatch: supersedes points at entity, not memory", () => {
  // memory-A carries entityRef "shared-id" (creates an entity node).
  // memory-B carries supersedes: "shared-id" — must NOT emit the edge,
  // because the only existing "shared-id" node is an entity, not a memory.
  const memories: MemoryEdgeSource[] = [
    { id: "m-A", entityRef: "shared-id" },
    { id: "m-B", supersedes: "shared-id" },
  ];
  const { edges } = extractGraphEdges(memories);
  assert.equal(edges.filter((e) => e.type === "supersedes").length, 0);
  // The mention edge must still fire.
  assert.equal(edges.filter((e) => e.type === "mentions").length, 1);
});

test("extractGraphEdges is order-independent with includeDanglingEdges=true (Codex P2)", () => {
  // With dangling edges enabled, the order in which the extractor
  // encounters `{supersedes: "shared"}` vs `{entityRef: "shared"}`
  // must NOT change the output. In both orderings, the entity mention
  // claims the id so the supersedes edge is rejected and the mentions
  // edge fires.
  const forward: MemoryEdgeSource[] = [
    { id: "m-A", supersedes: "shared" },
    { id: "m-B", entityRef: "shared" },
  ];
  const reverse: MemoryEdgeSource[] = [
    { id: "m-B", entityRef: "shared" },
    { id: "m-A", supersedes: "shared" },
  ];

  const fwd = extractGraphEdges(forward, { includeDanglingEdges: true });
  const rev = extractGraphEdges(reverse, { includeDanglingEdges: true });

  // Same number of edges of each type in both orderings.
  const count = (edges: typeof fwd.edges) =>
    edges.reduce<Record<string, number>>((acc, e) => {
      acc[e.type] = (acc[e.type] ?? 0) + 1;
      return acc;
    }, {});
  assert.deepEqual(count(fwd.edges), count(rev.edges));
  // In both orderings the supersedes edge is rejected (entity claimed).
  assert.equal(fwd.edges.filter((e) => e.type === "supersedes").length, 0);
  assert.equal(rev.edges.filter((e) => e.type === "supersedes").length, 0);
  // And the entity / mention pair survives.
  assert.equal(fwd.nodes.get("shared")?.type, "entity");
  assert.equal(rev.nodes.get("shared")?.type, "entity");
});

test("extractGraphEdges type-mismatch guard applies even with includeDanglingEdges=true", () => {
  // Fresh evidence: with dangling edges enabled, the guard must still
  // reject memory → entity cross-type references. The entity node for
  // "shared-id" is created first via m-A's entityRef; m-B's supersedes
  // reference must NOT overwrite or attach to that entity node.
  const memories: MemoryEdgeSource[] = [
    { id: "m-A", entityRef: "shared-id" },
    { id: "m-B", supersedes: "shared-id", lineage: ["shared-id"] },
    { id: "m-C", derived_from: ["shared-id:1"] },
  ];
  const { nodes, edges } = extractGraphEdges(memories, { includeDanglingEdges: true });
  assert.equal(edges.filter((e) => e.type === "supersedes").length, 0);
  assert.equal(edges.filter((e) => e.type === "derived-from").length, 0);
  // The shared id remains an entity node, not promoted to memory.
  assert.equal(nodes.get("shared-id")?.type, "entity");
});

test("extractGraphEdges rejects type mismatch: derived-from points at entity, not memory", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m-A", entityRef: "shared-id" },
    { id: "m-B", lineage: ["shared-id"] },
    { id: "m-C", derived_from: ["shared-id:1"] },
  ];
  const { edges } = extractGraphEdges(memories);
  assert.equal(edges.filter((e) => e.type === "derived-from").length, 0);
});

test("extractGraphEdges drops mentions edge when target id collides with an existing memory", () => {
  // A memory with id "person:Jane" collides with a downstream entityRef
  // "person:Jane". The existing node stays a memory; the mentions edge
  // is dropped rather than retyping the node. This preserves the
  // extractor's typed-node contract.
  const memories: MemoryEdgeSource[] = [
    { id: "person:Jane" },
    { id: "m-A", entityRef: "person:Jane" },
  ];
  const { nodes, edges } = extractGraphEdges(memories);
  assert.equal(nodes.get("person:Jane")?.type, "memory");
  assert.equal(edges.filter((e) => e.type === "mentions").length, 0);
});

test("extractGraphEdges drops authored-by edge when agent id collides with an existing memory", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "agent:planner" },
    { id: "m-A", content: "[Source: agent=planner]" },
  ];
  const { nodes, edges } = extractGraphEdges(memories);
  assert.equal(nodes.get("agent:planner")?.type, "memory");
  assert.equal(edges.filter((e) => e.type === "authored-by").length, 0);
});

test("extractGraphEdges lowercases citation keys (case-insensitive match)", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m1", content: "[Source: Agent=Planner, SESSION=abc]" },
    { id: "m2", content: "[source: agent=judge]" },
  ];
  const { edges } = extractGraphEdges(memories);
  const authored = edges.filter((e) => e.type === "authored-by");
  const pairs = authored.map((e) => `${e.from}->${e.to}`).sort();
  assert.deepEqual(pairs, ["m1->agent:Planner", "m2->agent:judge"]);
});

test("extractGraphEdges skips memories with no id", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m1" },
    { id: "", supersedes: "m1" } as MemoryEdgeSource,
    { id: "m2", lineage: ["m1"] },
  ];
  const { nodes, edges } = extractGraphEdges(memories);
  assert.equal(nodes.size, 2);
  assert.ok(!nodes.has(""));
  assert.equal(edges.length, 1); // m2 → m1 derived-from only
  assert.equal(edges[0]?.type, "derived-from");
});

// ---------------------------------------------------------------------------
// Personalized PageRank (PR 3)
// ---------------------------------------------------------------------------

/**
 * Helper — build a `RemnicGraph` from parallel node / edge arrays. Keeps
 * the PPR tests readable without repeating Map construction.
 */
function buildGraph(
  nodeIds: readonly string[],
  edges: readonly [from: string, to: string, weight?: number][],
): RemnicGraph {
  const nodes = new Map<string, RemnicGraphNode>();
  for (const id of nodeIds) nodes.set(id, { id, type: "memory" });
  const edgeList: RemnicGraphEdge[] = edges.map(([from, to, weight]) => ({
    from,
    to,
    type: "references" as const,
    ...(weight !== undefined ? { weight } : {}),
  }));
  return { nodes, edges: edgeList };
}

test("PPR defaults match the documented values", () => {
  assert.equal(DEFAULT_PPR_DAMPING, 0.85);
  assert.equal(DEFAULT_PPR_ITERATIONS, 20);
  assert.equal(DEFAULT_PPR_TOLERANCE, 1e-6);
});

test("PPR result probabilities sum to approximately 1", () => {
  const graph = buildGraph(
    ["a", "b", "c", "d"],
    [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
      ["d", "a"],
    ],
  );
  const result = queryGraph(graph, ["a"]);
  let total = 0;
  for (const r of result.rankedNodes) total += r.score;
  assert.ok(Math.abs(total - 1) < 1e-3, `expected probability mass ≈ 1, got ${total}`);
});

test("PPR converges on a small ring graph", () => {
  const graph = buildGraph(
    ["a", "b", "c", "d"],
    [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
      ["d", "a"],
    ],
  );
  const result = queryGraph(graph, ["a"], { iterations: 100 });
  assert.equal(result.converged, true);
  assert.ok(result.iterations > 0);
  assert.ok(result.iterations <= 100);
});

test("PPR ranks the seed node highest on a star graph", () => {
  // Star: center node connected to 4 leaves, leaves have no outbound edges.
  const graph = buildGraph(
    ["center", "l1", "l2", "l3", "l4"],
    [
      ["center", "l1"],
      ["center", "l2"],
      ["center", "l3"],
      ["center", "l4"],
    ],
  );
  const result = queryGraph(graph, ["center"]);
  assert.equal(result.rankedNodes[0]?.id, "center");
});

test("PPR biases ranking toward seed in asymmetric graph", () => {
  // A ↔ B ↔ C chain; seed at A should rank A highest.
  const graph = buildGraph(
    ["a", "b", "c"],
    [
      ["a", "b"],
      ["b", "a"],
      ["b", "c"],
      ["c", "b"],
    ],
  );
  const ra = queryGraph(graph, ["a"]);
  const rc = queryGraph(graph, ["c"]);

  const scoreA_seedA = ra.rankedNodes.find((n) => n.id === "a")?.score ?? 0;
  const scoreC_seedA = ra.rankedNodes.find((n) => n.id === "c")?.score ?? 0;
  const scoreA_seedC = rc.rankedNodes.find((n) => n.id === "a")?.score ?? 0;
  const scoreC_seedC = rc.rankedNodes.find((n) => n.id === "c")?.score ?? 0;

  assert.ok(scoreA_seedA > scoreC_seedA, "seeded A should rank A over C");
  assert.ok(scoreC_seedC > scoreA_seedC, "seeded C should rank C over A");
});

test("PPR respects seedWeights object form", () => {
  const graph = buildGraph(
    ["a", "b", "c"],
    [
      ["a", "b"],
      ["b", "c"],
    ],
  );
  const result = queryGraph(graph, ["a", "b"], {
    seedWeights: { a: 0.9, b: 0.1 },
  });
  const scoreA = result.rankedNodes.find((n) => n.id === "a")?.score ?? 0;
  const scoreB = result.rankedNodes.find((n) => n.id === "b")?.score ?? 0;
  // With 90% seed mass on A, A should outrank B on this chain.
  assert.ok(scoreA > scoreB, `expected a (${scoreA}) > b (${scoreB})`);
});

test("PPR respects seedWeights Map form (weights are applied)", () => {
  // Disconnected two-node graph → seedWeights directly drive the ranking.
  const graph = buildGraph(["a", "b"], []);
  const weights = new Map<string, number>([
    ["a", 3],
    ["b", 1],
  ]);
  const result = queryGraph(graph, [], { seedWeights: weights });
  assert.equal(result.rankedNodes[0]?.id, "a");
  const scoreA = result.rankedNodes.find((n) => n.id === "a")?.score ?? 0;
  const scoreB = result.rankedNodes.find((n) => n.id === "b")?.score ?? 0;
  // 3:1 weights → roughly 0.75 vs 0.25.
  assert.ok(scoreA > scoreB * 2, `expected a (${scoreA}) >> b (${scoreB})`);
});

test("PPR falls back to uniform distribution when no seeds match", () => {
  const graph = buildGraph(["a", "b", "c"], [["a", "b"]]);
  const result = queryGraph(graph, ["missing"]);
  // Without bias, probability mass should still sum to ~1.
  let total = 0;
  for (const r of result.rankedNodes) total += r.score;
  assert.ok(Math.abs(total - 1) < 1e-3);
});

test("PPR topK trims the output", () => {
  const graph = buildGraph(
    ["a", "b", "c", "d", "e"],
    [
      ["a", "b"],
      ["a", "c"],
      ["a", "d"],
      ["a", "e"],
    ],
  );
  const result = queryGraph(graph, ["a"], { topK: 2 });
  assert.equal(result.rankedNodes.length, 2);
  assert.equal(result.rankedNodes[0]?.id, "a");
});

test("PPR topK <= 0 returns empty ranked list", () => {
  const graph = buildGraph(["a", "b"], [["a", "b"]]);
  const result = queryGraph(graph, ["a"], { topK: 0 });
  assert.equal(result.rankedNodes.length, 0);
});

test("PPR negative topK returns empty ranked list (not the full ranking)", () => {
  const graph = buildGraph(
    ["a", "b", "c", "d"],
    [["a", "b"], ["b", "c"], ["c", "d"]],
  );
  for (const topK of [-1, -100, -0.5]) {
    const result = queryGraph(graph, ["a"], { topK });
    assert.equal(
      result.rankedNodes.length,
      0,
      `topK=${topK} should yield empty ranked list`,
    );
  }
});

test("PPR duplicate seed ids produce identical distribution to the deduped set", () => {
  // `["a", "a", "b"]` must behave identically to `["a", "b"]`. The share
  // computation must deduplicate before dividing, otherwise `a` gets 2/3
  // of the mass instead of 1/2.
  const graph = buildGraph(
    ["a", "b", "c"],
    [["a", "c"], ["b", "c"]],
  );
  const deduped = queryGraph(graph, ["a", "b"], { iterations: 30 });
  const duplicated = queryGraph(graph, ["a", "a", "b"], { iterations: 30 });
  for (const { id, score } of deduped.rankedNodes) {
    const match = duplicated.rankedNodes.find((n) => n.id === id);
    assert.ok(match, `node ${id} missing from duplicated result`);
    assert.ok(
      Math.abs(score - (match?.score ?? 0)) < 1e-9,
      `score for ${id} drifted: deduped=${score}, duplicated=${match?.score}`,
    );
  }
});

test("PPR is deterministic across invocations", () => {
  const graph = buildGraph(
    ["a", "b", "c", "d"],
    [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
      ["d", "a"],
      ["a", "c"],
    ],
  );
  const r1 = queryGraph(graph, ["a"]);
  const r2 = queryGraph(graph, ["a"]);
  assert.deepEqual(r1.rankedNodes, r2.rankedNodes);
});

test("PPR redistributes dangling mass through the seed vector", () => {
  // b is dangling (no outbound edges). Without dangling redistribution,
  // probability mass would leak away and scores would not sum to 1.
  const graph = buildGraph(["a", "b"], [["a", "b"]]);
  const result = queryGraph(graph, ["a"], { iterations: 200 });
  let total = 0;
  for (const r of result.rankedNodes) total += r.score;
  assert.ok(Math.abs(total - 1) < 1e-3, `expected ~1, got ${total}`);
});

test("PPR edge weights bias the ranking", () => {
  // a → b (weight 0.1), a → c (weight 0.9). With seed on a, c should rank
  // above b among non-seed nodes.
  const graph = buildGraph(
    ["a", "b", "c"],
    [
      ["a", "b", 0.1],
      ["a", "c", 0.9],
    ],
  );
  const result = queryGraph(graph, ["a"]);
  const scoreB = result.rankedNodes.find((n) => n.id === "b")?.score ?? 0;
  const scoreC = result.rankedNodes.find((n) => n.id === "c")?.score ?? 0;
  assert.ok(scoreC > scoreB, `expected c (${scoreC}) > b (${scoreB})`);
});

test("PPR clamps damping out of range", () => {
  const graph = buildGraph(["a", "b"], [["a", "b"]]);
  // Damping >= 1 should be clamped (no infinite loop or NaN).
  const result = queryGraph(graph, ["a"], { damping: 1.5, iterations: 30 });
  assert.ok(result.rankedNodes.length > 0);
  for (const r of result.rankedNodes) {
    assert.ok(Number.isFinite(r.score));
    assert.ok(r.score >= 0);
  }
});

test("PPR treats iterations=0 as no-iter (returns seed as rank)", () => {
  const graph = buildGraph(["a", "b", "c"], [["a", "b"], ["b", "c"]]);
  const result = queryGraph(graph, ["a"], { iterations: 0 });
  // With 0 iterations, rank equals seed: mass concentrated on "a".
  assert.equal(result.iterations, 0);
  assert.equal(result.rankedNodes[0]?.id, "a");
  assert.equal(Math.round((result.rankedNodes[0]?.score ?? 0) * 100) / 100, 1);
});

test("PPR dedupes duplicate seed ids by splitting mass correctly", () => {
  const graph = buildGraph(["a", "b"], [["a", "b"]]);
  const single = queryGraph(graph, ["a"], { iterations: 0 });
  const duplicated = queryGraph(graph, ["a", "a"], { iterations: 0 });
  const scoreA_single = single.rankedNodes.find((n) => n.id === "a")?.score ?? 0;
  const scoreA_duplicated = duplicated.rankedNodes.find((n) => n.id === "a")?.score ?? 0;
  // Duplicating a seed id must not inflate its final share — it still
  // represents one distinct seed node.
  assert.ok(Math.abs(scoreA_single - scoreA_duplicated) < 1e-9);
});

test("PPR ignores negative and non-finite seed weights", () => {
  const graph = buildGraph(["a", "b"], [["a", "b"]]);
  const result = queryGraph(graph, ["a", "b"], {
    seedWeights: { a: 1, b: -5 },
  });
  const scoreA = result.rankedNodes.find((n) => n.id === "a")?.score ?? 0;
  const scoreB = result.rankedNodes.find((n) => n.id === "b")?.score ?? 0;
  // Negative weight on b should be dropped → seed concentrated on a.
  assert.ok(scoreA > scoreB);
});

test("PPR converges to a stable fixed point (two iterations close to each other)", () => {
  const graph = buildGraph(
    ["a", "b", "c", "d"],
    [
      ["a", "b"],
      ["b", "c"],
      ["c", "a"],
      ["a", "d"],
      ["d", "a"],
    ],
  );
  const r100 = queryGraph(graph, ["a"], { iterations: 100, tolerance: 0 });
  const r101 = queryGraph(graph, ["a"], { iterations: 101, tolerance: 0 });
  // With tolerance=0, both should run the full iteration cap. Their rank
  // vectors should be within a tight epsilon.
  for (const { id, score } of r100.rankedNodes) {
    const match = r101.rankedNodes.find((n) => n.id === id);
    assert.ok(match, `node ${id} missing from r101`);
    assert.ok(
      Math.abs(score - (match?.score ?? 0)) < 1e-6,
      `score for ${id} drifted between iteration ${100} and ${101}`,
    );
  }
});

test("PPR honors RemnicGraphNode.weight as a starting-rank prior (no seedWeights)", () => {
  // Two disconnected nodes. Without edges, PPR's rank follows the
  // seed distribution; node weights must bias the uniform fallback.
  const nodes = new Map<string, RemnicGraphNode>();
  nodes.set("a", { id: "a", type: "memory", weight: 3 });
  nodes.set("b", { id: "b", type: "memory", weight: 1 });
  const graph: RemnicGraph = { nodes, edges: [] };
  const result = queryGraph(graph, [], { iterations: 0 });
  const scoreA = result.rankedNodes.find((n) => n.id === "a")?.score ?? 0;
  const scoreB = result.rankedNodes.find((n) => n.id === "b")?.score ?? 0;
  assert.ok(scoreA > scoreB * 2, `expected a(${scoreA}) >> b(${scoreB})`);
});

test("PPR does not double-bias explicit seedWeights with node weights (Codex P2)", () => {
  // With both `seedWeights` provided AND node weights, the node
  // weights must not silently amplify the caller's explicit bias.
  // This test: a has node weight 10, b has node weight 1. Caller sets
  // seedWeights a=1, b=1 (equal). Expected: equal shares.
  const nodes = new Map<string, RemnicGraphNode>();
  nodes.set("a", { id: "a", type: "memory", weight: 10 });
  nodes.set("b", { id: "b", type: "memory", weight: 1 });
  const graph: RemnicGraph = { nodes, edges: [] };
  const result = queryGraph(graph, ["a", "b"], {
    seedWeights: { a: 1, b: 1 },
    iterations: 0,
  });
  const scoreA = result.rankedNodes.find((n) => n.id === "a")?.score ?? 0;
  const scoreB = result.rankedNodes.find((n) => n.id === "b")?.score ?? 0;
  assert.ok(
    Math.abs(scoreA - scoreB) < 1e-9,
    `expected equal shares, got a=${scoreA}, b=${scoreB}`,
  );
});
