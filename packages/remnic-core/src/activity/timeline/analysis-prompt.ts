/**
 * Deterministic evidence-only analysis prompt (issue #2050).
 * No LLM call. Prompt lists observation id and capturedAtUtc only.
 */
export type AnalysisPromptObservation = {
  id: number;
  capturedAtUtc: string;
};

const INSTRUCTIONS =
  "Use only supplied evidence. Preserve chronology. Do not invent people, places, or tasks. Return strict JSON.";

function listedObservation(observation: AnalysisPromptObservation): AnalysisPromptObservation {
  return { id: observation.id, capturedAtUtc: observation.capturedAtUtc };
}

/** Build a deterministic prompt. Observations sort by id. Empty lists render as (empty). */
export function buildAnalysisPrompt(input: {
  observations: readonly AnalysisPromptObservation[];
}): string {
  const listed = [...input.observations].sort((a, b) => a.id - b.id).map(listedObservation);
  const body = listed.length === 0 ? "(empty)" : JSON.stringify(listed);
  return `${INSTRUCTIONS}\nObservations: ${body}`;
}
