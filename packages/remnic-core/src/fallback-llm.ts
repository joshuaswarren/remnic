import { log } from "./logger.js";
import path from "node:path";
import type { AgentPersonaModelConfig, GatewayConfig, ModelProviderConfig, PluginConfig } from "./types.js";
import { extractJsonCandidates } from "./json-extract.js";
import {
  buildChatCompletionTemperature,
  buildChatCompletionTokenLimit,
  shouldAssumeOpenAiChatCompletions,
} from "./openai-chat-compat.js";
import {
  resolveProviderApiKey,
  getGatewayRuntimeAuthForModel,
  type GetRuntimeAuthForModelFn,
  type ResolveApiKeyFn,
} from "./resolve-provider-secret.js";
import {
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  codexSubscriptionBuiltinProviderConfig,
  getCodexSubscriptionRunnerForOwner,
} from "./providers/codex-subscription.js";
import { loadModelsJsonProviders } from "./models-json.js";
import {
  abortReason,
  extractResponsesOutputText,
  isTerminalCodexSubscriptionError,
  isUnsupportedJsonSchemaError,
  raceFallbackLlmDeadline,
  tryCodexSubscriptionProvider,
  withCodexRuntimeShutdown,
} from "./fallback-llm-codex-subscription.js";
import type { CodexCliFallbackRunner } from "./cli-fallback.js";
import { resolveHomeDir } from "./runtime/env.js";
import { expandTildePath } from "./utils/path.js";

export interface FallbackLlmOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Set the Responses API storage policy. Other transports ignore this value. */
  store?: boolean;
  /** Request strict JSON output when a route uses the Responses API. */
  responsesJsonSchema?: { name: string; schema: Record<string, unknown> };
  /** Request provider-native structured output on supported JSON transports. */
  jsonSchema?: { name: string; schema: Record<string, unknown>; strict?: boolean };
  /** Hide provider error details that could echo private request content. */
  redactProviderErrors?: boolean;
  /** Explicit "provider/model" override to try before the configured chain. */
  model?: string;
  /** Explicit model chain override to use instead of the configured agent/default chain. */
  modelChain?: AgentPersonaModelConfig;
  /** Append the gateway default chain after an explicit model chain. */
  includeDefaultModelFallback?: boolean;
  /** Override which agent persona's model chain to use (by ID from agents.list[]). */
  agentId?: string;
  /** Reject a transport-successful response and continue through the configured model chain. */
  acceptResponse?: (response: FallbackLlmResponse) => boolean;
  /**
   * Optional out-box for the terminal failure cause (issue #2891): when every
   * model in the chain fails, the last thrown provider error is recorded here
   * so callers can classify it (e.g. HTTP 429 → rate-limited) in memory
   * instead of seeing only null. Never logged.
   */
  failureDiag?: { lastError?: unknown };
}

export interface FallbackLlmAvailabilityOptions {
  agentId?: string;
  modelChain?: AgentPersonaModelConfig;
}

/**
 * Resolve the gateway routing options Remnic's background tasks should pass to
 * FallbackLlmClient — extraction, fact/profile/identity consolidation,
 * summarization, calibration, and causal/semantic consolidation. Single source
 * of truth so every task path stays consistent and can't diverge (gotcha #22):
 * in gateway mode an explicit `taskModelChain` wins over the gateway agent
 * persona; otherwise the persona (if any) is used. Returns `{}` in plugin mode
 * because the chain resolves through gateway providers only. Issue #1365.
 */
export function gatewayTaskChainOptions(
  config: Pick<PluginConfig, "modelSource" | "taskModelChain" | "gatewayAgentId">,
): Pick<FallbackLlmOptions, "modelChain" | "agentId"> {
  if (config.modelSource !== "gateway") return {};
  if (config.taskModelChain) return { modelChain: config.taskModelChain };
  return config.gatewayAgentId ? { agentId: config.gatewayAgentId } : {};
}

