import { aggregateTaskScores } from "../../scorer.js";
import type { AggregateMetrics, TaskResult } from "../../types.js";

export function overlapCount(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of right) {
    if (left.has(token)) count += 1;
  }
  return count;
}

function prefixAggregates(
  prefix: string,
  aggregates: AggregateMetrics,
): AggregateMetrics {
  const prefixed: AggregateMetrics = {};

  for (const [metric, aggregate] of Object.entries(aggregates)) {
    prefixed[`${prefix}.${metric}`] = aggregate;
  }

  return prefixed;
}

function pairIdFromTaskId(taskId: string): string {
  return taskId.replace(/^(clean|dirty):/, "");
}

export function buildTieredAggregates(tasks: TaskResult[]): AggregateMetrics {
  const cleanTasks = tasks.filter((task) => task.details?.tier === "clean");
  const dirtyTasks = tasks.filter((task) => task.details?.tier === "dirty");
  const dirtyTasksByPairId = new Map(
    dirtyTasks.map((task) => [pairIdFromTaskId(task.taskId), task]),
  );
  const pairedDeltas = cleanTasks.flatMap((task) => {
    const dirtyTask = dirtyTasksByPairId.get(pairIdFromTaskId(task.taskId));
    if (!dirtyTask) return [];

    const metricNames = new Set([
      ...Object.keys(task.scores),
      ...Object.keys(dirtyTask.scores),
    ]);
    const deltaScores: Record<string, number> = {};

    for (const metricName of metricNames) {
      deltaScores[metricName] =
        (task.scores[metricName] ?? 0) - (dirtyTask.scores[metricName] ?? 0);
    }

    return [deltaScores];
  });

  return {
    ...prefixAggregates("clean", aggregateTaskScores(cleanTasks.map((task) => task.scores))),
    ...prefixAggregates("dirty", aggregateTaskScores(dirtyTasks.map((task) => task.scores))),
    ...prefixAggregates("dirty_penalty", aggregateTaskScores(pairedDeltas)),
  };
}
