import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import {
  makeEdgeId,
  validateCausalEdge,
  scoreStitchCandidate,
  readChainIndex,
  writeChainIndex,
  resolveChainsDir,
  stitchCausalChain,
  type CausalEdge,
  type CausalChainIndex,
} from "../src/causal-chain.js";
import { recordCausalTrajectory, type CausalTrajectoryRecord } from "../src/causal-trajectory.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTrajectory(overrides: Partial<CausalTrajectoryRecord> = {}): CausalTrajectoryRecord {
  return {
    schemaVersion: 1,
    trajectoryId: `traj-${Math.random().toString(36).slice(2, 8)}`,
    recordedAt: new Date().toISOString(),
    sessionKey: "session-1",
    goal: "Fix the failing test suite",
    actionSummary: "Updated parser to handle edge cases",
    observationSummary: "Tests now pass for basic cases",
    outcomeKind: "success",
    outcomeSummary: "All tests green",
    ...overrides,
  };
}

// ─── Validation ──────────────────────────────────────────────────────────────

test("validateCausalEdge accepts valid edge", () => {
  const edge = validateCausalEdge({
    schemaVersion: 1,
    edgeId: "edge-abc123",
    fromTrajectoryId: "traj-1",
    toTrajectoryId: "traj-2",
    edgeType: "follow_up_to_goal",
    confidence: 0.8,
    stitchMethod: "lexical",
    createdAt: "2026-03-16T10:00:00.000Z",
  });
  assert.equal(edge.edgeId, "edge-abc123");
  assert.equal(edge.edgeType, "follow_up_to_goal");
  assert.equal(edge.confidence, 0.8);
});

test("validateCausalEdge rejects invalid schemaVersion", () => {
  assert.throws(() =>
    validateCausalEdge({
      schemaVersion: 2,
      edgeId: "e1",
      fromTrajectoryId: "t1",
      toTrajectoryId: "t2",
      edgeType: "retry",
      confidence: 0.5,
      stitchMethod: "lexical",
      createdAt: "2026-03-16T10:00:00.000Z",
    }),
  );
});

test("validateCausalEdge rejects invalid edgeType", () => {
  assert.throws(() =>
    validateCausalEdge({
      schemaVersion: 1,
      edgeId: "e1",
      fromTrajectoryId: "t1",
      toTrajectoryId: "t2",
      edgeType: "invalid",
      confidence: 0.5,
      stitchMethod: "lexical",
      createdAt: "2026-03-16T10:00:00.000Z",
    }),
  );
});

test("validateCausalEdge rejects confidence out of range", () => {
  assert.throws(() =>
    validateCausalEdge({
      schemaVersion: 1,
      edgeId: "e1",
      fromTrajectoryId: "t1",
      toTrajectoryId: "t2",
      edgeType: "retry",
      confidence: 1.5,
      stitchMethod: "lexical",
      createdAt: "2026-03-16T10:00:00.000Z",
    }),
  );
});

// ─── Edge ID ─────────────────────────────────────────────────────────────────

test("makeEdgeId is deterministic", () => {
  const id1 = makeEdgeId("traj-1", "traj-2");
  const id2 = makeEdgeId("traj-1", "traj-2");
  assert.equal(id1, id2);
  assert.ok(id1.startsWith("edge-"));
});

test("makeEdgeId produces different IDs for different inputs", () => {
  const id1 = makeEdgeId("traj-1", "traj-2");
  const id2 = makeEdgeId("traj-2", "traj-1");
  assert.notEqual(id1, id2);
});

// ─── Scoring ─────────────────────────────────────────────────────────────────

test("scoreStitchCandidate scores high for follow-up matching goal", () => {
  const newTraj = makeTrajectory({
    trajectoryId: "new-1",
    sessionKey: "session-2",
    goal: "Deploy the updated parser",
    followUpSummary: "Fix the failing test suite for edge cases",
  });
  const candidate = makeTrajectory({
    trajectoryId: "old-1",
    sessionKey: "session-1",
    goal: "Fix the failing test suite for edge cases",
  });

  const result = scoreStitchCandidate(newTraj, candidate);
  assert.ok(result.score > 0, `Expected positive score, got ${result.score}`);
  assert.equal(result.edgeType, "follow_up_to_goal");
});