export interface FallbackLlmResponse {
  content: string;
  modelUsed: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export interface FallbackLlmRuntimeContext {
  agentDir?: string;
  getRuntimeAuthForModel?: GetRuntimeAuthForModelFn | null;
  resolveApiKeyForProvider?: ResolveApiKeyFn | null;
  workspaceDir?: string;
  /** Per-runtime Codex child owner. Shutdown must terminate only this runner. */
  codexSubscriptionRunner?: CodexCliFallbackRunner;
}

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

type GatewayBackedRuntimeConfig = {
  providerApiKeyResolver?: ResolveApiKeyFn | null;
  runtimeAuthForModelResolver?: GetRuntimeAuthForModelFn | null;
  workspaceDir?: string;
};

interface ModelRef {
  providerId: string;
  modelId: string;
  providerConfig: ModelProviderConfig;
  modelString: string;
}

const PROVIDER_ALIASES: Record<string, readonly string[]> = {
  "openai-codex": ["codex"],
  codex: ["openai-codex"],
  "claude-cli": ["anthropic"],
};

const LEGACY_PROVIDER_IDS = new Set(["openai-codex", "claude-cli"]);

const MANAGED_SECRETREF_MARKER = ["secretref", "managed"].join("-");
const PROVIDER_API_KEY_FIELD = ["api", "Key"].join("") as keyof ModelProviderConfig;

/**
 * Built-in provider fallbacks for providers that are commonly configured via
 * OAuth or gateway-managed auth rather than an explicit apiKey in
 * openclaw.json. These entries let resolveProviderConfig() succeed so the
 * chain proceeds to tryModel() → resolveRuntimeAuth(), which is where the
 * gateway's native OAuth token exchange happens.
 *
 * Without these, OAuth-only providers like `openai` are rejected with
 * "provider not found" before runtime auth is ever attempted.
 */
const BUILT_IN_PROVIDER_FALLBACKS: Record<string, ModelProviderConfig> = {
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    api: "anthropic-messages",
    models: [],
    [PROVIDER_API_KEY_FIELD]: MANAGED_SECRETREF_MARKER,
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    api: "openai-responses",
    models: [],
    [PROVIDER_API_KEY_FIELD]: MANAGED_SECRETREF_MARKER,
  },
  // Subscription-OAuth extraction provider (issue #2784): no apiKey — the
  // codex CLI login authenticates, via the runner the codex-subscription
  // module registers on this same seam.
  [CODEX_SUBSCRIPTION_PROVIDER_ID]: codexSubscriptionBuiltinProviderConfig(),
};

/**
 * Gateway/task LLM client. In `modelSource: "gateway"` this is the primary
 * configured path (taskModelChain / agent persona), not a secondary recovery
 * client. The class name stays `FallbackLlmClient` because it is imported
 * widely; prefer the `TaskLlmClient` alias in new code. Issue #2967.
 */
export class FallbackLlmClient {
  private gatewayConfig: GatewayConfig | undefined;
  private runtimeContext: FallbackLlmRuntimeContext;

  constructor(
    gatewayConfig?: GatewayConfig,
    runtimeContext: FallbackLlmRuntimeContext = {},
  ) {
    this.gatewayConfig = gatewayConfig;
    this.runtimeContext = {
      ...runtimeContext,
      workspaceDir:
        normalizeRuntimePath(runtimeContext.workspaceDir) ??
        readGatewayWorkspaceDir(gatewayConfig) ??
        defaultOpenClawWorkspaceDir(),
    };
  }

  /**
   * Check if fallback is available (gateway config has at least one model).
   */
  isAvailable(agentIdOrOptions?: string | FallbackLlmAvailabilityOptions): boolean {
    const options = typeof agentIdOrOptions === "string"
      ? { agentId: agentIdOrOptions }
      : (agentIdOrOptions ?? {});
    const models = this.getModelChain(options.agentId, undefined, options.modelChain);
    return models.length > 0;
  }

