/**
 * Markdown renderer for a deep-recall trace (issue #2332 leftover).
 *
 * Deterministic. Surfaces wait. Empty working set prints (empty).
 */

import type { DeepRecallResult } from "./recall-deep.js";

export function renderDeepRecallTrace(result: DeepRecallResult): string {
  const last = result.trace[result.trace.length - 1];
  const stop = !last ? "none" : last.budget <= 0 ? "budget exhausted" : last.action;
  const steps =
    result.trace.length === 0
      ? ["(empty)"]
      : result.trace.map((step, index) => {
          const workingSet = step.workingSet.length === 0 ? "(empty)" : step.workingSet.join(", ");
          const frontier = step.frontier.length === 0 ? "(empty)" : step.frontier.join(", ");
          return `${index + 1}. ${step.action} budget=${step.budget} workingSet=${workingSet} frontier=${frontier}`;
        });
  return [
    "# Deep recall",
    "",
    `- query: ${result.state.query}`,
    `- budget: ${result.state.budget}`,
    `- stop: ${stop}`,
    "",
    "## Steps",
    "",
    ...steps,
    "",
  ].join("\n");
}
