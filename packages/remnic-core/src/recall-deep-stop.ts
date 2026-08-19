/**
 * Deep-recall stop predicate (issue #2332 leftover).
 *
 * Pure. Surfaces wait. Budget 0, stop policy, and expand-once after
 * one expansion halt. Unknown policy throws.
 */

export const DEEP_RECALL_STOP_POLICIES = ["stop", "expand-once"] as const;

export type DeepRecallStopPolicy = (typeof DEEP_RECALL_STOP_POLICIES)[number];

export interface DeepRecallStopInput {
  budgetLeft: number;
  policy: string;
  alreadyExpanded?: boolean;
}

export function isDeepRecallStopPolicy(value: unknown): value is DeepRecallStopPolicy {
  return typeof value === "string" && (DEEP_RECALL_STOP_POLICIES as readonly string[]).includes(value);
}

export function shouldStopDeepRecall(input: DeepRecallStopInput): boolean {
  if (!isDeepRecallStopPolicy(input.policy)) {
    throw new Error(
      `unknown deep recall stop policy: ${JSON.stringify(input.policy)}. Valid: ${DEEP_RECALL_STOP_POLICIES.join(", ")}`,
    );
  }
  if (input.budgetLeft <= 0) return true;
  if (input.policy === "stop") return true;
  return input.alreadyExpanded === true;
}
