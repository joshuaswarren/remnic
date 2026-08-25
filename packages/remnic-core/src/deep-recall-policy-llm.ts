/**
 * Policy-call LLM routing for deep recall (issue #2332).
 *
 * Mirrors `extraction-judge.ts` `callJudgeLlm` exactly: local client first
 * (json_object response format) unless modelSource is "gateway", then the
 * fallback client with the shared background-task chain options. Never a
 * raw OpenAI client. Returns null when both legs fail — the loop treats
 * that as a stop, never a crash.
 *
 * One `timeoutMs` budget spans BOTH legs (issue #2915): the fallback leg
 * receives only what the local leg left on the clock, so a single policy
 * step can no longer outlive `stepTimeoutMs` by failing slowly locally and
 * restarting the full timeout remotely. A spent budget starts neither leg.
 * The transport cancellation signal is forwarded to both legs and checked
 * before each start and after each caught failure so an abort is never
 * converted to null.
 */

import { gatewayTaskChainOptions, type FallbackLlmClient } from "./fallback-llm.js";
import type { LocalLlmClient } from "./local-llm.js";
import type { PluginConfig } from "./types.js";
import { isAbortError, throwIfAborted } from "./abort-error.js";

export const DEEP_RECALL_POLICY_SYSTEM_PROMPT =
  "You are the retrieval policy for a long-term memory system. Given the question, the current working set of retrieved memories, and the frontier of anchor-linked candidates, choose exactly one action: REFINE (rewrite the query), EXPAND (follow named frontier nodes), or STOP. Respond with JSON only.";

export async function callDeepRecallPolicyLlm(input: {
  statePrompt: string;
  config: PluginConfig;
  localLlm: LocalLlmClient | null;
  fallbackLlm: FallbackLlmClient | null;
  timeoutMs: number;
  /** Transport cancellation (issue #2915); forwarded to both LLM legs. */
  signal?: AbortSignal;
}): Promise<string | null> {
  const messages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: DEEP_RECALL_POLICY_SYSTEM_PROMPT },
    { role: "user", content: input.statePrompt },
  ];
  const startedAtMs = Date.now();
  const remainingMs = (): number | undefined =>
    input.timeoutMs > 0 ? input.timeoutMs - (Date.now() - startedAtMs) : undefined;
  const skipLocal = input.config.modelSource === "gateway";
  const gatewayChain = gatewayTaskChainOptions(input.config);
  const abortMessage = "deep recall policy call aborted";

  throwIfAborted(input.signal, abortMessage);

  if (input.localLlm && !skipLocal) {
    const timeout = remainingMs();
    if (timeout !== undefined && timeout <= 0) {
      return null;
    }
    try {
      const result = await input.localLlm.chatCompletion(messages, {
        temperature: 0.1,
        maxTokens: 1024,
        ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
        responseFormat: { type: "json_object" },
        operation: "deep-recall-policy",
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (result?.content) return result.content;
    } catch (err) {
      if (isAbortError(err)) throw err;
      throwIfAborted(input.signal, abortMessage);
    }
  }

  throwIfAborted(input.signal, abortMessage);
  const remaining = remainingMs();
  if (remaining !== undefined && remaining <= 0) {
    return null;
  }
  if (input.fallbackLlm) {
    try {
      const result = await input.fallbackLlm.chatCompletion(
        messages as Array<{ role: "system" | "user" | "assistant"; content: string }>,
        {
          temperature: 0.1,
          maxTokens: 1024,
          ...(remaining !== undefined ? { timeoutMs: remaining } : {}),
          ...gatewayChain,
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
      if (result?.content) return result.content;
    } catch (err) {
      if (isAbortError(err)) throw err;
      throwIfAborted(input.signal, abortMessage);
    }
  }
  throwIfAborted(input.signal, abortMessage);
  return null;
}
