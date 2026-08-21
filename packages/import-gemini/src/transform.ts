// ---------------------------------------------------------------------------
// Gemini parsed → ImportedMemory transform (issue #568 slice 4)
// ---------------------------------------------------------------------------
//
// Google Takeout only exports the user's prompts — assistant responses are
// omitted by Google. We therefore import every Gemini Apps activity record
// as one memory containing the prompt text. Each prompt is first-person
// intent (what the user asked), which the downstream extraction pipeline
// can score / cluster just like any other memory source.
//
// Unlike the ChatGPT and Claude importers, there is no "conversation" layer
// to opt into — Takeout doesn't preserve conversation boundaries for
// Gemini Apps. The `includeConversations` flag is ignored.

import type { ImportedMemory } from "@remnic/core";

import type { GeminiActivityRecord, ParsedGeminiExport } from "./parser.js";
import { extractUserPrompt } from "./parser.js";

export const GEMINI_SOURCE_LABEL = "gemini";

export interface GeminiTransformOptions {
  /** Optional cap on total memories emitted — primarily for tests. */
  maxMemories?: number;
  /**
   * Minimum prompt length (in characters) to import. Very short prompts
   * ("yes", "ok", "tell me more") provide little durable signal. Default 10.
   */
  minPromptLength?: number;
}

const DEFAULT_MIN_PROMPT_LENGTH = 10;

/**
 * Transform a parsed Gemini export into `ImportedMemory[]`. One memory per
 * Gemini activity record containing a non-trivial user prompt.
 */
export function transformGeminiExport(
  parsed: ParsedGeminiExport,
  options: GeminiTransformOptions = {},
): ImportedMemory[] {
  const out: ImportedMemory[] = [];
  const cap = options.maxMemories;
  const minLen = options.minPromptLength ?? DEFAULT_MIN_PROMPT_LENGTH;

  for (const record of parsed.activities) {
    if (cap !== undefined && out.length >= cap) return out;
    const memory = activityToImported(record, parsed.filePath, minLen);
    if (memory) out.push(memory);
  }
  return out;
}

function activityToImported(
  record: GeminiActivityRecord,
  filePath: string | undefined,
  minLen: number,
): ImportedMemory | undefined {
  const prompt = extractUserPrompt(record);
  if (!prompt || prompt.length < minLen) return undefined;

  const metadata: Record<string, unknown> = { kind: "prompt" };
  if (typeof record.titleUrl === "string" && record.titleUrl.length > 0) {
    metadata.activityUrl = record.titleUrl;
  }
  if (Array.isArray(record.subtitles) && record.subtitles.length > 0) {
    const modelSubtitle = record.subtitles.find(
      (s) => typeof s.name === "string" && /model/i.test(s.name),
    );
    if (modelSubtitle?.name) metadata.modelTag = modelSubtitle.name;
  }

  return {
    content: prompt,
    sourceLabel: GEMINI_SOURCE_LABEL,
    ...(record.time !== undefined ? { sourceTimestamp: record.time } : {}),
    ...(filePath !== undefined ? { importedFromPath: filePath } : {}),
    metadata,
  };
}
