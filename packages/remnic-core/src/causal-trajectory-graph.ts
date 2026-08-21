import { appendEdge, type GraphEdge } from "./graph.js";
import type { CausalTrajectoryRecord } from "./causal-trajectory.js";

export type CausalTrajectoryGraphStage = "goal" | "action" | "observation" | "outcome" | "follow_up";

export function causalTrajectoryGraphNodeId(trajectoryId: string, stage: CausalTrajectoryGraphStage): string {
  return `causal-trajectory/${trajectoryId}#${stage}`;
}

export function buildCausalTrajectoryGraphEdges(record: CausalTrajectoryRecord): GraphEdge[] {
  const edges: GraphEdge[] = [
    {
      from: causalTrajectoryGraphNodeId(record.trajectoryId, "goal"),
      to: causalTrajectoryGraphNodeId(record.trajectoryId, "action"),
      type: "causal",
      weight: 1.0,
      label: "goal_to_action",
      ts: record.recordedAt,
    },
    {
      from: causalTrajectoryGraphNodeId(record.trajectoryId, "action"),
      to: causalTrajectoryGraphNodeId(record.trajectoryId, "observation"),
      type: "causal",
      weight: 1.0,
      label: "action_to_observation",
      ts: record.recordedAt,
    },
    {
      from: causalTrajectoryGraphNodeId(record.trajectoryId, "observation"),
      to: causalTrajectoryGraphNodeId(record.trajectoryId, "outcome"),
      type: "causal",
      weight: 1.0,
      label: `observation_to_outcome:${record.outcomeKind}`,
      ts: record.recordedAt,
    },
  ];

  if (record.followUpSummary) {
    edges.push({
      from: causalTrajectoryGraphNodeId(record.trajectoryId, "outcome"),
      to: causalTrajectoryGraphNodeId(record.trajectoryId, "follow_up"),
      type: "causal",
      weight: 1.0,
      label: "outcome_to_follow_up",
      ts: record.recordedAt,
    });
  }

  return edges;
}

export async function appendCausalTrajectoryGraphEdges(options: {
  memoryDir: string;
  record: CausalTrajectoryRecord;
}): Promise<void> {
  const edges = buildCausalTrajectoryGraphEdges(options.record);
  for (const edge of edges) {
    await appendEdge(options.memoryDir, edge);
  }
}
