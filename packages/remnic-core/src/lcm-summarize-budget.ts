import { estimateTokenCount } from "./token-estimate.js";

/** User payload char cap in orchestrator LCM summarize closure (issue #3407). */
export const LCM_SUMMARIZE_PROMPT_MAX_CHARS = 12_000;

const MIN_LCM_SUMMARIZE_TARGET_TOKENS = 64;

export interface LcmSummarizeBudget {
  promptText: string;
  effectiveTargetTokens: number;
  maxCompletionTokens: number;
}

/**
 * Scale summarize budgets to the text actually sent to the model when the
 * full batch exceeds {@link LCM_SUMMARIZE_PROMPT_MAX_CHARS}.
 */
export function scaleLcmSummarizeBudget(
  fullText: string,
  targetTokens: number,
): LcmSummarizeBudget {
  const promptText = fullText.slice(0, LCM_SUMMARIZE_PROMPT_MAX_CHARS);
  const fullEst = Math.max(1, estimateTokenCount(fullText));
  const sentEst = Math.max(1, estimateTokenCount(promptText));
  const ratio = Math.min(1, sentEst / fullEst);
  const effectiveTargetTokens = Math.max(
    MIN_LCM_SUMMARIZE_TARGET_TOKENS,
    Math.ceil(targetTokens * ratio),
  );
  return {
    promptText,
    effectiveTargetTokens,
    maxCompletionTokens: effectiveTargetTokens * 2,
  };
}
