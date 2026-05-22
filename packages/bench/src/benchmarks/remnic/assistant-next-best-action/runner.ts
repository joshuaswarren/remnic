/**
 * Assistant bench: next-best-action.
 *
 * Given current state, what should the user do next? Judged on grounding in
 * the memory graph (not generic advice) and on calibration — abstaining on
 * weak-evidence questions rather than confidently inventing answers.
 */

import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
} from "../../../types.js";
import {
  ASSISTANT_NEXT_BEST_ACTION_SCENARIOS,
  ASSISTANT_NEXT_BEST_ACTION_SMOKE_SCENARIOS,
} from "./fixture.js";
import {
  runAssistantBenchmark,
  resolveAssistantAgent,
  resolveAssistantRubricId,
  resolveAssistantSeeds,
  resolveAssistantSpotCheckDir,
  resolveStructuredJudge,
} from "../_assistant-common/index.js";

export const assistantNextBestActionDefinition: BenchmarkDefinition = {
  id: "assistant-next-best-action",
  title: "Assistant: Next Best Action",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "assistant-next-best-action",
    version: "1.0.0",
    description:
      "Sealed-rubric assistant evaluation for next-best-action recommendations: memory grounding, actionability, and calibrated abstention.",
    category: "conversational",
    citation: "Remnic internal synthetic benchmark for issue #450",
  },
};

export async function runAssistantNextBestActionBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const scenarios =
    options.mode === "quick"
      ? ASSISTANT_NEXT_BEST_ACTION_SMOKE_SCENARIOS
      : ASSISTANT_NEXT_BEST_ACTION_SCENARIOS;

  const limited = applyScenarioLimit(scenarios, options.limit);

  if (limited.length === 0) {
    throw new Error(
      "assistant-next-best-action fixture is empty after applying the requested limit.",
    );
  }

  return runAssistantBenchmark(
    assistantNextBestActionDefinition,
    limited,
    options,
    {
      agent: resolveAssistantAgent(options),
      judge: resolveStructuredJudge(options),
      seeds: resolveAssistantSeeds(options),
      spotCheckDir: resolveAssistantSpotCheckDir(options),
      rubricId: resolveAssistantRubricId(options),
    },
  );
}

function applyScenarioLimit<T>(scenarios: T[], limit: number | undefined): T[] {
  if (limit === undefined) {
    return scenarios;
  }
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) {
    throw new Error(
      `assistant-next-best-action limit must be a positive integer; received ${String(limit)}.`,
    );
  }
  return scenarios.slice(0, limit);
}