  /**
   * Make a chat completion request using the gateway's default AI chain.
   * Tries primary first, then each fallback in order.
   * When agentId is provided, uses that agent persona's model chain instead of defaults.
   */
  async chatCompletion(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options: FallbackLlmOptions = {},
  ): Promise<FallbackLlmResponse | null> {
    const models = this.getModelChain(
      options.agentId,
      options.model,
      options.modelChain,
      options.includeDefaultModelFallback,
    );
    if (models.length === 0) {
      log.warn("task LLM: no models configured in gateway");
      return null;
    }
    options = withCodexRuntimeShutdown(options, this.runtimeContext.codexSubscriptionRunner);

    const runChain = async (
      initialOptions: FallbackLlmOptions,
    ): Promise<FallbackLlmResponse | null> => {
      let runOptions = initialOptions;
      let lastRejectedResponse: FallbackLlmResponse | null = null;
      let lastError: unknown;
      let terminalError: unknown;
      // Try each model in the chain
      for (let i = 0; i < models.length; i++) {
        if (runOptions.signal?.aborted) {
          throw abortReason(runOptions.signal);
        }
        const model = models[i];
        const isFallback = i > 0;

        try {
          const result = await this.tryModel(model, messages, runOptions);
          if (result) {
            const response = {
              content: result.content,
              modelUsed: model.modelString,
              usage: result.usage,
            };
            if (runOptions.acceptResponse && !runOptions.acceptResponse(response)) {
              lastRejectedResponse = response;
              log.debug(`task LLM: ${model.modelString} returned rejected output, trying next...`);
              continue;
            }
            if (isFallback) {
              log.debug(`task LLM: succeeded using ${model.modelString} (fallback ${i})`);
            }
            return response;
          }
        } catch (err) {
          if (isTerminalCodexSubscriptionError(err) && runOptions.signal?.aborted) {
            throw err;
          }
          if (runOptions.signal?.aborted) {
            throw abortReason(runOptions.signal);
          }
          lastError = err;
          if (
            (runOptions.jsonSchema || runOptions.responsesJsonSchema) &&
            isUnsupportedJsonSchemaError(err)
          ) {
            log.debug(`task LLM: ${model.modelString} rejected native JSON schema; retrying without it`);
            // Degrade to prompt-only for the REST of the chain too, so an
            // N-model chain where every provider rejects structured output
            // costs N+1 requests instead of 2N.
            runOptions = {
              ...runOptions,
              jsonSchema: undefined,
              responsesJsonSchema: undefined,
            };
            try {
              const result = await this.tryModel(model, messages, runOptions);
              if (result) {
                const response = {
                  content: result.content,
                  modelUsed: model.modelString,
                  usage: result.usage,
                };
                if (!runOptions.acceptResponse || runOptions.acceptResponse(response)) {
                  return response;
                }
                lastRejectedResponse = response;
                log.debug(`task LLM: ${model.modelString} unstructured retry output rejected by acceptResponse, trying next model...`);
                continue;
              }
            } catch (retryError) {
              if (isTerminalCodexSubscriptionError(retryError) && runOptions.signal?.aborted) {
                throw retryError;
              }
              if (runOptions.signal?.aborted) throw abortReason(runOptions.signal);
              lastError = retryError;
              const retryErrorMsg = runOptions.redactProviderErrors
                ? "provider error details redacted"
                : retryError instanceof Error
                  ? retryError.message
                  : String(retryError);
              log.debug(
                `task LLM: ${model.modelString} unstructured retry failed (${retryErrorMsg})`,
              );
              if (isTerminalCodexSubscriptionError(retryError)) {
                terminalError = retryError;
              }
            }
            continue;
          }
          const errorMsg = runOptions.redactProviderErrors
            ? "provider error details redacted"
            : err instanceof Error
              ? err.message
              : String(err);
          log.debug(`task LLM: ${model.modelString} failed (${errorMsg}), trying next...`);
          if (isTerminalCodexSubscriptionError(err)) {
            terminalError = err;
          }
          // Continue to next model in chain
        }
      }

      log.warn(`task LLM: all ${models.length} models in chain failed`);
      if (options.failureDiag && lastError !== undefined && !lastRejectedResponse) {
        options.failureDiag.lastError = lastError;
      }
      // A terminal typed provider failure must reach the caller when the
      // chain is exhausted — the documented timeout/re-login guidance
      // depends on it (issue #2833).
      if (terminalError !== undefined) {
        throw terminalError;
      }
      return lastRejectedResponse;
    };

    if (typeof options.timeoutMs === "number") {
      if (options.timeoutMs <= 0) {
        log.warn("task LLM: timed out before request started");
        return null;
      }
      const controller = new AbortController();
      const onCallerAbort = (): void => {
        controller.abort(abortReason(options.signal));
      };
      options.signal?.addEventListener("abort", onCallerAbort, { once: true });
      if (options.signal?.aborted) {
        onCallerAbort();
      }
      const timedOptions = { ...options, signal: controller.signal };
      const chain = runChain(timedOptions);
      const guarded = chain.then(
        (value) => value,
        (err) => {
          if (isTerminalCodexSubscriptionError(err)) throw err;
          return null;
        },
      );
      try {
        const timeoutError = Object.assign(
          new Error(`task LLM timed out after ${options.timeoutMs}ms`),
          { name: "TimeoutError" },
        );
        const outcome = await raceFallbackLlmDeadline(guarded, options.timeoutMs, () => {
          log.warn(`task LLM: timed out after ${options.timeoutMs}ms`);
          controller.abort(timeoutError);
          if (options.failureDiag) options.failureDiag.lastError = timeoutError;
        });
        return outcome.timedOut ? null : outcome.value;
      } finally {
        options.signal?.removeEventListener("abort", onCallerAbort);
      }
    }

    return await runChain(options);
  }

