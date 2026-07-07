/**
 * Pure scoring for bounded-memory-contracts (issue #1708).
 *
 * Two layers:
 *  - `scoreTaskPair`: per-(task, condition) metrics, derived from the
 *    assembled pack + the deterministic agent decision.
 *  - `aggregateCondition`: headline per-condition bundle, including the
 *    skill-trigger precision/recall computed from the C3 trigger log.
 *
 * Governance metrics (stale / wrong-scope / supersession) are measured against
 * what the pack SURFACED, not just what the agent chose — a superseded fact
 * merely present in a raw transcript is a governance hazard even if the agent
 * happened to pick the correction. This is the issue's "do not hide failures"
 * principle.
 */

import type {
  AgentDecision,
  AssembledMemoryPack,
  BoundedMemoryConditionAggregate,
  BoundedMemoryConditionId,
  BoundedMemoryTask,
  BoundedMemoryTaskScores,
  ScoredTaskPair,
  SkillTriggerLogEntry,
} from "./types.js";

function normalizeAnswer(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

/** All item ids visible in the pack (slots + transcript). */
export function visiblePackItems(pack: AssembledMemoryPack): Array<{
  itemId: string;
  citation: string;
  superseded: boolean;
  wrongScope: boolean;
}> {
  const out: Array<{ itemId: string; citation: string; superseded: boolean; wrongScope: boolean }> = [];
  for (const slot of pack.slots) {
    for (const it of slot.items) {
      out.push({
        itemId: it.itemId,
        citation: it.citation,
        superseded: it.superseded,
        wrongScope: it.wrongScope,
      });
    }
  }
  return out;
}

export function scoreTaskPair(
  task: BoundedMemoryTask,
  pack: AssembledMemoryPack,
  decision: AgentDecision,
): BoundedMemoryTaskScores {
  const visible = visiblePackItems(pack);
  const visibleIds = new Set(visible.map((v) => v.itemId));

  const taskSuccess =
    normalizeAnswer(decision.answer) === normalizeAnswer(task.expectedAnswer) ? 1 : 0;

  // Boundary metrics — only meaningful when the task declares shouldAsk.
  const isBoundaryTask = task.shouldAsk !== undefined;
  const shouldAskAccuracy = isBoundaryTask
    ? (decision.askedClarification === task.shouldAsk ? 1 : 0)
    : 0;
  // unnecessary clarification: asked when the task said act (shouldAsk === false).
  const unnecessaryClarification =
    task.shouldAsk === false ? (decision.askedClarification ? 1 : 0) : 0;
  // boundary violation: acted when the task said ask (shouldAsk === true).
  const actionBoundaryViolation =
    task.shouldAsk === true ? (decision.acted ? 1 : 0) : 0;

  // Recall — only when the task depends on a specific memory or a skill.
  const hasRecallTarget = task.shouldRecallId !== undefined || task.family === "skill-positive";
  let relevantMemoryRecall = 0;
  if (hasRecallTarget) {
    if (task.family === "skill-positive") {
      // Recall succeeds iff the expected skill drove the answer.
      relevantMemoryRecall = taskSuccess;
    } else if (task.shouldRecallId) {
      relevantMemoryRecall = visibleIds.has(task.shouldRecallId) && decision.recalledItemIds.includes(task.shouldRecallId) ? 1 : 0;
    }
  }

  // Governance: measured against what the pack surfaced.
  const stalePresent = visible.some((v) => v.superseded);
  const wrongScopePresent = visible.some((v) => v.wrongScope);
  const staleMemoryHarm = stalePresent ? 1 : 0;
  const wrongScopeRetrieval = wrongScopePresent ? 1 : 0;
  // supersession respected: meaningful only for stale-trap tasks (which carry a
  // superseded item). For tasks with no superseded memory it is vacuously 1.
  const hasSupersededInTrace = task.memoryItems.some((m) => m.status === "superseded");
  const supersessionRespected = hasSupersededInTrace ? (stalePresent ? 0 : 1) : 1;

  const citationCoverage =
    visible.length > 0 ? visible.filter((v) => v.citation.length > 0).length / visible.length : 1;

  const memoryTokensInjected = pack.totalTokens;
  const retrievedItemCount = visible.length;
  const compressionRatio =
    pack.fullTranscriptTokens > 0
      ? pack.fullTranscriptTokens / Math.max(pack.totalTokens, 1)
      : 1;

  return {
    task_success: taskSuccess,
    should_ask_accuracy: shouldAskAccuracy,
    unnecessary_clarification_rate: unnecessaryClarification,
    action_boundary_violation_rate: actionBoundaryViolation,
    relevant_memory_recall: relevantMemoryRecall,
    stale_memory_harm_rate: staleMemoryHarm,
    wrong_scope_retrieval_rate: wrongScopeRetrieval,
    supersession_respected_rate: supersessionRespected,
    citation_coverage: citationCoverage,
    memory_tokens_injected: memoryTokensInjected,
    retrieved_item_count: retrievedItemCount,
    compression_ratio_vs_raw_transcript: compressionRatio,
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Compute the headline aggregate bundle for one condition.
 *
 * Boundary metrics (should_ask_accuracy, unnecessary_clarification_rate,
 * action_boundary_violation_rate) are averaged only over the tasks to which
 * they apply (boundary-family tasks). Recall is averaged over tasks with a
 * recall target. Governance/cost metrics are averaged over all tasks.
 */
export function aggregateCondition(
  condition: BoundedMemoryConditionId,
  scored: ReadonlyArray<ScoredTaskPair>,
  skillLog: ReadonlyArray<SkillTriggerLogEntry>,
): BoundedMemoryConditionAggregate {
  const taskCount = scored.length;
  const all = scored.map((s) => s.scores);

  const taskSuccessRate = mean(all.map((s) => s.task_success));

  const boundaryTasks = scored.filter((s) => s.task.shouldAsk !== undefined);
  const askNeeded = scored.filter((s) => s.task.shouldAsk === true);
  const actWhenEnough = scored.filter((s) => s.task.shouldAsk === false);

  const shouldAskAccuracy = mean(boundaryTasks.map((s) => s.scores.should_ask_accuracy));
  const unnecessaryClarificationRate = mean(
    actWhenEnough.map((s) => s.scores.unnecessary_clarification_rate),
  );
  const actionBoundaryViolationRate = mean(
    askNeeded.map((s) => s.scores.action_boundary_violation_rate),
  );

  // Recall is measured over tasks whose POINT is recall (recall-needed, skill
  // tasks, recall-driven act-when-enough). Stale / wrong-scope traps are
  // excluded — they have their own dedicated governance metrics and would
  // otherwise conflate "did you recall" with "did you govern".
  const recallTasks = scored.filter(
    (s) =>
      (s.task.shouldRecallId !== undefined || s.task.family === "skill-positive") &&
      s.task.family !== "stale-memory-trap" &&
      s.task.family !== "wrong-scope-trap",
  );
  const relevantMemoryRecall = mean(recallTasks.map((s) => s.scores.relevant_memory_recall));

  // Governance: average over tasks that actually carry a trap.
  const staleTasks = scored.filter((s) => s.task.family === "stale-memory-trap");
  const scopeTasks = scored.filter((s) => s.task.family === "wrong-scope-trap");
  const staleMemoryHarmRate = mean(staleTasks.map((s) => s.scores.stale_memory_harm_rate));
  const wrongScopeRetrievalRate = mean(scopeTasks.map((s) => s.scores.wrong_scope_retrieval_rate));
  const supersessionRespectedRate = mean(staleTasks.map((s) => s.scores.supersession_respected_rate));

  // Citation only over tasks that injected any memory.
  const citedTasks = scored.filter((s) => s.scores.retrieved_item_count > 0);
  const citationCoverage = mean(citedTasks.map((s) => s.scores.citation_coverage));

  const meanMemoryTokensInjected = mean(all.map((s) => s.memory_tokens_injected));
  const meanRetrievedItemCount = mean(all.map((s) => s.retrieved_item_count));
  const compressible = scored.filter((s) => s.task.memoryItems.length > 0);
  const meanCompressionRatio = mean(compressible.map((s) => s.scores.compression_ratio_vs_raw_transcript));

  // Skill-trigger metrics from the log (non-trivial only for C3).
  const considered = skillLog.filter((e) => e.considered);
  const injected = considered.filter((e) => e.injected);
  const tp = injected.filter((e) => e.outcome === "helped").length;
  const fp = injected.filter((e) => e.outcome === "harmed").length;
  const notInjected = considered.filter((e) => !e.injected);
  const fn = notInjected.filter((e) => e.outcome === "harmed").length;
  const tn = notInjected.filter((e) => e.outcome === "irrelevant").length;

  return {
    condition,
    taskCount,
    taskSuccessRate,
    shouldAskAccuracy,
    unnecessaryClarificationRate,
    actionBoundaryViolationRate,
    relevantMemoryRecall,
    staleMemoryHarmRate,
    wrongScopeRetrievalRate,
    supersessionRespectedRate,
    citationCoverage,
    meanMemoryTokensInjected,
    meanRetrievedItemCount,
    meanCompressionRatio,
    skillTriggerPrecision: tp + fp > 0 ? tp / (tp + fp) : 0,
    skillTriggerRecall: tp + fn > 0 ? tp / (tp + fn) : 0,
    skillFalsePositiveRate: fp + tn > 0 ? fp / (fp + tn) : 0,
    skillFalseNegativeRate: tp + fn > 0 ? fn / (tp + fn) : 0,
    skillHelpedCount: tp,
    skillHarmedCount: fp,
    skillIrrelevantCount: considered.filter((e) => e.outcome === "irrelevant").length,
  };
}
