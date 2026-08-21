/**
 * Assistant bench: meeting prep.
 *
 * Given an upcoming meeting and attendees, generate a prep brief. Judged on
 * attendee-context accuracy, topic recall, and open-thread surfacing.
 */

import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
} from "../../../types.js";
import {
  ASSISTANT_MEETING_PREP_SCENARIOS,
  ASSISTANT_MEETING_PREP_SMOKE_SCENARIOS,
} from "./fixture.js";
import {
  runAssistantBenchmark,
  resolveAssistantAgent,
  resolveAssistantRubricId,
  resolveAssistantSeeds,
  resolveAssistantSpotCheckDir,
  resolveStructuredJudge,
} from "../_assistant-common/index.js";

export const assistantMeetingPrepDefinition: BenchmarkDefinition = {
  id: "assistant-meeting-prep",
  title: "Assistant: Meeting Prep",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "assistant-meeting-prep",
    version: "1.0.0",
    description:
      "Sealed-rubric assistant evaluation for meeting prep: attendee context, topic recall, open-thread surfacing.",
    category: "conversational",
    citation: "Remnic internal synthetic benchmark for issue #450",
  },
};

export async function runAssistantMeetingPrepBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const scenarios =
    options.mode === "quick"
      ? ASSISTANT_MEETING_PREP_SMOKE_SCENARIOS
      : ASSISTANT_MEETING_PREP_SCENARIOS;

  const limited =
    typeof options.limit === "number" && options.limit > 0
      ? scenarios.slice(0, options.limit)
      : scenarios;

  if (limited.length === 0) {
    throw new Error(
      "assistant-meeting-prep fixture is empty after applying the requested limit.",
    );
  }

  return runAssistantBenchmark(
    assistantMeetingPrepDefinition,
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
