import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

// ---------------------------------------------------------------------------
// Incremental edge cache (issue #1904). onMemoryWritten pushes single-writer
// appends into the warm cache in place and reloads only on a peer append.
// These use a delete-the-file-then-traverse probe instead of a readAllEdges
// spy: it proves the same invariant more robustly (a reload would read the
// now-missing file and return nothing, so surviving edges prove no reload).
// ---------------------------------------------------------------------------

const onWriteOpts = {
  entityRef: "Acme",
  content: "",
  created: "2026-01-01T00:00:00.000Z",
};

test("#1904: onMemoryWritten pushes appended edges into the warm cache in place (no reload)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-incr-"));
  try {
    await writeGraphEdges(memoryDir, [makeEdge("seed", "old-sibling")]);
    const graph = new GraphIndex(memoryDir, makeGraphConfig());
    // Warm the edge cache (records the file-size baseline).
    await graph.spreadingActivation(["seed"]);
    // Single-writer append through the write path.
    await graph.onMemoryWritten({
      ...onWriteOpts,
      memoryPath: "facts/new.md",
      entitySiblings: ["facts/sibling.md"],
    });
    // Delete the on-disk file: a full reload would now find nothing. The warm
    // cache must still serve the just-appended edge, proving it was pushed in
    // place rather than reconstructed from disk.
    await rm(graphFilePath(memoryDir, "entity"), { force: true });
    const activated = await graph.spreadingActivation(["facts/new.md"]);
    const paths = new Set(activated.map((candidate) => candidate.path));
    assert.ok(
      paths.has("facts/sibling.md"),
      "the in-place-pushed edge must remain traversable after the file is removed (no reload)",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("#1904: onMemoryWritten reloads the edge cache when a peer appended (size mismatch)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-peer-"));
  try {
    await writeGraphEdges(memoryDir, [makeEdge("seed", "old-sibling")]);
    const graph = new GraphIndex(memoryDir, makeGraphConfig());
    await graph.spreadingActivation(["seed"]); // warm + size baseline
    // A peer process appends directly to the file, bypassing this GraphIndex so
    // its size baseline does not account for the extra bytes.
    const peerEdge = makeEdge("facts/new.md", "facts/peer.md");
    await appendFile(graphFilePath(memoryDir, "entity"), `${JSON.stringify(peerEdge)}\n`, "utf8");
    // Our own append: on-disk size now exceeds baseline + our bytes → mismatch.
    await graph.onMemoryWritten({
      ...onWriteOpts,
      memoryPath: "facts/new.md",
      entitySiblings: ["facts/sibling.md"],
    });
    // The size mismatch must have nulled the cache; the next traversal reloads
    // and sees BOTH the peer edge and our edge. A stale in-place push would have
    // missed the peer edge entirely.
    const activated = await graph.spreadingActivation(["facts/new.md"]);
    const paths = new Set(activated.map((candidate) => candidate.path));
    assert.ok(paths.has("facts/peer.md"), "peer-appended edge must appear after the coherence reload");
    assert.ok(paths.has("facts/sibling.md"), "our appended edge must also appear after the reload");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("#1904: graphEdgeCacheIncrementalEnabled=false nulls the edge cache on every write (legacy)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-legacy-"));
  try {
    await writeGraphEdges(memoryDir, [makeEdge("seed", "old-sibling")]);
    const graph = new GraphIndex(memoryDir, { ...makeGraphConfig(), graphEdgeCacheIncrementalEnabled: false });
    await graph.spreadingActivation(["seed"]); // warm
    await graph.onMemoryWritten({
      ...onWriteOpts,
      memoryPath: "facts/new.md",
      entitySiblings: ["facts/sibling.md"],
    });
    // Legacy: the cache was nulled, so the next traversal reloads from disk.
    // Remove the file first — a nulled cache reloads nothing, proving the write
    // did not extend a warm cache in place.
    await rm(graphFilePath(memoryDir, "entity"), { force: true });
    const activated = await graph.spreadingActivation(["facts/new.md"]);
    const paths = new Set(activated.map((candidate) => candidate.path));
    assert.ok(
      !paths.has("facts/sibling.md"),
      "legacy mode must null the cache on every write (nothing served after the file is removed)",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
