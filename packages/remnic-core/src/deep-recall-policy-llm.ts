/**
 * Policy-call LLM routing for deep recall (issue #2332).
 *
 * Mirrors `extraction-judge.ts` `callJudgeLlm` exactly: local client first
 * (json_object response format) unless modelSource is "gateway", then the
 * fallback client with the shared background-task chain options. Never a
 * raw OpenAI client. Returns null when both legs fail — the loop treats
 * that as a stop, never a crash.
 */

import { gatewayTaskChainOptions, type FallbackLlmClient } from "./fallback-llm.js";
import type { LocalLlmClient } from "./local-llm.js";
import type { PluginConfig } from "./types.js";

export const DEEP_RECALL_POLICY_SYSTEM_PROMPT =
  "You are the retrieval policy for a long-term memory system. Given the question, the current working set of retrieved memories, and the frontier of anchor-linked candidates, choose exactly one action: REFINE (rewrite the query), EXPAND (follow named frontier nodes), or STOP. Respond with JSON only.";

export async function callDeepRecallPolicyLlm(input: {
  statePrompt: string;
  config: PluginConfig;
  localLlm: LocalLlmClient | null;
  fallbackLlm: FallbackLlmClient | null;
  timeoutMs: number;
}): Promise<string | null> {
  const messages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: DEEP_RECALL_POLICY_SYSTEM_PROMPT },
    { role: "user", content: input.statePrompt },
  ];
  const timeout = input.timeoutMs > 0 ? input.timeoutMs : undefined;
  const skipLocal = input.config.modelSource === "gateway";
  const gatewayChain = gatewayTaskChainOptions(input.config);

  if (input.localLlm && !skipLocal) {
    try {
      const result = await input.localLlm.chatCompletion(messages, {
        temperature: 0.1,
        maxTokens: 1024,
        ...(timeout ? { timeoutMs: timeout } : {}),
        responseFormat: { type: "json_object" },
        operation: "deep-recall-policy",
      });
      if (result?.content) return result.content;
    } catch {
      // fall through to the gateway leg
    }
  }

  if (input.fallbackLlm) {
    try {
      const result = await input.fallbackLlm.chatCompletion(
        messages as Array<{ role: "system" | "user" | "assistant"; content: string }>,
        {
          temperature: 0.1,
          maxTokens: 1024,
          ...(timeout ? { timeoutMs: timeout } : {}),
          ...gatewayChain,
        },
      );
      if (result?.content) return result.content;
    } catch {
      // both legs failed — caller treats null as a stop
    }
  }
  return null;
}