test("scoreStitchCandidate scores higher with entity overlap", () => {
  const newTraj = makeTrajectory({
    trajectoryId: "new-1",
    sessionKey: "session-2",
    goal: "Refactor authentication module",
    entityRefs: ["repo:openclaw-engram", "module:auth"],
    tags: ["refactor"],
  });
  const candidateWithEntities = makeTrajectory({
    trajectoryId: "old-1",
    sessionKey: "session-1",
    goal: "Add authentication error handling",
    entityRefs: ["repo:openclaw-engram", "module:auth"],
    tags: ["auth"],
  });
  const candidateWithout = makeTrajectory({
    trajectoryId: "old-2",
    sessionKey: "session-1",
    goal: "Update the readme documentation",
    entityRefs: ["repo:other-project"],
    tags: ["docs"],
  });

  const scoreWith = scoreStitchCandidate(newTraj, candidateWithEntities);
  const scoreWithout = scoreStitchCandidate(newTraj, candidateWithout);
  assert.ok(scoreWith.score > scoreWithout.score);
});

test("scoreStitchCandidate detects retry edge type", () => {
  const newTraj = makeTrajectory({
    trajectoryId: "new-1",
    sessionKey: "session-2",
    goal: "Fix the failing test suite",
    outcomeKind: "success",
  });
  const candidate = makeTrajectory({
    trajectoryId: "old-1",
    sessionKey: "session-1",
    goal: "Fix the failing test suite",
    outcomeKind: "failure",
  });

  const result = scoreStitchCandidate(newTraj, candidate);
  assert.equal(result.edgeType, "retry");
});

test("scoreStitchCandidate returns zero for unrelated trajectories", () => {
  const newTraj = makeTrajectory({
    trajectoryId: "new-1",
    sessionKey: "session-2",
    goal: "Deploy kubernetes infrastructure",
  });
  const candidate = makeTrajectory({
    trajectoryId: "old-1",
    sessionKey: "session-1",
    goal: "Write a haiku about sunsets",
  });

  const result = scoreStitchCandidate(newTraj, candidate);
  // unrelated goals with no overlapping tokens/entities should score low
  assert.ok(result.score < 2.5, `Expected low score for unrelated, got ${result.score}`);
});

// ─── Chain Index ─────────────────────────────────────────────────────────────

test("readChainIndex returns empty index when file does not exist", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "engram-chain-idx-"));
  const index = await readChainIndex(path.join(tmpDir, "nonexistent"));
  assert.deepEqual(index.outgoing, {});
  assert.deepEqual(index.incoming, {});
  assert.deepEqual(index.edges, {});
});

test("writeChainIndex and readChainIndex roundtrip", async () => {
  const chainsDir = await mkdtemp(path.join(os.tmpdir(), "engram-chain-rt-"));
  const edge: CausalEdge = {
    schemaVersion: 1,
    edgeId: "edge-test1",
    fromTrajectoryId: "traj-a",
    toTrajectoryId: "traj-b",
    edgeType: "continuation",
    confidence: 0.6,
    stitchMethod: "lexical",
    createdAt: "2026-03-16T10:00:00.000Z",
  };

  const index: CausalChainIndex = {
    outgoing: { "traj-a": ["edge-test1"] },
    incoming: { "traj-b": ["edge-test1"] },
    edges: { "edge-test1": edge },
    updatedAt: "2026-03-16T10:00:00.000Z",
  };

  await writeChainIndex(chainsDir, index);
  const loaded = await readChainIndex(chainsDir);

  assert.deepEqual(loaded.outgoing, index.outgoing);
  assert.deepEqual(loaded.incoming, index.incoming);
  assert.equal(loaded.edges["edge-test1"].edgeId, "edge-test1");
});

// ─── resolveChainsDir ────────────────────────────────────────────────────────

