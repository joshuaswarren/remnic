import { estimateTokenCount } from "../token-estimate.js";

/** Characters of a batch that one LCM summarize call sends to the model. */
export const LCM_SUMMARIZE_INPUT_MAX_CHARS = 12_000;

export interface LcmSummarizeRequest {
  messages: Array<{ role: "system" | "user"; content: string }>;
  /** Summary length the prompt asks for, in tokens. */
  targetTokens: number;
  /** Completion budget: twice the prompt target. */
  maxTokens: number;
}

/**
 * Build one LCM summarize call, sized by the text the model actually receives.
 *
 * `LcmSummarizer` derives `targetTokens` from the whole batch, but only the
 * first {@link LCM_SUMMARIZE_INPUT_MAX_CHARS} characters are sent. With the
 * batch-sized target, a long batch asked the model for a summary longer than
 * the text it saw, and the `2 * target` completion budget grew with the batch
 * past common provider output caps. Those providers reject the request, and
 * the node silently degrades to deterministic truncation.
 *
 * The target is scaled by the share of the batch's estimated tokens that is
 * sent. A batch that fits is unchanged, and the aggressive retry keeps its
 * ratio to the normal attempt.
 */
export function buildLcmSummarizeRequest(
  text: string,
  targetTokens: number,
  aggressive: boolean,
): LcmSummarizeRequest {
  const input = text.slice(0, LCM_SUMMARIZE_INPUT_MAX_CHARS);
  const sentShare =
    input.length === text.length
      ? 1
      : estimateTokenCount(input) / Math.max(1, estimateTokenCount(text));
  const target = Math.max(1, Math.min(targetTokens, Math.ceil(targetTokens * sentShare)));
  const instructionText = aggressive
    ? `Compress the following into bullet points. One bullet per distinct fact or decision. Maximum ${target} tokens total. No prose.`
    : `Compress the following conversation segment into a dense summary. Preserve: decisions made, code artifacts mentioned, errors encountered, open questions, and any commitments or next-steps. Omit: pleasantries, restatements, and anything the agent would not need to recall later. Output a single paragraph, maximum ${target} tokens.`;
  return {
    messages: [
      { role: "system", content: instructionText },
      { role: "user", content: input },
    ],
    targetTokens: target,
    maxTokens: target * 2,
  };
}
