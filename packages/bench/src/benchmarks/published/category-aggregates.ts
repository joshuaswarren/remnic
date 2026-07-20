import { aggregateTaskScores } from "../../scorer.js";
import type { AggregateMetrics, TaskResult } from "../../types.js";

/**
 * Group finished task results by their `categoryName` detail and aggregate
 * each group's scores, reusing the same `aggregateTaskScores` the overall
 * result uses. Benchmarks that stamp a `categoryName` detail (LoCoMo) get a
 * per-category breakdown — e.g. the adversarial-vs-answerable split issue
 * #1878 tracks — read straight from the artifact instead of hand-computed
 * from task-id category suffixes.
 *
 * It reads only the category label, never the question, expected answer, or
 * evidence, so it cannot leak an oracle signal into scoring. Tasks without a
 * non-empty string `categoryName` are skipped so a malformed detail cannot
 * fabricate a bucket. Output keys are sorted for deterministic, diff-stable
 * serialization; benchmarks that stamp no category yield an empty map.
 */
export function computeCategoryAggregates(tasks: readonly TaskResult[]): Record<string, AggregateMetrics> {
  const scoresByCategory = new Map<string, Record<string, number>[]>();
  for (const task of tasks) {
    const categoryName = task.details?.categoryName;
    if (typeof categoryName !== "string" || categoryName.length === 0) {
      continue;
    }
    const bucket = scoresByCategory.get(categoryName);
    if (bucket) {
      bucket.push(task.scores);
    } else {
      scoresByCategory.set(categoryName, [task.scores]);
    }
  }
  const categoryAggregates: Record<string, AggregateMetrics> = {};
  for (const categoryName of [...scoresByCategory.keys()].sort()) {
    const scores = scoresByCategory.get(categoryName);
    if (scores) {
      categoryAggregates[categoryName] = aggregateTaskScores(scores);
    }
  }
  return categoryAggregates;
}