test("resolveChainsDir uses default path", () => {
  const dir = resolveChainsDir("/tmp/engram");
  assert.equal(dir, path.join("/tmp/engram", "state", "causal-trajectories", "chains"));
});

test("resolveChainsDir treats custom store dir as the resolved store root", () => {
  const dir = resolveChainsDir("/tmp/engram", "custom/store");
  assert.equal(dir, path.join("custom/store", "chains"));
});

// ─── End-to-end stitching ────────────────────────────────────────────────────

test("stitchCausalChain creates edges for related cross-session trajectories", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-stitch-e2e-"));

  // Record a trajectory from session-1
  await recordCausalTrajectory({
    memoryDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "traj-old",
      recordedAt: new Date(Date.now() - 3_600_000).toISOString(), // 1 hour ago
      sessionKey: "session-1",
      goal: "Fix authentication error handling in login flow",
      actionSummary: "Added try-catch blocks to login handler",
      observationSummary: "Errors now caught but not reported to user",
      outcomeKind: "partial",
      outcomeSummary: "Error handling works but needs user-facing messages",
      followUpSummary: "Add user-facing error messages to authentication flow",
      entityRefs: ["module:auth", "repo:main"],
      tags: ["auth", "error-handling"],
    },
  });

  // New trajectory from session-2 that follows up
  const newTrajectory: CausalTrajectoryRecord = {
    schemaVersion: 1,
    trajectoryId: "traj-new",
    recordedAt: new Date().toISOString(),
    sessionKey: "session-2",
    goal: "Add user-facing error messages to authentication flow",
    actionSummary: "Created error message components for login page",
    observationSummary: "Error messages display correctly",
    outcomeKind: "success",
    outcomeSummary: "Authentication flow now shows proper error messages",
    entityRefs: ["module:auth", "repo:main"],
    tags: ["auth", "error-handling", "ux"],
  };

  const edges = await stitchCausalChain({
    memoryDir,
    newTrajectory,
    config: {
      lookbackDays: 7,
      minScore: 1.0, // lower threshold for test
      maxEdgesPerTrajectory: 3,
    },
  });

  assert.ok(edges.length > 0, "Expected at least one stitched edge");
  assert.equal(edges[0].fromTrajectoryId, "traj-old");
  assert.equal(edges[0].toTrajectoryId, "traj-new");

  // Verify chain index was updated
  const chainsDir = resolveChainsDir(memoryDir);
  const index = await readChainIndex(chainsDir);
  assert.ok(Object.keys(index.edges).length > 0);
  assert.ok(index.outgoing["traj-old"]?.length > 0);
  assert.ok(index.incoming["traj-new"]?.length > 0);
});

test("stitchCausalChain skips same-session trajectories", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-stitch-same-"));

  await recordCausalTrajectory({
    memoryDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "traj-same-1",
      recordedAt: new Date(Date.now() - 60_000).toISOString(),
      sessionKey: "session-1",
      goal: "Same session goal",
      actionSummary: "Did something",
      observationSummary: "Observed it",
      outcomeKind: "success",
      outcomeSummary: "It worked",
    },
  });

  const newTrajectory: CausalTrajectoryRecord = {
    schemaVersion: 1,
    trajectoryId: "traj-same-2",
    recordedAt: new Date().toISOString(),
    sessionKey: "session-1", // same session
    goal: "Same session goal continued",
    actionSummary: "Did more",
    observationSummary: "Observed more",
    outcomeKind: "success",
    outcomeSummary: "Still worked",
  };

  const edges = await stitchCausalChain({
    memoryDir,
    newTrajectory,
    config: { lookbackDays: 7, minScore: 0.1, maxEdgesPerTrajectory: 3 },
  });

  assert.equal(edges.length, 0, "Same-session trajectories should not be stitched");
});

test("stitchCausalChain returns empty array when no candidates exist", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-stitch-empty-"));
  const edges = await stitchCausalChain({
    memoryDir,
    newTrajectory: makeTrajectory(),
    config: { lookbackDays: 7, minScore: 2.5, maxEdgesPerTrajectory: 3 },
  });
  assert.equal(edges.length, 0);
});
