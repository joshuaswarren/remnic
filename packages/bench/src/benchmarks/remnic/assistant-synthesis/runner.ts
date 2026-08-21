/**
 * Assistant bench: multi-document synthesis with stance.
 *
 * "What does the brain think about X?" — the agent must integrate across
 * multiple memory items and reflect the user's previously-expressed stance,
 * rather than regurgitating the single top-k chunk.
 */

import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
} from "../../../types.js";
import {
  ASSISTANT_SYNTHESIS_SCENARIOS,
  ASSISTANT_SYNTHESIS_SMOKE_SCENARIOS,
} from "./fixture.js";
import {
  runAssistantBenchmark,
  resolveAssistantAgent,
  resolveAssistantRubricId,
  resolveAssistantSeeds,
  resolveAssistantSpotCheckDir,
  resolveStructuredJudge,
} from "../_assistant-common/index.js";

export const assistantSynthesisDefinition: BenchmarkDefinition = {
  id: "assistant-synthesis",
  title: "Assistant: Synthesis",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "assistant-synthesis",
    version: "1.0.0",
    description:
      "Sealed-rubric assistant evaluation for multi-document synthesis: stance coherence across sources and novelty beyond single-document regurgitation.",
    category: "conversational",
    citation: "Remnic internal synthetic benchmark for issue #450",
  },
};

export async function runAssistantSynthesisBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const scenarios =
    options.mode === "quick"
      ? ASSISTANT_SYNTHESIS_SMOKE_SCENARIOS
      : ASSISTANT_SYNTHESIS_SCENARIOS;

  const limited =
    typeof options.limit === "number" && options.limit > 0
      ? scenarios.slice(0, options.limit)
      : scenarios;

  if (limited.length === 0) {
    throw new Error(
      "assistant-synthesis fixture is empty after applying the requested limit.",
    );
  }

  return runAssistantBenchmark(
    assistantSynthesisDefinition,
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
