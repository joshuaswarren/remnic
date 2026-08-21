import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  synthesizeCausalPreferences,
  computeCausalImpactScore,
  extractCausalBehaviorSignals,
  type CausalBehaviorSignal,
} from "../src/causal-behavior.js";
import { parseConfig } from "../src/config.js";
import { recordCausalTrajectory } from "../src/causal-trajectory.js";
import { writeChainIndex, resolveChainsDir, type CausalChainIndex, type CausalEdge } from "../src/causal-chain.js";

// ─── synthesizeCausalPreferences ─────────────────────────────────────────────

test("synthesizeCausalPreferences converts topic_revisitation signal", () => {
  const signals: CausalBehaviorSignal[] = [
    {
      signalType: "topic_revisitation",
      pattern: "Fix authentication errors",
      frequency: 5,
      sessionCount: 3,
      confidence: 0.8,
      trajectoryIds: ["t1", "t2", "t3", "t4", "t5"],
    },
  ];

  const prefs = synthesizeCausalPreferences(signals, 0.6);
  assert.equal(prefs.length, 1);
  assert.ok(prefs[0].statement.includes("frequently works on"));
  assert.ok(prefs[0].statement.includes("Fix authentication errors"));
  assert.equal(prefs[0].category, "preference");
  assert.equal(prefs[0].confidence, 0.8);
});

test("synthesizeCausalPreferences converts action_pattern signal", () => {
  const signals: CausalBehaviorSignal[] = [
    {
      signalType: "action_pattern",
      pattern: "Run test suite before deploying",
      frequency: 8,
      sessionCount: 4,
      confidence: 0.85,
      trajectoryIds: ["t1", "t2"],
    },
  ];

  const prefs = synthesizeCausalPreferences(signals, 0.6);
  assert.equal(prefs.length, 1);
  assert.ok(prefs[0].statement.includes("prefers this approach"));
});

test("synthesizeCausalPreferences converts outcome_preference signal", () => {
  const signals: CausalBehaviorSignal[] = [
    {
      signalType: "outcome_preference",
      pattern: "Complete code review process",
      frequency: 4,
      sessionCount: 3,
      confidence: 0.75,
      trajectoryIds: ["t1"],
    },
  ];

  const prefs = synthesizeCausalPreferences(signals, 0.6);
  assert.equal(prefs.length, 1);
  assert.ok(prefs[0].statement.includes("persistently pursues"));
});

test("synthesizeCausalPreferences filters by confidence threshold", () => {
  const signals: CausalBehaviorSignal[] = [
    {
      signalType: "topic_revisitation",
      pattern: "Low confidence topic",
      frequency: 3,
      sessionCount: 2,
      confidence: 0.4,
      trajectoryIds: ["t1"],
    },
  ];

  const prefs = synthesizeCausalPreferences(signals, 0.6);
  assert.equal(prefs.length, 0);
});

// ─── computeCausalImpactScore ────────────────────────────────────────────────

test("computeCausalImpactScore returns 0 for unknown trajectory", () => {
  const index: CausalChainIndex = {
    outgoing: {},
    incoming: {},
    edges: {},
    updatedAt: new Date().toISOString(),
  };
  assert.equal(computeCausalImpactScore("unknown-id", index), 0);
});

test("computeCausalImpactScore computes from edge counts", () => {
  const index: CausalChainIndex = {
    outgoing: { "traj-1": ["e1", "e2"] },
    incoming: { "traj-1": ["e3"] },
    edges: {},
    updatedAt: new Date().toISOString(),
  };
  // 0.1 * 1 (incoming) + 0.15 * 2 (outgoing) = 0.1 + 0.3 = 0.4 → clamped to 0.3
  const score = computeCausalImpactScore("traj-1", index);
  assert.equal(score, 0.3);
});

test("computeCausalImpactScore clamps to [0, 0.3]", () => {
  const index: CausalChainIndex = {
    outgoing: { "traj-1": ["e1", "e2", "e3", "e4", "e5"] },
    incoming: { "traj-1": ["e6", "e7", "e8"] },
    edges: {},
    updatedAt: new Date().toISOString(),
  };
  const score = computeCausalImpactScore("traj-1", index);
  assert.equal(score, 0.3);
});