  /**
   * Make a request with structured output (Zod schema).
   * Returns parsed JSON or null on failure.
   */
  async parseWithSchema<T>(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    schema: { parse: (data: unknown) => T },
    options: FallbackLlmOptions = {},
  ): Promise<T | null> {
    const detailed = await this.parseWithSchemaDetailed(messages, schema, options);
    return detailed?.result ?? null;
  }

  /**
   * Like parseWithSchema but also returns the model that was used,
   * so callers can emit accurate trace events.
   */
  async parseWithSchemaDetailed<T>(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    schema: { parse: (data: unknown) => T },
    options: FallbackLlmOptions = {},
  ): Promise<
    | { result: T; modelUsed: string }
    | { result: null; failureReason: "no_models" | "empty" | "http_error" }
  > {
    let response: FallbackLlmResponse | null;
    try {
      response = await this.chatCompletion(messages, options);
    } catch (err) {
      // Caller aborts must propagate (e.g. recall planner cancellation) — do
      // not swallow them as a provider failure, or abort-driven callers lose
      // cancellation and treat it as an extraction error (codex review).
      // Terminal codex-subscription failures propagate for the same reason:
      // their TimeoutError/auth guidance is the documented contract.
      if (options.signal?.aborted || isTerminalCodexSubscriptionError(err)) throw err;
      log.warn("task LLM: chatCompletion threw during structured parse:", err);
      return { result: null, failureReason: "http_error" };
    }
    if (!response?.content) {
      // chatCompletion returns null both when no models are configured
      // (auth/config) and when every configured model errored (transient).
      // Disambiguate via the resolved model chain so the retry layer can pick
      // the right failure class.
      const hasModels =
        this.getModelChain(
          options.agentId,
          options.model,
          options.modelChain,
          options.includeDefaultModelFallback,
        ).length > 0;
      return { result: null, failureReason: hasModels ? "http_error" : "no_models" };
    }

    try {
      const candidates = extractJsonCandidates(response.content);
      for (const c of candidates) {
        try {
          const parsed = JSON.parse(c);
          return { result: schema.parse(parsed), modelUsed: response.modelUsed };
        } catch {
          // keep trying other candidates
        }
      }
      return { result: null, failureReason: "empty" };
    } catch (err) {
      log.warn("task LLM: failed to parse structured output:", err);
      return { result: null, failureReason: "empty" };
    }
  }

  /**
   * Get the full model chain from gateway config.
   * Returns array of models in order: [primary, fallback1, fallback2, ...]
   *
   * When modelChainOverride is provided, uses it instead of any configured
   * agent/default chain. Otherwise, when agentId is provided, looks up the
   * matching entry in agents.list[] and uses that persona's model chain.
   * Falls back to agents.defaults.model if agentId is not found or not provided.
   */
  private getModelChain(
    agentId?: string,
    modelOverride?: string,
    modelChainOverride?: AgentPersonaModelConfig,
    includeDefaultModelFallback = true,
  ): ModelRef[] {
    const chain: ModelRef[] = [];
    const providers = this.gatewayConfig?.models?.providers ?? {};

    // Resolve the model config: explicit task chain, agent persona chain, or global defaults
    let modelConfig: AgentPersonaModelConfig | undefined;

    if (modelChainOverride?.primary) {
      modelConfig = modelChainOverride;
      log.debug("task LLM: using explicit model chain override");
    } else if (modelChainOverride) {
      log.warn("task LLM: ignoring explicit model chain override without primary model");
    }

    if (!modelConfig && agentId) {
      const persona = this.gatewayConfig?.agents?.list?.find(
        (a) => a.id === agentId,
      );
      if (persona?.model) {
        modelConfig = persona.model;
        log.debug(`task LLM: using agent persona "${agentId}" model chain`);
      } else {
        log.warn(
          `task LLM: agent persona "${agentId}" not found or has no model config, falling back to defaults`,
        );
      }
    }

    if (!modelConfig) {
      modelConfig = this.gatewayConfig?.agents?.defaults?.model;
    }

    // Build list of model strings: primary + fallbacks
    const modelStrings: string[] = [];

    const addModelString = (value: unknown): void => {
      if (typeof value !== "string") return;
      const trimmed = value.trim();
      if (trimmed.length > 0 && !modelStrings.includes(trimmed)) {
        modelStrings.push(trimmed);
      }
    };

    addModelString(modelOverride);
    addModelString(modelConfig?.primary);

    if (Array.isArray(modelConfig?.fallbacks)) {
      for (const fb of modelConfig.fallbacks) {
        addModelString(fb);
      }
    }

    // Parse each model string and look up provider config
    for (const modelString of modelStrings) {
      const modelRef = this.parseModelString(modelString, providers);
      if (modelRef) {
        chain.push(modelRef);
      }
    }

    // Implicit last-resort: when a task-specific modelChain override is active,
    // append the gateway default model so a stale or exhausted taskModelChain
    // never leaves the chain empty — Remnic should never be the reason a chat is
    // interrupted by a flush failure. Keyed on `modelChainOverride?.primary` —
    // the SAME activation condition chain resolution uses above — so a
    // primary-less override (e.g. {}) that falls through to a persona/default
    // chain does NOT get the default appended (gotcha #39). Issue #1365 / PR #1370.
    if (includeDefaultModelFallback && modelChainOverride?.primary && modelStrings.length > 0) {
      // Append the FULL gateway default chain (primary + fallbacks), not just
      // the primary — if the default primary is also unreachable, a listed
      // default fallback may still succeed (cursor review #1425).
      const defaults = this.gatewayConfig?.agents?.defaults?.model;
      const defaultStrings: string[] = [
        ...(typeof defaults?.primary === "string" ? [defaults.primary] : []),
        ...(Array.isArray(defaults?.fallbacks) ? defaults.fallbacks : []),
      ];
      for (const candidate of defaultStrings) {
        if (typeof candidate !== "string") continue;
        const trimmed = candidate.trim();
        if (trimmed.length === 0 || modelStrings.includes(trimmed)) continue;
        const defaultRef = this.parseModelString(trimmed, providers);
        if (defaultRef) {
          chain.push(defaultRef);
          modelStrings.push(trimmed); // keep dedupe correct for later default fallbacks
          log.debug(
            `task LLM: appended gateway default model "${trimmed}" as implicit last resort`,
          );
        }
      }
    }

    return chain;
  }

