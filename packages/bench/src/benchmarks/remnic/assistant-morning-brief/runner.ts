/**
 * Assistant bench: proactive morning brief.
 *
 * Exercises whether the assistant can surface what the user should know and
 * act on first when they sit down in the morning. Scored by a sealed rubric
 * along identity_accuracy, stance_coherence, novelty, and calibration.
 */

import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
} from "../../../types.js";
import {
  ASSISTANT_MORNING_BRIEF_SCENARIOS,
  ASSISTANT_MORNING_BRIEF_SMOKE_SCENARIOS,
} from "./fixture.js";
import {
  runAssistantBenchmark,
  resolveAssistantAgent,
  resolveAssistantRubricId,
  resolveAssistantSeeds,
  resolveAssistantSpotCheckDir,
  resolveStructuredJudge,
} from "../_assistant-common/index.js";

export const assistantMorningBriefDefinition: BenchmarkDefinition = {
  id: "assistant-morning-brief",
  title: "Assistant: Morning Brief",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "assistant-morning-brief",
    version: "1.0.0",
    description:
      "Sealed-rubric assistant evaluation for proactive morning briefs: relevance, prioritization, staleness, and signal-to-noise.",
    category: "conversational",
    citation: "Remnic internal synthetic benchmark for issue #450",
  },
};

export async function runAssistantMorningBriefBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const scenarios =
    options.mode === "quick"
      ? ASSISTANT_MORNING_BRIEF_SMOKE_SCENARIOS
      : ASSISTANT_MORNING_BRIEF_SCENARIOS;

  const limited =
    typeof options.limit === "number" && options.limit > 0
      ? scenarios.slice(0, options.limit)
      : scenarios;

  if (limited.length === 0) {
    throw new Error(
      "assistant-morning-brief fixture is empty after applying the requested limit.",
    );
  }

  return runAssistantBenchmark(
    assistantMorningBriefDefinition,
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
