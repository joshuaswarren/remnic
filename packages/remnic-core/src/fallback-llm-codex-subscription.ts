/**
 * Codex-subscription helpers for FallbackLlmClient (issue #2833).
 *
 * Terminal error classification and the `api: "codex-cli"` provider attempt
 * live here so fallback-llm.ts stays generic chain orchestration.
 */

import { callCodexCliFallback } from "./cli-fallback.js";
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

  // Registers the core subprocess transport only when no host/benchmark
  // runner claimed the seam, so daemon/plugin runtimes work out of the box.
  ensureCodexSubscriptionRunnerRegistered();
  return await callCodexCliFallback(effectiveConfig, model.modelId, messages, {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}