  /**
   * Parse a "provider/model" string and look up its config.
   */
  private parseModelString(
    modelString: string,
    providers: Record<string, ModelProviderConfig>,
  ): ModelRef | null {
    // Parse "provider/model" format (e.g., "openai/gpt-5.5", "anthropic/claude-opus-4-6")
    const parts = modelString.split("/");
    if (parts.length < 2) {
      log.warn(`task LLM: invalid model format: ${modelString}`);
      return null;
    }

    const requestedProviderId = parts[0];
    const modelId = parts.slice(1).join("/"); // Handle cases like "openai/gpt-5.5"

    // Respect the active gateway config first so profile-local overrides and
    // credentials win. Fall back to the materialized models.json only when
    // the provider is absent from the loaded config (for built-in providers
    // registered by the gateway at runtime).
    const resolvedProvider = this.resolveProviderConfig(requestedProviderId, providers);
    const providerConfig = resolvedProvider?.config;
    if (!providerConfig) {
      log.warn(
        `task LLM: provider not found: ${requestedProviderId} ` +
        `(tried: ${this.providerResolutionCandidates(requestedProviderId).join(", ")})`,
      );
      return null;
    }

    return {
      providerId: resolvedProvider.providerId,
      modelId,
      providerConfig,
      modelString,
    };
  }

  private resolveProviderConfig(
    providerId: string,
    providers: Record<string, ModelProviderConfig>,
  ): { providerId: string; config: ModelProviderConfig } | null {
    const candidates = this.providerResolutionCandidates(providerId);
    const aliasCandidates = candidates.filter((candidate) => candidate !== providerId);
    const fallbackCandidates = LEGACY_PROVIDER_IDS.has(providerId)
      ? [...aliasCandidates, providerId]
      : [providerId, ...aliasCandidates];
    for (const candidate of candidates) {
      const config = providers[candidate];
      if (config) {
        if (candidate !== providerId) {
          log.debug(`task LLM: provider "${providerId}" resolved via alias "${candidate}"`);
        }
        return { providerId: candidate, config };
      }
    }
    for (const candidate of fallbackCandidates) {
      const config = this.resolveFromModelsJson(candidate);
      if (config) {
        if (candidate !== providerId) {
          log.debug(`task LLM: provider "${providerId}" resolved via models.json alias "${candidate}"`);
        }
        return { providerId: candidate, config };
      }
      const builtInConfig = BUILT_IN_PROVIDER_FALLBACKS[candidate];
      if (builtInConfig) {
        if (candidate === providerId) {
          log.debug(`task LLM: provider "${providerId}" resolved from built-in defaults`);
          return { providerId, config: builtInConfig };
        }
        log.debug(`task LLM: provider "${providerId}" resolved via built-in alias "${candidate}"`);
        return { providerId: candidate, config: builtInConfig };
      }
    }
    return null;
  }

