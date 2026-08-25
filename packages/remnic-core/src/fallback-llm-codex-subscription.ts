/**
 * Helpers extracted from FallbackLlmClient so fallback-llm.ts stays under
 * the 1200-line cap: Codex-subscription lifecycle (issue #2833) plus
 * generic chain helpers used by the same client.
 */

import path from "node:path";
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
  getCodexSubscriptionRunnerForOwner,
  getCodexSubscriptionShutdownSignal,
  isDefaultRegisteredCodexSubscriptionRunner,
} from "./providers/codex-subscription.js";
import type { GetRuntimeAuthForModelFn, ResolveApiKeyFn } from "./resolve-provider-secret.js";
import { resolveHomeDir } from "./runtime/env.js";
import type { GatewayConfig, ModelProviderConfig } from "./types.js";
import { expandTildePath } from "./utils/path.js";

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
 * Settle a fallback-LLM chain at the caller deadline. Abort the in-flight
 * work, return immediately, and observe the abandoned promise so a late
 * rejection cannot become unhandled.
 */
export async function raceFallbackLlmDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  abortOnTimeout: () => void,
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
    const afterAbort = await Promise.race([
      work.then(
        (value) => ({ state: "value" as const, value }),
        (lateError) => ({ state: "error" as const, error: lateError }),
      ),
      new Promise<{ state: "pending" }>((resolve) => {
        setImmediate(() => resolve({ state: "pending" }));
      }),
    ]);
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

  // Let the provider surface its typed timeout before the generic outer deadline.
  const callOptions = {
    timeoutMs: options.timeoutMs === undefined
      ? undefined
      : Math.max(1, options.timeoutMs - Math.min(100, Math.max(5, Math.floor(options.timeoutMs / 5)))),
    signal: options.signal,
  };
  // A host/benchmark runner on the process seam still wins. The core
  // default runner does not: prefer the owning runtime so shutdown
  // terminates the request that runtime started.
  if (isCodexCliFallbackRunnerRegistered() && !(runner && isDefaultRegisteredCodexSubscriptionRunner())) {
    return await callCodexCliFallback(effectiveConfig, model.modelId, messages, callOptions);
  }
  if (runner) {
    return await callCodexCliFallback(effectiveConfig, model.modelId, messages, callOptions, runner);
  }
  ensureCodexSubscriptionRunnerRegistered();
  return await callCodexCliFallback(effectiveConfig, model.modelId, messages, callOptions);
}

export function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error("fallback LLM request aborted");
}

export function withCodexRuntimeShutdown<T extends { signal?: AbortSignal }>(
  options: T,
  runner: CodexCliFallbackRunner | undefined,
): T {
  if (!runner) return options;
  const shutdown = getCodexSubscriptionShutdownSignal(runner);
  if (!shutdown) return options;
  return {
    ...options,
    signal: options.signal ? AbortSignal.any([options.signal, shutdown]) : shutdown,
  };
}

export function isUnsupportedJsonSchemaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Require an HTTP status plus explicit schema/format context. A bare
  // "unsupported" (e.g. "'temperature' is unsupported with this model") must
  // NOT trigger the schema-stripping retry, or we pay a duplicate request
  // for unrelated provider errors.
  if (!/\b(?:400|404|422)\b/.test(message)) {
    return false;
  }
  if (/(?:response[_ ]?format|json[_ ]?schema|structured[_ ]?output)/i.test(message)) {
    return true;
  }
  // "unsupported" only counts when adjacent to schema/format terminology.
  return /\bunsupported\b[\s\S]{0,40}\b(?:schema|format)\b/i.test(message);
}

