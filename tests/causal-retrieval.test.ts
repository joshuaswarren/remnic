import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  formatCausalRetrievalSection,
  retrieveCausalChains,
  type CausalRetrievalResult,
} from "../src/causal-retrieval.js";
import { recordCausalTrajectory } from "../src/causal-trajectory.js";
import { writeChainIndex, resolveChainsDir, type CausalChainIndex, type CausalEdge } from "../src/causal-chain.js";

// ─── formatCausalRetrievalSection ────────────────────────────────────────────

test("formatCausalRetrievalSection returns null for empty results", () => {
  assert.equal(formatCausalRetrievalSection([], 800), null);
});

test("formatCausalRetrievalSection formats results with direction arrows", () => {
  const results: CausalRetrievalResult[] = [
    {
      trajectoryId: "traj-1",
      direction: "seed",
      depth: 0,
      score: 5,
      isCounterfactual: false,
      summary: "[success] Fix auth → Tests pass",
    },
    {
      trajectoryId: "traj-2",
      direction: "upstream",
      depth: 1,
      score: 3,
      edgeType: "follow_up_to_goal",
      edgeConfidence: 0.8,
      isCounterfactual: false,
      summary: "Depth 1: trajectory traj-2",
    },
    {
      trajectoryId: "traj-3",
      direction: "downstream",
      depth: 1,
      score: 2,
      edgeType: "continuation",
      edgeConfidence: 0.6,
      isCounterfactual: true,
      summary: "Depth 1: trajectory traj-3",
    },
  ];

  const section = formatCausalRetrievalSection(results, 2000);
  assert.ok(section !== null);
  assert.ok(section.includes("## Causal Chain Context"));
  assert.ok(section.includes("• [success] Fix auth → Tests pass"));
  assert.ok(section.includes("↑ Depth 1: trajectory traj-2 (follow_up_to_goal)"));
  assert.ok(section.includes("↓ Depth 1: trajectory traj-3 (continuation) [branching point]"));
});

test("formatCausalRetrievalSection respects maxChars", () => {
  const results: CausalRetrievalResult[] = Array.from({ length: 100 }, (_, i) => ({
    trajectoryId: `traj-${i}`,
    direction: "upstream" as const,
    depth: 1,
    score: 100 - i,
    isCounterfactual: false,
    summary: `This is a moderately long summary for trajectory number ${i} with additional details`,
  }));

  const section = formatCausalRetrievalSection(results, 300);
  assert.ok(section !== null);
  assert.ok(section.length <= 350); // some slack for header
});

// ─── retrieveCausalChains end-to-end ─────────────────────────────────────────

test("retrieveCausalChains returns null when no trajectories exist", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-retrieval-empty-"));
  const result = await retrieveCausalChains({
    memoryDir,
    query: "authentication errors",
    config: { maxDepth: 3, maxChars: 800, counterfactualBoost: 0.4 },
  });
  assert.equal(result, null);
});

test("retrieveCausalChains returns null when no chain edges exist", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-retrieval-noedge-"));

  await recordCausalTrajectory({
    memoryDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "traj-lonely",
      recordedAt: new Date().toISOString(),
      sessionKey: "session-1",
      goal: "Fix authentication errors in login",
      actionSummary: "Patched the handler",
      observationSummary: "Fixed",
      outcomeKind: "success",
      outcomeSummary: "Done",
    },
  });

  const result = await retrieveCausalChains({
    memoryDir,
    query: "authentication errors",
    config: { maxDepth: 3, maxChars: 800, counterfactualBoost: 0.4 },
  });
  assert.equal(result, null);
});