  private providerResolutionCandidates(providerId: string): string[] {
    const candidates = [providerId, ...(PROVIDER_ALIASES[providerId] ?? [])];
    return [...new Set(candidates)];
  }

  /**
   * Look up a provider from the gateway's materialized models.json, which
   * contains all providers including built-in ones (openai-codex, google-vertex,
   * etc.) that aren't in the user's openclaw.json but are registered by
   * gateway plugins. Returns null if the provider isn't found there either.
   */
  private resolveFromModelsJson(providerId: string): ModelProviderConfig | null {
    const allProviders = loadModelsJsonProviders();
    const config = allProviders[providerId];
    if (config) {
      log.debug(`task LLM: resolved provider "${providerId}" from models.json (api: ${config.api ?? "default"})`);
      return config;
    }
    return null;
  }

  /**
   * Try to call a single model.
   *
   * Uses the gateway's native getRuntimeAuthForModel when available — this
   * handles all provider-specific auth transforms (OAuth token exchange,
   * base URL overrides for codex/copilot/etc.) through the same codepath
   * the gateway itself uses. Falls back to resolveProviderApiKey for
   * simpler providers or when the runtime module isn't loaded.
   */
  private async tryModel(
    model: ModelRef,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options: FallbackLlmOptions,
  ): Promise<{ content: string; usage?: FallbackLlmResponse["usage"] } | null> {
    const codexResult = await tryCodexSubscriptionProvider(
      model,
      messages,
      options,
      () => this.resolveFallbackApiKey(model),
      this.runtimeContext.codexSubscriptionRunner,
    );
    if (codexResult !== undefined) return codexResult;
    const runtimeAuth = await this.resolveRuntimeAuth(model);
    const effectiveBaseUrl = runtimeAuth?.baseUrl ?? model.providerConfig.baseUrl;
    const resolvedApiKey = runtimeAuth?.apiKey ?? await this.resolveFallbackApiKey(model);

    // If the raw key looks like an unresolved secret ref and resolution fails,
    // skip this provider entirely so the chain falls through to the next.
    const rawKey = model.providerConfig.apiKey;
    const needsResolution = rawKey === "secretref-managed" || (typeof rawKey === "object" && rawKey !== null);
    if (needsResolution && !resolvedApiKey) {
      throw new Error(`API key for provider "${model.providerId}" could not be resolved from secret ref`);
    }

    const effectiveConfig: ModelProviderConfig = {
      ...model.providerConfig,
      baseUrl: effectiveBaseUrl,
      ...(resolvedApiKey ? { apiKey: resolvedApiKey } : {}),
    };

    if (model.providerConfig.api === "anthropic-messages") {
      return await this.callAnthropic(effectiveConfig, model.modelId, messages, options);
    }

    if (model.providerConfig.api === "ollama-chat") {
      return await this.callOllamaChat(effectiveConfig, model.modelId, messages, options);
    }

    if (
      model.providerConfig.api === "openai-responses" ||
      model.providerConfig.api === "openai-codex-responses" ||
      model.providerConfig.api === "azure-openai-responses"
    ) {
      return await this.callOpenAIResponses(
        effectiveConfig,
        model.modelId,
        messages,
        options,
      );
    }

    // For OpenAI-compatible chat-completions APIs (openai-completions,
    // ollama, etc.) and unknown formats, use chat completions — the gateway's
    // runtime auth resolver returns request-ready base URL and credentials for
    // most providers.
    return await this.callOpenAI(
      effectiveConfig,
      model.modelId,
      messages,
      options,
      shouldAssumeOpenAiChatCompletions(effectiveConfig.baseUrl),
    );
  }

