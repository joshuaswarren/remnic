/**
 * Codex-subscription helpers for FallbackLlmClient (issue #2833).
 *
 * Terminal error classification and the `api: "codex-cli"` provider attempt
 * live here so fallback-llm.ts stays generic chain orchestration.
 */

import { raceAbort } from "./abort-error.js";
import { callCodexCliFallback, isCodexCliFallbackRunnerRegistered } from "./cli-fallback.js";
import type { CodexCliFallbackRunner } from "./cli-fallback.js";
import {
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  CodexSubscriptionAuthError,
  CodexSubscriptionConfigError,
  CodexSubscriptionTimeoutError,
  assertNoApiKeyConfig,
  ensureCodexSubscriptionRunnerRegistered,
} from "./providers/codex-subscription.js";
import type { ModelProviderConfig } from "./types.js";

type CodexSubscriptionAttemptResult = {
  content: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
};

/**
 * Terminal codex-subscription failures (timeout, auth, config contract).
 * These carry documented caller guidance (`TimeoutError` name, `codex login`
 * steps), so they must survive the chain instead of collapsing into a
 * generic empty/http_error result (issue #2833).
 */
export function isTerminalCodexSubscriptionError(error: unknown): boolean {
  return (
    error instanceof CodexSubscriptionTimeoutError ||
    error instanceof CodexSubscriptionAuthError ||
    error instanceof CodexSubscriptionConfigError
  );
}

/**
 * Single bounded headroom shared by both sides of the Codex deadline
 * (issue #2890): the provider gets it as SIGTERM lead time
 * (`timeoutMs - headroom`) and the outer race as settle grace, so the hard
 * outer bound stays `timeoutMs + headroom` (<= 25 ms past the deadline).
 */
export function codexDeadlineHeadroomMs(timeoutMs: number): number {
  return Math.min(25, Math.max(1, Math.floor(timeoutMs / 10)));
}

/**
 * Settle a fallback-LLM chain at the caller deadline. Abort the in-flight
 * work, then wait a bounded settle grace for the chain to surface a typed
 * provider timeout (default: one event-loop turn). A chain that settles
 * within the grace wins with its own result or error; one that never
 * settles still cannot exceed `timeoutMs + settleGraceMs`. The abandoned
 * promise is observed so a late rejection cannot become unhandled.
 */
export async function raceFallbackLlmDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  abortOnTimeout: () => void,
  settleGraceMs = 0,
): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  deadline.signal.addEventListener("abort", abortOnTimeout, { once: true });
  try {
    const value = await raceAbort(
      work,
      deadline.signal,
      `fallback LLM timed out after ${timeoutMs}ms`,
    );
    return { timedOut: false, value };
  } catch (error) {
    if (!deadline.signal.aborted) throw error;
    let graceTimer: NodeJS.Timeout | undefined;
    const afterAbort = await Promise.race([
      work.then(
        (value) => ({ state: "value" as const, value }),
        (lateError) => ({ state: "error" as const, error: lateError }),
      ),
      new Promise<{ state: "pending" }>((resolve) => {
        if (settleGraceMs > 0) {
          graceTimer = setTimeout(() => resolve({ state: "pending" }), settleGraceMs);
        } else {
          setImmediate(() => resolve({ state: "pending" }));
        }
      }),
    ]);
    clearTimeout(graceTimer);
    if (afterAbort.state === "value") return { timedOut: false, value: afterAbort.value };
    if (afterAbort.state === "error") throw afterAbort.error;
    void work.then(
      () => undefined,
      () => undefined,
    );
    return { timedOut: true };
  } finally {
    clearTimeout(timer);
    deadline.signal.removeEventListener("abort", abortOnTimeout);
  }
}

/**
 * Attempt the Codex CLI / subscription provider. Returns `undefined` when the
 * model is not `api: "codex-cli"` so the generic FallbackLlmClient path runs.
 *
 * Subscription ids reject a configured apiKey before generic secret resolution
 * — otherwise an unresolvable ref throws a generic error and the provider's
 * `codex login` guidance never surfaces (issue #2833). Other `codex-cli`
 * providers still resolve a configured key. Runtime auth is skipped: the CLI
 * login is the credential.
 */
export async function tryCodexSubscriptionProvider(
  model: {
    providerId: string;
    modelId: string;
    providerConfig: ModelProviderConfig;
  },
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options: { timeoutMs?: number; signal?: AbortSignal },
  resolveFallbackApiKey: () => Promise<string | undefined>,
  runner?: CodexCliFallbackRunner,
): Promise<CodexSubscriptionAttemptResult | undefined> {
  if (model.providerConfig.api !== "codex-cli") return undefined;

  if (model.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID) {
    assertNoApiKeyConfig(model.providerConfig);
  }

  const resolvedApiKey =
    model.providerConfig.apiKey === undefined ? undefined : await resolveFallbackApiKey();
  const rawKey = model.providerConfig.apiKey;
  const needsResolution =
    rawKey === "secretref-managed" || (typeof rawKey === "object" && rawKey !== null);
  if (needsResolution && !resolvedApiKey) {
    throw new Error(`API key for provider "${model.providerId}" could not be resolved from secret ref`);
  }

  const effectiveConfig: ModelProviderConfig = {
    ...model.providerConfig,
    ...(resolvedApiKey ? { apiKey: resolvedApiKey } : {}),
  };

  // Let the provider surface its typed timeout before the generic outer
  // deadline: the shared bounded headroom is SIGTERM lead time here and
  // settle grace in raceFallbackLlmDeadline (issue #2890).
  const callOptions = {
    timeoutMs: options.timeoutMs === undefined
      ? undefined
      : Math.max(1, options.timeoutMs - codexDeadlineHeadroomMs(options.timeoutMs)),
    signal: options.signal,
  };
  // A host/benchmark runner on the process seam still wins. Otherwise use
  // the owning runtime's runner so shutdown cannot kill another instance.
  if (isCodexCliFallbackRunnerRegistered()) {
    return await callCodexCliFallback(effectiveConfig, model.modelId, messages, callOptions);
  }
  if (runner) {
    return await callCodexCliFallback(effectiveConfig, model.modelId, messages, callOptions, runner);
  }
  ensureCodexSubscriptionRunnerRegistered();
  return await callCodexCliFallback(effectiveConfig, model.modelId, messages, callOptions);
}
