
import type { TrainingExportRecord } from "@remnic/core";
import type { StyleMarkers } from "./style-extractor.js";

export interface SynthesizerOptions {
  styleMarkers?: StyleMarkers;
  maxPairsPerRecord?: number;
}

const DEFAULT_MAX_PAIRS = 1;

const QUESTION_TEMPLATES: Record<string, string[]> = {
  preferences: [
    "What kind of {topic} do you like?",
    "What's your preference for {topic}?",
    "What are your favorite {topic}?",
  ],
  opinions: [
    "What do you think about {topic}?",
    "How do you feel about {topic}?",
    "What's your opinion on {topic}?",
  ],
  expertise: [
    "Tell me about {topic}.",
    "What do you know about {topic}?",
    "Can you explain {topic}?",
  ],
  personal: [
    "Can you tell me about your {topic}?",
    "Tell me about your {topic}.",
    "What can you share about your {topic}?",
  ],
};

const DEFAULT_TEMPLATES = [
  "Tell me about {topic}.",
  "What can you share about {topic}?",
];

const CATEGORY_TO_TEMPLATE: Record<string, string> = {
  preference: "preferences",
  fact: "expertise",
  entity: "expertise",
  skill: "expertise",
  correction: "opinions",
  decision: "opinions",
  principle: "opinions",
  rule: "opinions",
  personal: "personal",
  relationship: "personal",
  commitment: "personal",
  moment: "personal",
};

export function synthesizeTrainingPairs(
  records: TrainingExportRecord[],
  options?: SynthesizerOptions,
): TrainingExportRecord[] {
  const maxPairs = resolveMaxPairsPerRecord(options?.maxPairsPerRecord);
  const style = options?.styleMarkers;
  const result: TrainingExportRecord[] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const templateKey = resolveTemplateKey(record.category);
    const topic = extractTopic(record.instruction);
    const templates = QUESTION_TEMPLATES[templateKey] ?? DEFAULT_TEMPLATES;

    const pairCount = Math.min(maxPairs, templates.length);

    for (let j = 0; j < pairCount; j++) {
      const templateIndex = (i + j) % templates.length;
      const question = templates[templateIndex].replace("{topic}", topic);
      let output = record.output;

      if (style?.usesLowercase) {
        output = output.toLowerCase();
      }

      result.push({
        instruction: question,
        input: "",
        output,
        category: record.category,
        confidence: record.confidence,
        sourceIds: record.sourceIds,
      });
    }
  }

  return result;
}


function resolveMaxPairsPerRecord(maxPairsPerRecord: number | undefined): number {
  const maxPairs = maxPairsPerRecord ?? DEFAULT_MAX_PAIRS;
  if (
    !Number.isFinite(maxPairs) ||
    !Number.isInteger(maxPairs) ||
    maxPairs <= 0
  ) {
    throw new RangeError("maxPairsPerRecord must be a finite positive integer");
  }
  return maxPairs;
}

function resolveTemplateKey(category: string | undefined): string {
  if (!category) return "";
  return CATEGORY_TO_TEMPLATE[category.toLowerCase()] ?? "";
}

function extractTopic(instruction: string): string {
  const tagMatch = instruction.match(/\(([^()]+)\)/);
  if (tagMatch) {
    return tagMatch[1].trim().toLowerCase();
  }
  return "this";
}