  /**
   * Resolve request-ready auth through the gateway's native runtime, which
   * handles provider-specific transforms (OAuth token exchange for codex/copilot,
   * base URL rewrite, etc.). Returns null if the runtime isn't available.
   */
  private async resolveRuntimeAuth(
    model: ModelRef,
  ): Promise<{ apiKey?: string; baseUrl?: string } | null> {
    try {
      const getRuntimeAuth = await getGatewayRuntimeAuthForModel({
        getRuntimeAuthForModel: this.runtimeContext.getRuntimeAuthForModel,
      });
      if (!getRuntimeAuth) return null;

      const result = await getRuntimeAuth({
        model: {
          provider: model.providerId,
          id: model.modelId,
          api: model.providerConfig.api,
          baseUrl: model.providerConfig.baseUrl,
        },
        cfg: this.gatewayConfig,
        workspaceDir: this.runtimeContext.workspaceDir,
      });

      if (result?.apiKey || result?.baseUrl) {
        log.debug(
          `task LLM: resolved runtime auth for "${model.modelString}" (source: ${result.source ?? "unknown"}, mode: ${result.mode ?? "unknown"})`,
        );
        return { apiKey: result.apiKey, baseUrl: result.baseUrl };
      }
    } catch (err) {
      log.debug(
        `task LLM: gateway runtime auth failed for "${model.modelString}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return null;
  }

  /**
   * Resolve API key through the existing provider-level resolution (env vars,
   * secret refs, etc.). Used as fallback when gateway runtime auth isn't available.
   */
  private async resolveFallbackApiKey(model: ModelRef): Promise<string | undefined> {
    return resolveProviderApiKey(
      model.providerId,
      model.providerConfig.apiKey,
      this.gatewayConfig,
      this.runtimeContext.agentDir,
      {
        resolveApiKeyForProvider: this.runtimeContext.resolveApiKeyForProvider,
      },
    );
  }

  /**
   * Call OpenAI-compatible API.
   */
  private async callOpenAI(
    config: ModelProviderConfig,
    modelId: string,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options: FallbackLlmOptions,
    assumeOpenAI: boolean,
  ): Promise<{ content: string; usage?: FallbackLlmResponse["usage"] } | null> {
    const base = config.baseUrl.replace(/\/$/, "");
    const url = base.endsWith("/v1")
      ? `${base}/chat/completions`
      : `${base}/v1/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...config.headers,
    };

    // Handle auth — apiKey is already resolved to a string by tryModel()
    if (config.apiKey && typeof config.apiKey === "string") {
      if (config.authHeader !== false) {
        headers["Authorization"] = `Bearer ${config.apiKey}`;
      }
    }

    const body = {
      model: modelId,
      messages,
      ...buildChatCompletionTemperature(modelId, options.temperature ?? 0.3, {
        assumeOpenAI,
      }),
      ...buildChatCompletionTokenLimit(modelId, options.maxTokens ?? 4096, {
        assumeOpenAI,
      }),
      ...(options.jsonSchema
        ? {
            response_format: {
              type: "json_schema",
              json_schema: {
                name: options.jsonSchema.name,
                strict: options.jsonSchema.strict ?? false,
                schema: options.jsonSchema.schema,
              },
            },
          }
        : {}),
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      signal: options.signal,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw Object.assign(new Error(`OpenAI API error: ${response.status} ${error}`), { status: response.status });
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: {
          content: string;
        };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Empty response from OpenAI API");
    }

    return {
      content,
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens,
            outputTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
    };
  }

  /**
   * Call Ollama's native /api/chat transport. This lets benchmark-isolated
   * gateway configs route Remnic's own internal LLM calls to Ollama Cloud
   * without requiring an OpenAI-compatible shim.
   */
  private async callOllamaChat(
    config: ModelProviderConfig,
    modelId: string,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options: FallbackLlmOptions,
  ): Promise<{ content: string; usage?: FallbackLlmResponse["usage"] } | null> {
    const base = config.baseUrl.replace(/\/$/, "");
    const url = base.endsWith("/api") ? `${base}/chat` : `${base}/api/chat`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...config.headers,
    };
    if (config.apiKey && typeof config.apiKey === "string" && config.authHeader !== false) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      signal: options.signal,
      body: JSON.stringify({
        model: modelId,
        messages,
        stream: false,
        ...(config.disableThinking ? { think: false } : {}),
        options: {
          temperature: options.temperature ?? 0.3,
          num_predict: options.maxTokens ?? 4096,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw Object.assign(new Error(`Ollama API error: ${response.status} ${error}`), { status: response.status });
    }

    const data = (await response.json()) as {
      message?: { content?: string };
      response?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const content = data.message?.content ?? data.response;
    if (!content) {
      throw new Error("Empty response from Ollama API");
    }

    const inputTokens = data.prompt_eval_count ?? 0;
    const outputTokens = data.eval_count ?? 0;
    return {
      content,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
    };
  }

  /**
   * Call an OpenAI-compatible Responses API.
   */
  private async callOpenAIResponses(
    config: ModelProviderConfig,
    modelId: string,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options: FallbackLlmOptions,
  ): Promise<{ content: string; usage?: FallbackLlmResponse["usage"] } | null> {
    const base = config.baseUrl.replace(/\/$/, "");
    const url = base.endsWith("/v1")
      ? `${base}/responses`
      : `${base}/v1/responses`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...config.headers,
    };

    if (config.apiKey && typeof config.apiKey === "string" && config.authHeader !== false) {
      headers["Authorization"] = `Bearer ${config.apiKey}`;
    }

    const instructions = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n")
      .trim();
    const input = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role,
        content: [{
          type: message.role === "assistant" ? "output_text" : "input_text",
          text: message.content,
        }],
      }));

