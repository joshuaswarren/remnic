/**
 * Flush-plan resolver for the OpenClaw memory-slot capability.
 *
 * The host asks the memory plugin how to spill a long transcript into durable
 * memory: thresholds, the model to plan with, and the single file the write
 * tool is allowed to append to. The answer is pure configuration, so both
 * bridge modes resolve it identically — a delegate-side copy would drift the
 * prompts and the allowed path apart from the embedded ones.
 */

export type MemoryFlushPlan = {
  softThresholdTokens: number;
  forceFlushTranscriptBytes: number;
  reserveTokensFloor: number;
  model?: string;
  prompt: string;
  systemPrompt: string;
  relativePath: string;
};

export type MemoryFlushPlanOptions = {
  /** Plugin service id — scopes the allowed flush-plan file. */
  serviceId: string;
  /** `extractionMaxTurnChars`; non-finite values fall back to the default. */
  extractionMaxTurnChars?: unknown;
  /**
   * Model to plan the flush with. Callers pass `summaryModel` or the task
   * chain's primary — NEVER `cfg.model`, which is direct-compatible and may be
   * a bare id the Gateway cannot route (issue #1469). Empty is omitted so the
   * Gateway default wins.
   */
  flushModel?: string;
};

const DEFAULT_MAX_TURN_CHARS = 8_000;
const MIN_MAX_TURN_CHARS = 1_000;

const FLUSH_PROMPT =
  "Flush the recent OpenClaw transcript into Remnic memory by appending to the allowed flush-plan file only. Preserve durable user preferences, project facts, decisions, corrections, and commitments. Ignore runtime metadata, credentials, and transient command noise.";
const FLUSH_SYSTEM_PROMPT =
  "You are Remnic's memory flush planner. Read the transcript and append concise durable memory notes to the file the write tool allows. Do not create files, directories, or dated paths; use only the allowed flush-plan file. Ignore runtime metadata, credentials, transient command noise, and content that is not worth remembering.";

export function buildMemoryFlushPlan(options: MemoryFlushPlanOptions): MemoryFlushPlan {
  const maxTurnChars =
    typeof options.extractionMaxTurnChars === "number" &&
    Number.isFinite(options.extractionMaxTurnChars)
      ? Math.max(MIN_MAX_TURN_CHARS, Math.floor(options.extractionMaxTurnChars))
      : DEFAULT_MAX_TURN_CHARS;
  const flushModel =
    typeof options.flushModel === "string" && options.flushModel.length > 0
      ? options.flushModel
      : undefined;
  return {
    softThresholdTokens: 24_000,
    forceFlushTranscriptBytes: Math.max(16_384, maxTurnChars * 4),
    reserveTokensFloor: 2_000,
    ...(flushModel ? { model: flushModel } : {}),
    prompt: FLUSH_PROMPT,
    systemPrompt: FLUSH_SYSTEM_PROMPT,
    relativePath: ["state", "plugins", options.serviceId, "flush-plan.md"].join("/"),
  };
}
