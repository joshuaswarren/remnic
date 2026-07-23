import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "path";
import {
  graphsDir,
  graphFilePath,
  appendEdge,
  readEdges,
  readAllEdges,
  detectCausalPhrase,
  CAUSAL_PHRASES,
  GraphIndex,
  type GraphConfig,
} from "../src/graph.js";

let tmpDir: string;

before(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "engram-graph-test-"));
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("detectCausalPhrase", () => {
  it("detects 'because'", () => {
    assert.equal(detectCausalPhrase("I did it because you asked"), "because");
  });

  it("detects 'as a result' before 'because'", () => {
    assert.equal(detectCausalPhrase("as a result of the change, because yes"), "as a result");
  });

  it("returns null when no phrase present", () => {
    assert.equal(detectCausalPhrase("Just a normal sentence"), null);
  });

  it("is case-insensitive", () => {
    assert.equal(detectCausalPhrase("Therefore we proceeded"), "therefore");
  });
});

describe("appendEdge + readEdges", () => {
  it("appends and reads back an edge", async () => {
    const edge = {
      from: "facts/a.md",
      to: "facts/b.md",
      type: "entity" as const,
      weight: 1.0,
      label: "project-x",
      ts: new Date().toISOString(),
    };
    await appendEdge(tmpDir, edge);
    const edges = await readEdges(tmpDir, "entity");
    assert.equal(edges.length, 1);
    assert.equal(edges[0].from, "facts/a.md");
    assert.equal(edges[0].label, "project-x");
  });

  it("returns [] for missing file (fail-open)", async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), "engram-graph-empty-"));
    try {
      const edges = await readEdges(fresh, "causal");
      assert.deepEqual(edges, []);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});

