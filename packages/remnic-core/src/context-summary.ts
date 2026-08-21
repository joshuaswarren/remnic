/**
 * Pure context summary seam (issue #2347).
 *
 * The only shared summary path: `LcmSummarizer` and active-context
 * transforms both call `summarizeContextPure`. No DAG writes, no model
 * client construction — callers inject the model seam (`SummarizeFn`).
 */
import { looksLikeMechanicalTelemetryTranscript } from "./telemetry-transcript.js";
import { estimateTokenCount } from "./token-estimate.js";

/** Model seam injected by the caller (orchestrator LLM path or a test stub). */
export type SummarizeFn = (
  text: string,
  targetTokens: number,
  aggressive: boolean,
) => Promise<string | null>;

export type ContextSummaryMethod = "deterministic" | "llm" | "auto";

export interface PureContextSummaryResult {
  text: string;
  method: "llm" | "deterministic";
  /** True when the requested path degraded (auto mode only). */
  fallback: boolean;
  modelUsed?: string;
  /**
   * Escalation level preserved for LCM callers: 0 normal LLM, 1 aggressive
   * LLM, 2 deterministic truncation. Undefined when never escalated.
   */
  escalation?: number;
}

export interface SummarizeContextPureOptions {
  /** LLM seam. Required for `llm`; without it `auto` degrades to deterministic. */
  llm?: SummarizeFn;
  /** Hard ceiling for deterministic truncation output. */
  deterministicMaxTokens?: number;
  /** Route obvious mechanical telemetry straight to truncation. */
  telemetryPrefilterEnabled?: boolean;
  /** Recorded verbatim in the result for telemetry. */
  modelUsed?: string;
}

/** Thrown when `llm` mode cannot produce usable text (no silent fallback). */
export class ContextSummaryUnavailableError extends Error {
  constructor(reason: string) {
    super(`context summary unavailable: ${reason}`);
    this.name = "ContextSummaryUnavailableError";
  }
}

const DEFAULT_DETERMINISTIC_MAX_TOKENS = 256;
/** LLM output tolerance before an attempt is rejected as too long (LCM parity). */
const OUTPUT_TOKEN_TOLERANCE = 1.5;
const MIN_DETERMINISTIC_TOKENS = 1;

/**
 * Summarize text through the shared seam.
 *
 * - `deterministic`: safe truncation only, never throws, never calls the LLM.
 * - `llm`: exactly one non-aggressive LLM call; failure or unusable output
 *   throws {@link ContextSummaryUnavailableError} (fallback is not allowed).
 * - `auto`: escalation ladder (LLM → aggressive LLM → deterministic), with
 *   `fallback: true` and an `escalation` level on degradation.
 */
export async function summarizeContextPure(
  text: string,
  targetTokens: number,
  method: ContextSummaryMethod,
  options: SummarizeContextPureOptions = {},
): Promise<PureContextSummaryResult> {
  const deterministicMaxTokens = Math.max(
    MIN_DETERMINISTIC_TOKENS,
    options.deterministicMaxTokens ?? DEFAULT_DETERMINISTIC_MAX_TOKENS,
  );

  if (method === "deterministic") {
    return {
      text: deterministicTruncate(text, Math.min(targetTokens, deterministicMaxTokens)),
      method: "deterministic",
      fallback: false,
    };
  }

  const usableLlm = options.llm ?? null;
  if (method === "llm") {
    if (!usableLlm) {
      throw new ContextSummaryUnavailableError("no llm seam configured");
    }
    const result = await attemptLlm(usableLlm, text, targetTokens, false);
    if (result === null) {
      throw new ContextSummaryUnavailableError("llm path failed");
    }
    return { text: result, method: "llm", fallback: false, modelUsed: options.modelUsed };
  }

  // auto
  if (options.telemetryPrefilterEnabled && looksLikeMechanicalTelemetryTranscript(text)) {
    return {
      text: deterministicTruncate(text, Math.min(targetTokens, deterministicMaxTokens)),
      method: "deterministic",
      fallback: true,
      escalation: 2,
    };
  }

  if (usableLlm) {
    const normal = await attemptLlm(usableLlm, text, targetTokens, false);
    if (normal !== null) {
      return { text: normal, method: "llm", fallback: false, escalation: 0, modelUsed: options.modelUsed };
    }
    const aggressiveTarget = Math.max(32, Math.ceil(targetTokens * 0.5));
    const aggressive = await attemptLlm(usableLlm, text, aggressiveTarget, true);
    if (aggressive !== null) {
      return { text: aggressive, method: "llm", fallback: true, escalation: 1, modelUsed: options.modelUsed };
    }
  }

  return {
    text: deterministicTruncate(text, deterministicMaxTokens),
    method: "deterministic",
    fallback: true,
    escalation: 2,
  };
}

/** One LLM attempt; null on error, empty, or over-tolerance output. */
async function attemptLlm(
  llm: SummarizeFn,
  text: string,
  targetTokens: number,
  aggressive: boolean,
): Promise<string | null> {
  try {
    const result = await llm(text, targetTokens, aggressive);
    if (!result || result.trim().length === 0) return null;
    if (estimateTokenCount(result) > targetTokens * OUTPUT_TOKEN_TOLERANCE) return null;
    return result;
  } catch {
    return null;
  }
}

/** Deterministic truncation: first and last sentence, plus middle truncation. */
export function deterministicTruncate(text: string, maxTokens: number): string {
  if (maxTokens <= 0 || estimateTokenCount(text) <= maxTokens) return text;

  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0);
  if (sentences.length <= 2) return clampToTokenBudget(text, maxTokens);

  const first = sentences[0];
  const last = sentences[sentences.length - 1];
  const render = (middle: string[], truncated: boolean): string =>
    `${first} ${middle.join(" ")}${truncated ? " [...] " : " "}${last}`;

  const base = render([], false);
  if (estimateTokenCount(base) > maxTokens) return clampToTokenBudget(text, maxTokens);
  if (estimateTokenCount(render([], true)) > maxTokens) return base;

  const middle: string[] = [];
  for (let i = 1; i < sentences.length - 1; i++) {
    const candidate = [...middle, sentences[i]];
    const truncated = i < sentences.length - 2;
    if (estimateTokenCount(render(candidate, truncated)) > maxTokens) break;
    middle.push(sentences[i]);
  }

  const truncated = middle.length < sentences.length - 2;
  return clampToTokenBudget(render(middle, truncated), maxTokens);
}

function clampToTokenBudget(text: string, maxTokens: number): string {
  const codePoints = [...text];
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokenCount(codePoints.slice(0, mid).join("")) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return codePoints.slice(0, low).join("");
}
