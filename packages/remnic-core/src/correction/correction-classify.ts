/**
 * Correction classify completion: a short per-attempt budget, caller abort,
 * and the same gateway/fallback client extraction uses when the local LLM
 * is down or `modelSource` is `gateway`.
 *
 * Each attempt (local, then gateway) gets `correctionClassifyTimeoutMs`.
 * A caller abort cancels the in-flight attempt and does not fall through.
 * A local timeout, null, or error falls through when `localLlmFallback` is
 * not false. Gateway mode skips the local client and uses the task chain
 * as the primary path.
 */
import { abortError, isAbortError, throwIfAborted } from "../abort-error.js";
import { resolveLocalLlmCapabilities } from "../capabilities.js";
import { fallbackLlmRuntimeContextFromConfig } from "../fallback-llm-codex-subscription.js";
import {
  FallbackLlmClient,
  type FallbackLlmOptions,
  type FallbackLlmResponse,
  gatewayTaskChainOptions,
} from "../fallback-llm.js";
import type { LocalLlmChatCompletionOptions } from "../local-llm-helpers.js";
import type { PluginConfig } from "../types.js";
import { DEFAULT_CORRECTION_CLASSIFY_TIMEOUT_MS, MAX_CORRECTION_CLASSIFY_TIMEOUT_MS } from "./correction-config.js";

export interface CorrectionClassifyMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CorrectionClassifyDeps {
  config: PluginConfig;
  localLlm: {
    chatCompletion(
      messages: Array<{ role: string; content: string }>,
      options?: LocalLlmChatCompletionOptions
    ): Promise<{ content: string } | null>;
  };
  /**
   * Test seam. Production builds a {@link FallbackLlmClient} from config.
   * Returning null is the no-models fast path.
   */
  fallbackChat?(
    messages: CorrectionClassifyMessage[],
    options: FallbackLlmOptions
  ): Promise<FallbackLlmResponse | null>;
}

export async function completeCorrectionClassify(
  messages: CorrectionClassifyMessage[],
  deps: CorrectionClassifyDeps,
  abortSignal?: AbortSignal
): Promise<string | null> {
  throwIfAborted(abortSignal, "correction classify aborted");
  const timeoutMs = classifyTimeoutMs(deps.config);
  const gatewayPrimary = deps.config.modelSource === "gateway";
  const localEnabled = resolveLocalLlmCapabilities(deps.config).localLlm === true && !gatewayPrimary;

  if (localEnabled) {
    const localAttempt = startAttempt(abortSignal, timeoutMs);
    try {
      const local = await deps.localLlm.chatCompletion(messages, {
        operation: "correction-classify",
        priority: "background",
        timeoutMs,
        temperature: 0.2,
        signal: localAttempt.signal,
      });
      if (abortSignal?.aborted) throw abortError("correction classify aborted");
      if (local?.content) return local.content;
      if (deps.config.localLlmFallback === false) {
        throw new Error("correction classify: local LLM unavailable and fallback disabled");
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        throw isAbortError(err) ? err : abortError("correction classify aborted");
      }
      // A timeout abort belongs to this attempt. Fall through unless the
      // operator turned the gateway path off.
      if (deps.config.localLlmFallback === false) {
        if (isAbortError(err)) {
          throw new Error("correction classify: local LLM timed out and fallback disabled");
        }
        throw err;
      }
    } finally {
      localAttempt.dispose();
    }
  } else if (!gatewayPrimary && deps.config.localLlmFallback === false) {
    throw new Error("correction classify: local LLM disabled and fallback disabled");
  }

  throwIfAborted(abortSignal, "correction classify aborted");
  const fallbackAttempt = startAttempt(abortSignal, timeoutMs);
  try {
    const fallbackOptions: FallbackLlmOptions = {
      temperature: 0.2,
      timeoutMs,
      signal: fallbackAttempt.signal,
      ...gatewayTaskChainOptions(deps.config),
    };
    const fallback = deps.fallbackChat
      ? await deps.fallbackChat(messages, fallbackOptions)
      : await new FallbackLlmClient(
          deps.config.gatewayConfig,
          fallbackLlmRuntimeContextFromConfig(deps.config)
        ).chatCompletion(messages, fallbackOptions);
    if (abortSignal?.aborted) throw abortError("correction classify aborted");
    return fallback?.content ?? null;
  } catch (err) {
    // The attempt signal aborts on its own budget. That is a finished miss
    // (empty plan), not a caller disconnect — only the caller signal skips
    // the empty-plan path.
    if (abortSignal?.aborted) {
      throw isAbortError(err) ? err : abortError("correction classify aborted");
    }
    if (isAbortError(err)) return null;
    throw err;
  } finally {
    fallbackAttempt.dispose();
  }
}

function classifyTimeoutMs(config: PluginConfig): number {
  const configured = config.correctionClassifyTimeoutMs;
  if (
    typeof configured === "number" &&
    Number.isInteger(configured) &&
    configured >= 1 &&
    configured <= MAX_CORRECTION_CLASSIFY_TIMEOUT_MS
  ) {
    return configured;
  }
  return DEFAULT_CORRECTION_CLASSIFY_TIMEOUT_MS;
}

function startAttempt(
  caller: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; dispose: () => void } {
  // A ref'd timer, not AbortSignal.timeout: that helper's timer is unref'd,
  // so a classify wait would not keep a short-lived caller alive until the
  // budget elapses.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onCaller = (): void => controller.abort();
  if (caller?.aborted) controller.abort();
  else caller?.addEventListener("abort", onCaller, { once: true });
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    caller?.removeEventListener("abort", onCaller);
  };
  controller.signal.addEventListener("abort", dispose, { once: true });
  return { signal: controller.signal, dispose };
}