describe("readAllEdges", () => {
  it("merges all enabled graph types", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-graph-all-"));
    try {
      await appendEdge(dir, { from: "a.md", to: "b.md", type: "entity", weight: 1.0, label: "e", ts: new Date().toISOString() });
      await appendEdge(dir, { from: "c.md", to: "d.md", type: "time", weight: 1.0, label: "t1", ts: new Date().toISOString() });
      const edges = await readAllEdges(dir, { entityGraph: true, timeGraph: true, causalGraph: false });
      assert.equal(edges.length, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("GraphIndex.onMemoryWritten", () => {
  const cfg: GraphConfig = {
    multiGraphMemoryEnabled: true,
    entityGraphEnabled: true,
    timeGraphEnabled: true,
    causalGraphEnabled: true,
    maxGraphTraversalSteps: 3,
    graphActivationDecay: 0.7,
    maxEntityGraphEdgesPerMemory: 10,
    graphLateralInhibitionEnabled: false,
    graphLateralInhibitionBeta: 0,
    graphLateralInhibitionTopM: 0,
    graphTraversalConfidenceFloor: 0.2,
    graphTraversalPageRankIterations: 0,
  };

  it("writes entity edges for entityRef siblings", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-gi-entity-"));
    try {
      const gi = new GraphIndex(dir, cfg);
      await gi.onMemoryWritten({
        memoryPath: "facts/new.md",
        entityRef: "project-alpha",
        content: "We finalized the design",
        created: new Date().toISOString(),
        entitySiblings: ["facts/old.md"],
      });
      const edges = await readEdges(dir, "entity");
      assert.equal(edges.length, 1);
      assert.equal(edges[0].label, "project-alpha");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes time edge to predecessor in thread", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-gi-time-"));
    try {
      const gi = new GraphIndex(dir, cfg);
      await gi.onMemoryWritten({
        memoryPath: "facts/new.md",
        content: "Next step in the plan",
        created: new Date().toISOString(),
        threadId: "thread-123",
        recentInThread: ["facts/prev.md"],
      });
      const edges = await readEdges(dir, "time");
      assert.equal(edges.length, 1);
      assert.equal(edges[0].from, "facts/prev.md");
      assert.equal(edges[0].to, "facts/new.md");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes causal edge when content contains causal phrase", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-gi-causal-"));
    try {
      const gi = new GraphIndex(dir, cfg);
      await gi.onMemoryWritten({
        memoryPath: "facts/new.md",
        content: "We pivoted because the original plan failed",
        created: new Date().toISOString(),
        causalPredecessor: "facts/root.md",
      });
      const edges = await readEdges(dir, "causal");
      assert.equal(edges.length, 1);
      assert.equal(edges[0].label, "because");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does nothing when multiGraphMemoryEnabled is false", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-gi-disabled-"));
    try {
      const gi = new GraphIndex(dir, { ...cfg, multiGraphMemoryEnabled: false });
      await gi.onMemoryWritten({
        memoryPath: "facts/new.md",
        content: "because something",
        created: new Date().toISOString(),
        entityRef: "proj",
        entitySiblings: ["facts/old.md"],
        causalPredecessor: "facts/prev.md",
      });
      const edges = await readAllEdges(dir, { entityGraph: true, timeGraph: true, causalGraph: true });
      assert.deepEqual(edges, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("GraphIndex.spreadingActivation", () => {
  const cfg: GraphConfig = {
    multiGraphMemoryEnabled: true,
    entityGraphEnabled: true,
    timeGraphEnabled: true,
    causalGraphEnabled: false,
    maxGraphTraversalSteps: 3,
    graphActivationDecay: 0.7,
    maxEntityGraphEdgesPerMemory: 10,
    graphLateralInhibitionEnabled: false,
    graphLateralInhibitionBeta: 0,
    graphLateralInhibitionTopM: 0,
    graphTraversalConfidenceFloor: 0.2,
    graphTraversalPageRankIterations: 0,
  };

  it("returns hop-1 neighbors with decay applied", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-sa-basic-"));
    try {
      const gi = new GraphIndex(dir, cfg);
      // seed=A, A→B (entity)
      await appendEdge(dir, { from: "A.md", to: "B.md", type: "entity", weight: 1.0, label: "e", ts: new Date().toISOString() });
      const results = await gi.spreadingActivation(["A.md"], 1);
      assert.equal(results.length, 1);
      assert.equal(results[0].path, "B.md");
      assert.ok(Math.abs(results[0].score - 0.7) < 0.001, `expected 0.7 got ${results[0].score}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not include seed paths in results", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-sa-noseed-"));
    try {
      const gi = new GraphIndex(dir, cfg);
      await appendEdge(dir, { from: "A.md", to: "A.md", type: "entity", weight: 1.0, label: "e", ts: new Date().toISOString() });
      const results = await gi.spreadingActivation(["A.md"]);
      assert.equal(results.filter((r) => r.path === "A.md").length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accumulates activation from multiple incoming edges", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-sa-sum-"));
    try {
      const gi = new GraphIndex(dir, cfg);
      await appendEdge(dir, { from: "A.md", to: "C.md", type: "entity", weight: 1.0, label: "e", ts: new Date().toISOString() });
      await appendEdge(dir, { from: "B.md", to: "C.md", type: "entity", weight: 1.0, label: "e", ts: new Date().toISOString() });
      const results = await gi.spreadingActivation(["A.md", "B.md"], 1);
      const c = results.find((r) => r.path === "C.md");
      assert.ok(c, "expected C.md in activation results");
      // Each seed contributes 0.7 at hop 1, so total should be 1.4
      assert.ok(Math.abs((c?.score ?? 0) - 1.4) < 0.001, `expected 1.4 got ${c?.score}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns [] when feature disabled", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-sa-off-"));
    try {
      const gi = new GraphIndex(dir, { ...cfg, multiGraphMemoryEnabled: false });
      await appendEdge(dir, { from: "A.md", to: "B.md", type: "entity", weight: 1.0, label: "e", ts: new Date().toISOString() });
      const results = await gi.spreadingActivation(["A.md"]);
      assert.deepEqual(results, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns [] on missing graph files (fail-open)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-sa-empty-"));
    try {
      const gi = new GraphIndex(dir, cfg);
      const results = await gi.spreadingActivation(["A.md"]);
      assert.deepEqual(results, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── Issue #681 PR 3/3 — confidence-weighted traversal & PageRank ─────────
describe("GraphIndex.spreadingActivation — confidence weighting (#681 PR 3/3)", () => {
  const baseCfg: GraphConfig = {
    multiGraphMemoryEnabled: true,
    entityGraphEnabled: true,
    timeGraphEnabled: true,
    causalGraphEnabled: false,
    maxGraphTraversalSteps: 3,
    graphActivationDecay: 0.7,
    maxEntityGraphEdgesPerMemory: 10,
    // Floor 0.2 (default), but make iterations 0 in these tests so we can
    // assert raw confidence-weighted BFS scores deterministically without
    // PageRank refinement smoothing them.
    graphTraversalConfidenceFloor: 0.2,
    graphTraversalPageRankIterations: 0,
  } as unknown as GraphConfig;

  it("multiplies activation by edge confidence", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-sa-conf-mul-"));
    try {
      const gi = new GraphIndex(dir, baseCfg);
      // High-confidence edge: A → B at confidence 0.9.
      // Score = weight(1.0) * conf(0.9) * decay(0.7)^1 = 0.63
      await appendEdge(dir, {
        from: "A.md",
        to: "B.md",
        type: "entity",
        weight: 1.0,
        label: "e",
        ts: new Date().toISOString(),
        confidence: 0.9,
      });
      const results = await gi.spreadingActivation(["A.md"], 1);
      const b = results.find((r) => r.path === "B.md");
      assert.ok(b, "expected B.md in results");
      assert.ok(
        Math.abs((b?.score ?? 0) - 0.63) < 0.001,
        `expected 0.63 got ${b?.score}`,
      );
      assert.equal(b?.edgeConfidence, 0.9);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats legacy edges (no confidence) as 1.0", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-sa-conf-legacy-"));
    try {
      const gi = new GraphIndex(dir, baseCfg);
      await appendEdge(dir, {
        from: "A.md",
        to: "B.md",
        type: "entity",
        weight: 1.0,
        label: "e",
        ts: new Date().toISOString(),
        // confidence intentionally omitted
      });
      const results = await gi.spreadingActivation(["A.md"], 1);
      const b = results.find((r) => r.path === "B.md");
      assert.ok(b);
      assert.equal(b?.edgeConfidence, 1);
      assert.ok(
        Math.abs((b?.score ?? 0) - 0.7) < 0.001,
        `expected 0.7 got ${b?.score}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prunes edges below the confidence floor", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-sa-conf-floor-"));
    try {
      const gi = new GraphIndex(dir, baseCfg);
      // High-confidence A → B; low-confidence A → C (below 0.2 floor).
      await appendEdge(dir, {
        from: "A.md",
        to: "B.md",
        type: "entity",
        weight: 1.0,
        label: "high",
        ts: new Date().toISOString(),
        confidence: 0.8,
      });
      await appendEdge(dir, {
        from: "A.md",
        to: "C.md",
        type: "entity",
        weight: 1.0,
        label: "low",
        ts: new Date().toISOString(),
        confidence: 0.05,
      });
      const results = await gi.spreadingActivation(["A.md"], 2);
      assert.ok(
        results.some((r) => r.path === "B.md"),
        "high-confidence neighbor B should be admitted",
      );
      assert.equal(
        results.filter((r) => r.path === "C.md").length,
        0,
        "low-confidence neighbor C should be pruned",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pruned edge does not seed downstream neighbors", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-sa-conf-cascade-"));
    try {
      const gi = new GraphIndex(dir, baseCfg);
      // A — (low conf 0.05) — B — (high 0.9) — C
      // The A → B edge should be pruned, so C must NOT show up either.
      await appendEdge(dir, {
        from: "A.md",
        to: "B.md",
        type: "entity",
        weight: 1.0,
        label: "low",
        ts: new Date().toISOString(),
        confidence: 0.05,
      });
      await appendEdge(dir, {
        from: "B.md",
        to: "C.md",
        type: "entity",
        weight: 1.0,
        label: "high",
        ts: new Date().toISOString(),
        confidence: 0.9,
      });
      const results = await gi.spreadingActivation(["A.md"], 3);
      assert.equal(results.length, 0, "all downstream neighbors should be pruned");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("respects floor=0 (admit every edge)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-sa-conf-floor0-"));
    try {
      const gi = new GraphIndex(dir, {
        ...baseCfg,
        graphTraversalConfidenceFloor: 0,
      } as GraphConfig);
      await appendEdge(dir, {
        from: "A.md",
        to: "B.md",
        type: "entity",
        weight: 1.0,
        label: "very-low",
        ts: new Date().toISOString(),
        confidence: 0.001,
      });
      const results = await gi.spreadingActivation(["A.md"], 1);
      assert.equal(results.length, 1);
      assert.equal(results[0].path, "B.md");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("PageRank refinement re-ranks higher-confidence chains above lower-confidence ones", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-sa-pr-rank-"));
    try {
      const cfgWithPR: GraphConfig = {
        ...baseCfg,
        graphTraversalPageRankIterations: 8,
      } as GraphConfig;
      const gi = new GraphIndex(dir, cfgWithPR);
      // Two parallel chains from seed A:
      //   A → B (conf 0.9) → D (conf 0.9)   high-confidence chain
      //   A → C (conf 0.3) → D (conf 0.3)   low-confidence chain
      // D should accumulate from both, but with PageRank refinement
      // weighted by confidence, D's contribution from the B branch
      // dominates and B itself outranks C.
      await appendEdge(dir, { from: "A.md", to: "B.md", type: "entity", weight: 1.0, label: "h", ts: new Date().toISOString(), confidence: 0.9 });
      await appendEdge(dir, { from: "A.md", to: "C.md", type: "entity", weight: 1.0, label: "l", ts: new Date().toISOString(), confidence: 0.3 });
      await appendEdge(dir, { from: "B.md", to: "D.md", type: "entity", weight: 1.0, label: "h", ts: new Date().toISOString(), confidence: 0.9 });
      await appendEdge(dir, { from: "C.md", to: "D.md", type: "entity", weight: 1.0, label: "l", ts: new Date().toISOString(), confidence: 0.3 });

      const results = await gi.spreadingActivation(["A.md"], 3);
      const b = results.find((r) => r.path === "B.md");
      const c = results.find((r) => r.path === "C.md");
      assert.ok(b && c, "expected both B and C in results");
      assert.ok(
        (b?.score ?? 0) > (c?.score ?? 0),
        `expected B (high-confidence) to outrank C (low-confidence): bScore=${b?.score} cScore=${c?.score}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("PageRank iterations=0 leaves BFS scores unchanged", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-sa-pr-zero-"));
    try {
      const gi = new GraphIndex(dir, baseCfg); // iterations=0
      await appendEdge(dir, {
        from: "A.md",
        to: "B.md",
        type: "entity",
        weight: 1.0,
        label: "e",
        ts: new Date().toISOString(),
        confidence: 0.5,
      });
      const results = await gi.spreadingActivation(["A.md"], 1);
      const b = results.find((r) => r.path === "B.md");
      // Pure BFS: 1.0 * 0.5 * 0.7 = 0.35
      assert.ok(b);
      assert.ok(
        Math.abs((b?.score ?? 0) - 0.35) < 0.001,
        `expected raw BFS 0.35 got ${b?.score}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records edgeConfidence in provenance for each candidate", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-sa-conf-prov-"));
    try {
      const gi = new GraphIndex(dir, baseCfg);
      await appendEdge(dir, {
        from: "A.md",
        to: "B.md",
        type: "entity",
        weight: 1.0,
        label: "e",
        ts: new Date().toISOString(),
        confidence: 0.6,
      });
      const results = await gi.spreadingActivation(["A.md"], 1);
      const b = results.find((r) => r.path === "B.md");
      assert.ok(b);
      assert.equal(b?.edgeConfidence, 0.6);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("clamps misconfigured floor (negative → 0, >1 → 1)", async () => {
    // Pure-function regression: clampConfidenceFloor must squash bad input.
    const { clampConfidenceFloor, clampPageRankIterations } = await import(
      "../src/graph.js"
    );
    assert.equal(clampConfidenceFloor(-0.5), 0);
    assert.equal(clampConfidenceFloor(2), 1);
    assert.equal(clampConfidenceFloor(NaN), 0.2);
    assert.equal(clampConfidenceFloor(undefined), 0.2);
    assert.equal(clampConfidenceFloor(0.4), 0.4);
    assert.equal(clampPageRankIterations(-3), 0);
    assert.equal(clampPageRankIterations(NaN), 0);
    assert.equal(clampPageRankIterations(undefined), 0);
    assert.equal(clampPageRankIterations(7.6), 7);
  });

  it("PageRank does not collapse leaf candidates (codex P1 #735)", async () => {
    // Codex P1 review thread regression: a leaf candidate B whose only
    // out-edge points back to a seed (excluded from `scores`) must not
    // have its score driven toward zero by repeated iterations. The
    // previous denominator counted that edge but dropped its flow,
    // leaking `safeDamping × score` per pass. With the fix, the
    // dangling-node fallback keeps the leaf's mass on itself.
    const dir = await mkdtemp(path.join(tmpdir(), "engram-sa-pr-leaf-"));
    try {
      const cfgWithPR: GraphConfig = {
        ...baseCfg,
        graphTraversalPageRankIterations: 16,
      } as GraphConfig;
      const gi = new GraphIndex(dir, cfgWithPR);
      // Seed S → B at confidence 0.9 (time edges synthesize a reverse
      // B → S, so B's only out-neighbor is the seed S, which is
      // excluded from `scores`).
      await appendEdge(dir, {
        from: "S.md",
        to: "B.md",
        type: "time",
        weight: 1.0,
        label: "t",
        ts: new Date().toISOString(),
        confidence: 0.9,
      });
      const results = await gi.spreadingActivation(["S.md"], 2);
      const b = results.find((r) => r.path === "B.md");
      assert.ok(b, "B should be in results after refinement");
      // Pre-fix: leaking flow would shrink B's score by damping^16.
      // Post-fix: B's score should still reflect the original BFS
      // contribution (1.0 * 0.9 * 0.7 = 0.63) within a small tolerance
      // — refinement is a re-ranker, not a leak.
      assert.ok(
        (b?.score ?? 0) >= 0.6,
        `B's score must not collapse from refinement leakage; got ${b?.score}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("PageRank refinement is mass-bounded (no negative or NaN scores)", async () => {
    // Defense in depth: regardless of topology / iteration count, the
    // refinement must produce finite, non-negative scores. Catches any
    // future arithmetic regression where damping or normalization is
    // miscomputed.
    const dir = await mkdtemp(path.join(tmpdir(), "engram-sa-pr-finite-"));
    try {
      const cfgWithPR: GraphConfig = {
        ...baseCfg,
        graphTraversalPageRankIterations: 32,
      } as GraphConfig;
      const gi = new GraphIndex(dir, cfgWithPR);
      const ts = new Date().toISOString();
      await appendEdge(dir, { from: "A.md", to: "B.md", type: "entity", weight: 1.0, label: "e", ts, confidence: 0.7 });
      await appendEdge(dir, { from: "A.md", to: "C.md", type: "entity", weight: 1.0, label: "e", ts, confidence: 0.5 });
      await appendEdge(dir, { from: "B.md", to: "C.md", type: "entity", weight: 1.0, label: "e", ts, confidence: 0.9 });
      await appendEdge(dir, { from: "B.md", to: "D.md", type: "entity", weight: 1.0, label: "e", ts, confidence: 0.6 });
      await appendEdge(dir, { from: "C.md", to: "D.md", type: "entity", weight: 1.0, label: "e", ts, confidence: 0.8 });
      const results = await gi.spreadingActivation(["A.md"], 4);
      assert.ok(results.length > 0);
      for (const r of results) {
        assert.ok(Number.isFinite(r.score), `score must be finite: ${r.path} → ${r.score}`);
        assert.ok(r.score >= 0, `score must be non-negative: ${r.path} → ${r.score}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Integration: multiGraphMemoryEnabled=false baseline", () => {
  it("graph files are NOT written when flag is false", async () => {
    const { readEdges: re } = await import("../src/graph.js");
    const dir = await mkdtemp(path.join(tmpdir(), "engram-integration-off-"));
    try {
      const cfg: GraphConfig = {
        multiGraphMemoryEnabled: false,
        entityGraphEnabled: true,
        timeGraphEnabled: true,
        causalGraphEnabled: true,
        maxGraphTraversalSteps: 3,
        graphActivationDecay: 0.7,
        maxEntityGraphEdgesPerMemory: 10,
        graphLateralInhibitionEnabled: false,
        graphLateralInhibitionBeta: 0,
        graphLateralInhibitionTopM: 0,
        graphTraversalConfidenceFloor: 0.2,
        graphTraversalPageRankIterations: 0,
      };
      const gi = new GraphIndex(dir, cfg);
      await gi.onMemoryWritten({
        memoryPath: "facts/new.md",
        entityRef: "thing",
        content: "because of something",
        created: new Date().toISOString(),
        entitySiblings: ["facts/old.md"],
        causalPredecessor: "facts/old.md",
        threadId: "t1",
        recentInThread: ["facts/old.md"],
      });
      const entityEdges = await re(dir, "entity");
      const timeEdges = await re(dir, "time");
      const causalEdges = await re(dir, "causal");
      assert.equal(entityEdges.length, 0);
      assert.equal(timeEdges.length, 0);
      assert.equal(causalEdges.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Integration: corrupt JSONL fail-open", () => {
  it("readEdges returns [] on corrupt file", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const dir = await mkdtemp(path.join(tmpdir(), "engram-corrupt-"));
    try {
      await mkdir(path.join(dir, "state", "graphs"), { recursive: true });
      await writeFile(path.join(dir, "state", "graphs", "entity.jsonl"), "NOT JSON\n{\"broken\": true}\n");
      const edges = await readEdges(dir, "entity");
      // The "{\"broken\": true}" line parses successfully (1 edge); "NOT JSON" is skipped
      // This verifies fail-open skips corrupt lines, not that ALL lines fail
      assert.ok(edges.length <= 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("spreadingActivation returns [] when all graph JSONL lines are corrupt", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const dir = await mkdtemp(path.join(tmpdir(), "engram-corrupt-sa-"));
    try {
      const saCfg: GraphConfig = {
        multiGraphMemoryEnabled: true,
        entityGraphEnabled: true,
        timeGraphEnabled: true,
        causalGraphEnabled: true,
        maxGraphTraversalSteps: 3,
        graphActivationDecay: 0.7,
        maxEntityGraphEdgesPerMemory: 10,
        graphLateralInhibitionEnabled: false,
        graphLateralInhibitionBeta: 0,
        graphLateralInhibitionTopM: 0,
        graphTraversalConfidenceFloor: 0.2,
        graphTraversalPageRankIterations: 0,
      };
      await mkdir(path.join(dir, "state", "graphs"), { recursive: true });
      await writeFile(path.join(dir, "state", "graphs", "entity.jsonl"), "NOT JSON\nALSO NOT JSON\n");
      await writeFile(path.join(dir, "state", "graphs", "time.jsonl"), "###\n");
      await writeFile(path.join(dir, "state", "graphs", "causal.jsonl"), "{oops\n");

      const gi = new GraphIndex(dir, saCfg);
      const results = await gi.spreadingActivation(["A.md"]);
      assert.deepEqual(results, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("GraphIndex.spreadingActivation — assembly deadlines", () => {
  const cfg = {
    multiGraphMemoryEnabled: true,
    entityGraphEnabled: true,
    timeGraphEnabled: true,
    causalGraphEnabled: false,
    maxGraphTraversalSteps: 3,
    graphActivationDecay: 0.7,
    maxEntityGraphEdgesPerMemory: 10,
  } as unknown as GraphConfig;

  it("returns [] immediately when the traversal deadline is already expired", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-sa-deadline-"));
    try {
      const gi = new GraphIndex(dir, cfg);
      await appendEdge(dir, {
        from: "A.md",
        to: "B.md",
        type: "entity",
        weight: 1.0,
        label: "deadline",
        ts: new Date().toISOString(),
      });
      let edgeCacheLoaded = false;
      (gi as unknown as { loadEdgesCached(): Promise<unknown[]> }).loadEdgesCached =
        async () => {
          edgeCacheLoaded = true;
          return [];
        };
      const startedAt = Date.now();
      const results = await gi.spreadingActivation(["A.md"], 3, {
        deadlineAtMs: startedAt - 1,
      });
      assert.deepEqual(results, []);
      assert.equal(edgeCacheLoaded, false);
      assert.ok(Date.now() - startedAt < 100, "expired deadline should fail open quickly");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps completed BFS results when the deadline expires before inhibition", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-sa-deadline-partial-"));
    const originalNow = Date.now;
    try {
      const gi = new GraphIndex(dir, {
        ...cfg,
        graphTraversalPageRankIterations: 0,
        graphLateralInhibitionEnabled: true,
      } as unknown as GraphConfig);
      await appendEdge(dir, {
        from: "A.md",
        to: "B.md",
        type: "entity",
        weight: 1.0,
        label: "deadline",
        ts: new Date().toISOString(),
      });

      let calls = 0;
      Date.now = () => {
        calls += 1;
        return calls < 7 ? 1_000 : 2_000;
      };

      const results = await gi.spreadingActivation(["A.md"], 1, {
        deadlineAtMs: 1_500,
      });
      assert.equal(results.length, 1);
      assert.equal(results[0].path, "B.md");
      assert.ok(
        Math.abs(results[0].score - 0.7) < 0.001,
        `expected BFS score 0.7 got ${results[0].score}`,
      );
    } finally {
      Date.now = originalNow;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