// ─── extractCausalBehaviorSignals ────────────────────────────────────────────

test("extractCausalBehaviorSignals returns empty for empty store", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-behavior-empty-"));
  const signals = await extractCausalBehaviorSignals({
    memoryDir,
    config: { minFrequency: 3, minSessions: 2, confidenceThreshold: 0.6 },
  });
  assert.equal(signals.length, 0);
});

test("extractCausalBehaviorSignals detects topic revisitation", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-behavior-topic-"));

  // Record same-goal trajectories across sessions
  for (let i = 0; i < 4; i++) {
    await recordCausalTrajectory({
      memoryDir,
      record: {
        schemaVersion: 1,
        trajectoryId: `traj-topic-${i}`,
        recordedAt: new Date(Date.now() - i * 86_400_000).toISOString(),
        sessionKey: `session-${i}`,
        goal: "Fix authentication error handling",
        actionSummary: "Patched login handler",
        observationSummary: "Tests pass",
        outcomeKind: "success",
        outcomeSummary: "Auth fixed",
      },
    });
  }

  const signals = await extractCausalBehaviorSignals({
    memoryDir,
    config: { minFrequency: 3, minSessions: 2, confidenceThreshold: 0.6 },
  });

  const topicSignals = signals.filter((s) => s.signalType === "topic_revisitation");
  assert.ok(topicSignals.length > 0, "Expected topic revisitation signal");
  assert.ok(topicSignals[0].frequency >= 3);
});

test("extractCausalBehaviorSignals reads trajectories from parsed config store dir", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-behavior-config-dir-"));
  const cfg = parseConfig({ memoryDir });

  for (let i = 0; i < 3; i++) {
    await recordCausalTrajectory({
      memoryDir: cfg.memoryDir,
      causalTrajectoryStoreDir: cfg.causalTrajectoryStoreDir,
      record: {
        schemaVersion: 1,
        trajectoryId: `traj-config-topic-${i}`,
        recordedAt: new Date(Date.UTC(2026, 4, i + 1, 10)).toISOString(),
        sessionKey: `session-config-${i}`,
        goal: "Fix authentication error handling",
        actionSummary: "Patched login handler",
        observationSummary: "Tests pass",
        outcomeKind: "success",
        outcomeSummary: "Auth fixed",
      },
    });
  }

  const signals = await extractCausalBehaviorSignals({
    memoryDir: cfg.memoryDir,
    causalTrajectoryStoreDir: cfg.causalTrajectoryStoreDir,
    config: { minFrequency: 3, minSessions: 2, confidenceThreshold: 0.6 },
  });

  const topicSignals = signals.filter((s) => s.signalType === "topic_revisitation");
  assert.equal(topicSignals.length, 1);
  assert.deepEqual(topicSignals[0].trajectoryIds, [
    "traj-config-topic-0",
    "traj-config-topic-1",
    "traj-config-topic-2",
  ]);
});

test("extractCausalBehaviorSignals detects action patterns", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-behavior-action-"));

  // Record same-action trajectories with high success rate
  for (let i = 0; i < 5; i++) {
    await recordCausalTrajectory({
      memoryDir,
      record: {
        schemaVersion: 1,
        trajectoryId: `traj-action-${i}`,
        recordedAt: new Date(Date.now() - i * 86_400_000).toISOString(),
        sessionKey: `session-${i % 3}`, // 3 distinct sessions
        goal: `Task number ${i}`,
        actionSummary: "Run comprehensive test suite before deployment",
        observationSummary: "All tests pass",
        outcomeKind: "success",
        outcomeSummary: "Deploy successful",
      },
    });
  }

  const signals = await extractCausalBehaviorSignals({
    memoryDir,
    config: { minFrequency: 3, minSessions: 2, confidenceThreshold: 0.6 },
  });

  const actionSignals = signals.filter((s) => s.signalType === "action_pattern");
  assert.ok(actionSignals.length > 0, "Expected action pattern signal");
});