test("retrieveCausalChains walks chain and returns formatted section", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-retrieval-chain-"));

  // Record two trajectories
  await recordCausalTrajectory({
    memoryDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "traj-upstream",
      recordedAt: new Date(Date.now() - 3_600_000).toISOString(),
      sessionKey: "session-1",
      goal: "Investigate authentication failures",
      actionSummary: "Analyzed login error logs",
      observationSummary: "Found root cause in token validation",
      outcomeKind: "partial",
      outcomeSummary: "Root cause found, fix pending",
    },
  });

  await recordCausalTrajectory({
    memoryDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "traj-downstream",
      recordedAt: new Date().toISOString(),
      sessionKey: "session-2",
      goal: "Fix authentication token validation",
      actionSummary: "Patched token validator",
      observationSummary: "Login tests pass",
      outcomeKind: "success",
      outcomeSummary: "Authentication fixed",
    },
  });

  // Create a chain edge connecting them
  const chainsDir = resolveChainsDir(memoryDir);
  const edge: CausalEdge = {
    schemaVersion: 1,
    edgeId: "edge-test-retrieval",
    fromTrajectoryId: "traj-upstream",
    toTrajectoryId: "traj-downstream",
    edgeType: "follow_up_to_goal",
    confidence: 0.8,
    stitchMethod: "lexical",
    createdAt: new Date().toISOString(),
  };

  const index: CausalChainIndex = {
    outgoing: { "traj-upstream": ["edge-test-retrieval"] },
    incoming: { "traj-downstream": ["edge-test-retrieval"] },
    edges: { "edge-test-retrieval": edge },
    updatedAt: new Date().toISOString(),
  };
  await writeChainIndex(chainsDir, index);

  const result = await retrieveCausalChains({
    memoryDir,
    query: "authentication token validation fix",
    config: { maxDepth: 3, maxChars: 2000, counterfactualBoost: 0.4 },
  });

  assert.ok(result !== null, "Expected non-null retrieval section");
  assert.ok(result.includes("## Causal Chain Context"));
});

test("retrieveCausalChains formats connected trajectory content instead of only IDs", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-retrieval-content-"));

  await recordCausalTrajectory({
    memoryDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "traj-context-only",
      recordedAt: new Date(Date.now() - 3_600_000).toISOString(),
      sessionKey: "session-1",
      goal: "Review unclear incident report",
      actionSummary: "Read the traces and compared audit events",
      observationSummary: "Missing audit link was identified",
      outcomeKind: "partial",
      outcomeSummary: "Identified missing audit link for follow-up",
    },
  });

  await recordCausalTrajectory({
    memoryDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "traj-seed-payment",
      recordedAt: new Date().toISOString(),
      sessionKey: "session-2",
      goal: "Fix payment reconciliation regression",
      actionSummary: "Patched the payment reconciliation worker",
      observationSummary: "Payment reconciliation tests pass",
      outcomeKind: "success",
      outcomeSummary: "Payment reconciliation regression fixed",
    },
  });

  const chainsDir = resolveChainsDir(memoryDir);
  const edge: CausalEdge = {
    schemaVersion: 1,
    edgeId: "edge-content-retrieval",
    fromTrajectoryId: "traj-context-only",
    toTrajectoryId: "traj-seed-payment",
    edgeType: "follow_up_to_goal",
    confidence: 0.8,
    stitchMethod: "explicit",
    createdAt: new Date().toISOString(),
  };
  await writeChainIndex(chainsDir, {
    outgoing: { "traj-context-only": ["edge-content-retrieval"] },
    incoming: { "traj-seed-payment": ["edge-content-retrieval"] },
    edges: { "edge-content-retrieval": edge },
    updatedAt: new Date().toISOString(),
  });

  const result = await retrieveCausalChains({
    memoryDir,
    query: "payment reconciliation regression fixed",
    config: { maxDepth: 3, maxChars: 2000, counterfactualBoost: 0.4 },
  });

  assert.ok(result !== null, "Expected non-null retrieval section");
  assert.match(result, /Review unclear incident report/);
  assert.match(result, /Identified missing audit link for follow-up/);
  assert.doesNotMatch(result, /trajectory traj-context/);
});