    const body: Record<string, unknown> = {
      model: modelId,
      input,
      max_output_tokens: Math.max(0, Math.floor(options.maxTokens ?? 4096)),
      ...buildChatCompletionTemperature(modelId, options.temperature ?? 0.3, {
        assumeOpenAI: shouldAssumeOpenAiChatCompletions(config.baseUrl),
      }),
      ...(options.store === undefined ? {} : { store: options.store }),
      ...(options.jsonSchema || options.responsesJsonSchema
        ? {
            text: {
              format: {
                type: "json_schema",
                name: (options.jsonSchema ?? options.responsesJsonSchema)!.name,
                strict: (options.jsonSchema?.strict ?? (options.responsesJsonSchema ? true : false)),
                schema: (options.jsonSchema ?? options.responsesJsonSchema)!.schema,
              },
            },
          }
        : {}),
    };
    if (instructions.length > 0) {
      body.instructions = instructions;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      signal: options.signal,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw Object.assign(new Error(`OpenAI Responses API error: ${response.status} ${error}`), { status: response.status });
    }

    const data = (await response.json()) as {
      output_text?: string;
      output?: Array<{
        type?: string;
        text?: string;
        content?: Array<{
          type?: string;
          text?: string;
        }>;
      }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
      };
    };

    const outputText = extractResponsesOutputText(data);
    if (!outputText) {
      throw new Error("Empty response from OpenAI Responses API");
    }

    return {
      content: outputText,
      usage: data.usage
        ? {
            inputTokens: data.usage.input_tokens,
            outputTokens: data.usage.output_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
    };
  }

  /**
   * Call Anthropic Messages API.
   */
  private async callAnthropic(
    config: ModelProviderConfig,
    modelId: string,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options: FallbackLlmOptions,
  ): Promise<{ content: string; usage?: FallbackLlmResponse["usage"] } | null> {
    const base = config.baseUrl.replace(/\/$/, "");
    const url = base.endsWith("/v1")
      ? `${base}/messages`
      : `${base}/v1/messages`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...config.headers,
    };

    // Handle auth - Anthropic uses x-api-key header (apiKey resolved by tryModel)
    if (config.apiKey && typeof config.apiKey === "string") {
      headers["x-api-key"] = config.apiKey;
    }

    // Extract system message (Anthropic handles it separately)
    const systemMessage = messages.find((m) => m.role === "system")?.content;
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    // Convert messages to Anthropic format
    const anthropicMessages = nonSystemMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const body: Record<string, unknown> = {
      model: modelId,
      messages: anthropicMessages,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.3,
    };

    if (systemMessage) {
      body.system = systemMessage;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      signal: options.signal,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw Object.assign(new Error(`Anthropic API error: ${response.status} ${error}`), { status: response.status });
    }

    const data = (await response.json()) as {
      content: Array<{
        type: string;
        text: string;
      }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
      };
    };

    const content = data.content?.[0]?.text;
    if (!content) {
      throw new Error("Empty response from Anthropic API");
    }

    return {
      content,
      usage: data.usage
        ? {
            inputTokens: data.usage.input_tokens,
            outputTokens: data.usage.output_tokens,
            totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
          }
        : undefined,
    };
  }
}


function normalizeRuntimePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? expandTildePath(trimmed) : undefined;
}

function readGatewayWorkspaceDir(gatewayConfig: GatewayConfig | undefined): string | undefined {
  if (!gatewayConfig || typeof gatewayConfig !== "object") return undefined;
  const raw = gatewayConfig as Record<string, unknown>;
  return (
    normalizeRuntimePath(raw.workspaceDir) ??
    normalizeRuntimePath(raw.workspacePath) ??
    normalizeRuntimePath(raw.workspace)
  );
}

function defaultOpenClawWorkspaceDir(): string {
  return path.join(resolveHomeDir(), ".openclaw", "workspace");
}

