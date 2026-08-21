import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  appendCausalTrajectoryGraphEdges,
  buildCausalTrajectoryGraphEdges,
  causalTrajectoryGraphNodeId,
} from "../src/causal-trajectory-graph.js";
import { readEdges } from "../src/graph.js";
import { recordCausalTrajectory, type CausalTrajectoryRecord } from "../src/causal-trajectory.js";

function buildRecord(overrides: Partial<CausalTrajectoryRecord> = {}): CausalTrajectoryRecord {
  return {
    schemaVersion: 1,
    trajectoryId: "traj-graph-1",
    recordedAt: "2026-03-07T17:10:00.000Z",
    sessionKey: "session-pr9",
    goal: "Repair PR loop state cleanly",
    actionSummary: "Shared graph/store validation helpers",
    observationSummary: "The old unresolved-thread failure was stale",
    outcomeKind: "success",
    outcomeSummary: "The PR became merge-ready again",
    followUpSummary: "Start the next causal-memory slice",
    ...overrides,
  };
}

test("buildCausalTrajectoryGraphEdges derives deterministic action-conditioned edges", () => {
  const record = buildRecord();

  const edges = buildCausalTrajectoryGraphEdges(record);

  assert.deepEqual(
    edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      label: edge.label,
      type: edge.type,
    })),
    [
      {
        from: causalTrajectoryGraphNodeId("traj-graph-1", "goal"),
        to: causalTrajectoryGraphNodeId("traj-graph-1", "action"),
        label: "goal_to_action",
        type: "causal",
      },
      {
        from: causalTrajectoryGraphNodeId("traj-graph-1", "action"),
        to: causalTrajectoryGraphNodeId("traj-graph-1", "observation"),
        label: "action_to_observation",
        type: "causal",
      },
      {
        from: causalTrajectoryGraphNodeId("traj-graph-1", "observation"),
        to: causalTrajectoryGraphNodeId("traj-graph-1", "outcome"),
        label: "observation_to_outcome:success",
        type: "causal",
      },
      {
        from: causalTrajectoryGraphNodeId("traj-graph-1", "outcome"),
        to: causalTrajectoryGraphNodeId("traj-graph-1", "follow_up"),
        label: "outcome_to_follow_up",
        type: "causal",
      },
    ],
  );
});

test("appendCausalTrajectoryGraphEdges writes action-conditioned edges into the causal graph", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-causal-graph-writer-"));
  try {
    await appendCausalTrajectoryGraphEdges({
      memoryDir,
      record: buildRecord(),
    });

    const edges = await readEdges(memoryDir, "causal");
    assert.equal(edges.length, 4);
    assert.equal(edges[0].from, "causal-trajectory/traj-graph-1#goal");
    assert.equal(edges[3].to, "causal-trajectory/traj-graph-1#follow_up");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("recordCausalTrajectory can append graph edges when action graph wiring is enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-causal-graph-record-"));
  try {
    await recordCausalTrajectory({
      memoryDir,
      actionGraphRecallEnabled: true,
      record: buildRecord({
        trajectoryId: "traj-graph-2",
        followUpSummary: undefined,
      }),
    });

    const edges = await readEdges(memoryDir, "causal");
    assert.deepEqual(
      edges.map((edge) => edge.label),
      [
        "goal_to_action",
        "action_to_observation",
        "observation_to_outcome:success",
      ],
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("recordCausalTrajectory does not append graph edges when action graph wiring is disabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-causal-graph-off-"));
  try {
    await recordCausalTrajectory({
      memoryDir,
      actionGraphRecallEnabled: false,
      record: buildRecord({
        trajectoryId: "traj-graph-3",
      }),
    });

    const edges = await readEdges(memoryDir, "causal");
    assert.deepEqual(edges, []);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("recordCausalTrajectory fail-opens when graph append fails after the trajectory file is written", async () => {
  const graphFailureRoot = await mkdtemp(path.join(os.tmpdir(), "engram-causal-graph-fail-root-"));
  const trajectoryStoreDir = await mkdtemp(path.join(os.tmpdir(), "engram-causal-graph-fail-store-"));
  const blockingFile = path.join(graphFailureRoot, "not-a-directory");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(blockingFile, "block graph dir", "utf8"));

  try {
    const filePath = await recordCausalTrajectory({
      memoryDir: blockingFile,
      causalTrajectoryStoreDir: trajectoryStoreDir,
      actionGraphRecallEnabled: true,
      record: buildRecord({
        trajectoryId: "traj-graph-4",
      }),
    });

    assert.equal(filePath, path.join(trajectoryStoreDir, "trajectories", "2026-03-07", "traj-graph-4.json"));
  } finally {
    await rm(graphFailureRoot, { recursive: true, force: true });
    await rm(trajectoryStoreDir, { recursive: true, force: true });
  }
});