export function extractResponsesOutputText(data: {
  output_text?: string;
  output?: Array<{
    type?: string;
    text?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
}): string | null {
  if (typeof data.output_text === "string" && data.output_text.trim().length > 0) {
    return data.output_text;
  }

  const chunks: string[] = [];
  for (const item of data.output ?? []) {
    if (typeof item.text === "string" && item.text.trim().length > 0) {
      chunks.push(item.text);
    }
    for (const part of item.content ?? []) {
      if (
        (part.type === "output_text" || part.type === "text") &&
        typeof part.text === "string" &&
        part.text.trim().length > 0
      ) {
        chunks.push(part.text);
      }
    }
  }

  const joined = chunks.join("\n").trim();
  return joined.length > 0 ? joined : null;
}

export type StructuredParseFailureReason =
  | "no_models"
  | "empty"
  | "http_error"
  | "schema_rejection"
  | "timeout";

export interface StructuredParseFailure {
  result: null;
  failureReason: StructuredParseFailureReason;
  /** Model string of the last attempt, when one was selected. Not `modelUsed`. */
  attemptedModel?: string;
  /** HTTP status when known. Never a response body. */
  httpStatus?: number;
  /** Coarse class: http_4xx / http_5xx / timeout / network / empty / schema_rejection / no_models. */
  errorClass?: string;
}

export type StructuredParseResult<T> =
  | { result: T; modelUsed: string }
  | StructuredParseFailure;

export interface FallbackLlmRuntimeContext {
  agentDir?: string;
  getRuntimeAuthForModel?: GetRuntimeAuthForModelFn | null;
  resolveApiKeyForProvider?: ResolveApiKeyFn | null;
  workspaceDir?: string;
  /** Per-runtime Codex child owner. Shutdown must terminate only this runner. */
  codexSubscriptionRunner?: CodexCliFallbackRunner;
}

type GatewayBackedRuntimeConfig = {
  providerApiKeyResolver?: ResolveApiKeyFn | null;
  runtimeAuthForModelResolver?: GetRuntimeAuthForModelFn | null;
  workspaceDir?: string;
};

export function fallbackLlmRuntimeContextFromConfig(
  config: Pick<
    GatewayBackedRuntimeConfig,
    "providerApiKeyResolver" | "runtimeAuthForModelResolver" | "workspaceDir"
  >,
  overrides: FallbackLlmRuntimeContext = {},
): FallbackLlmRuntimeContext {
  return {
    workspaceDir: config.workspaceDir,
    resolveApiKeyForProvider: config.providerApiKeyResolver,
    getRuntimeAuthForModel: config.runtimeAuthForModelResolver,
    codexSubscriptionRunner: getCodexSubscriptionRunnerForOwner(config),
    ...overrides,
  };
}

const HTTP_STATUS_IN_MESSAGE = /\b([1-5]\d{2})\b/;

export function isTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timed out after \d+ms/i.test(msg) || /timed out before request started/i.test(msg);
}

function isEmptyProviderResponse(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /^Empty response from /i.test(msg);
}

function finiteHttpStatus(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) return undefined;
  if (value < 100 || value > 599) return undefined;
  return value;
}

function httpStatusFromProviderError(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    if ("status" in err) {
      const status = finiteHttpStatus(err.status);
      if (status !== undefined) return status;
    }
    if ("statusCode" in err) {
      const status = finiteHttpStatus(err.statusCode);
      if (status !== undefined) return status;
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  const match = HTTP_STATUS_IN_MESSAGE.exec(msg);
  if (!match) return undefined;
  return finiteHttpStatus(Number(match[1]));
}

function errorClassForHttpStatus(status: number): string {
  if (status >= 500) return "http_5xx";
  if (status >= 400) return "http_4xx";
  return `http_${status}`;
}

export function classifyThrownProviderError(err: unknown): Omit<StructuredParseFailure, "result"> {
  if (isTimeoutError(err)) {
    return { failureReason: "timeout", errorClass: "timeout" };
  }
  if (isEmptyProviderResponse(err)) {
    return { failureReason: "empty", errorClass: "empty" };
  }
  const httpStatus = httpStatusFromProviderError(err);
  if (httpStatus !== undefined) {
    return {
      failureReason: "http_error",
      httpStatus,
      errorClass: errorClassForHttpStatus(httpStatus),
    };
  }
  return { failureReason: "http_error", errorClass: "network" };
}

export function normalizeRuntimePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? expandTildePath(trimmed) : undefined;
}

export function readGatewayWorkspaceDir(gatewayConfig: GatewayConfig | undefined): string | undefined {
  if (!gatewayConfig || typeof gatewayConfig !== "object") return undefined;
  const raw = gatewayConfig as Record<string, unknown>;
  return (
    normalizeRuntimePath(raw.workspaceDir) ??
    normalizeRuntimePath(raw.workspacePath) ??
    normalizeRuntimePath(raw.workspace)
  );
}

export function defaultOpenClawWorkspaceDir(): string {
  return path.join(resolveHomeDir(), ".openclaw", "workspace");
}
