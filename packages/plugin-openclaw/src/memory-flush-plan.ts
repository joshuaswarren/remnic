/**
 * Flush-plan resolver for the OpenClaw memory-slot capability.
 *
 * The host asks the memory plugin how to spill a long transcript into durable
 * memory: thresholds, the model to plan with, and the flush-plan file that
 * Remnic later ingests. `writeRestrictPrefix` is an unknown-safe extra field
 * so a host can scope its write guard to Remnic plugin state instead of the
 * whole workspace (issue #2547). Hosts that ignore extra fields still key
 * the guard off `relativePath`.
 */

export type MemoryFlushPlan = {
  softThresholdTokens: number;
  forceFlushTranscriptBytes: number;
  reserveTokensFloor: number;
  model?: string;
  prompt: string;
  systemPrompt: string;
  relativePath: string;
  /**
   * Prefix a host may use to scope flush-turn writes to Remnic plugin state.
   * Optional in the type so older hosts can ignore it.
   */
  writeRestrictPrefix?: string;
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
  "Flush the recent OpenClaw transcript into Remnic memory by appending durable notes to the flush-plan file. Preserve durable user preferences, project facts, decisions, corrections, and commitments. Ignore runtime metadata, credentials, and transient command noise.";
const FLUSH_SYSTEM_PROMPT =
  "You are Remnic's memory flush planner. Read the transcript and append concise durable memory notes to the flush-plan file. Do not create dated memory paths or write credentials. Ignore runtime metadata, transient command noise, and content that is not worth remembering.";

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
    writeRestrictPrefix: ["state", "plugins", options.serviceId, ""].join("/"),
  };
}
