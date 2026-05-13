import { log } from "./logger.js";
import path from "node:path";
import type { GatewayConfig, ModelProviderConfig, AgentPersona } from "./types.js";
import { extractJsonCandidates } from "./json-extract.js";
import {
  buildChatCompletionTemperature,
  buildChatCompletionTokenLimit,
  shouldAssumeOpenAiChatCompletions,
} from "./openai-chat-compat.js";
import { resolveProviderApiKey, getGatewayRuntimeAuthForModel } from "./resolve-provider-secret.js";
import { loadModelsJsonProviders } from "./models-json.js";
import { callCodexCliFallback } from "./codex-cli-fallback.js";
import { resolveHomeDir } from "./runtime/env.js";
import { expandTildePath } from "./utils/path.js";

export interface FallbackLlmOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Override which agent persona's model chain to use (by ID from agents.list[]). */
  agentId?: string;
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
  workspaceDir?: string;
}

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

const BUILT_IN_PROVIDER_FALLBACKS: Record<string, ModelProviderConfig> = {
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    api: "anthropic-messages",
    models: [],
    [PROVIDER_API_KEY_FIELD]: MANAGED_SECRETREF_MARKER,
  },
};

/**
 * Generic fallback LLM client that uses the gateway's default AI configuration
 * and walks through the full fallback chain (primary + fallbacks).
 * Supports OpenAI and Anthropic API formats.
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
  isAvailable(agentId?: string): boolean {
    const models = this.getModelChain(agentId);
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
    const models = this.getModelChain(options.agentId);
    if (models.length === 0) {
      log.warn("fallback LLM: no models configured in gateway");
      return null;
    }

    const runChain = async (
      runOptions: FallbackLlmOptions,
    ): Promise<FallbackLlmResponse | null> => {
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
            if (isFallback) {
              log.debug(`fallback LLM: succeeded using ${model.modelString} (fallback ${i})`);
            }
            return {
              content: result.content,
              modelUsed: model.modelString,
              usage: result.usage,
            };
          }
        } catch (err) {
          if (runOptions.signal?.aborted) {
            throw abortReason(runOptions.signal);
          }
          const errorMsg = err instanceof Error ? err.message : String(err);
          log.debug(`fallback LLM: ${model.modelString} failed (${errorMsg}), trying next...`);
          // Continue to next model in chain
        }
      }

      log.warn(`fallback LLM: all ${models.length} models in chain failed`);
      return null;
    };

    if (typeof options.timeoutMs === "number") {
      if (options.timeoutMs <= 0) {
        log.warn("fallback LLM: timed out before request started");
        return null;
      }
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
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
      chain.catch(() => {});
      try {
        return await Promise.race([
          chain,
          new Promise<null>((resolve) => {
            timeoutHandle = setTimeout(() => {
              log.warn(`fallback LLM: timed out after ${options.timeoutMs}ms`);
              controller.abort(
                new Error(`fallback LLM timed out after ${options.timeoutMs}ms`),
              );
              resolve(null);
            }, options.timeoutMs);
          }),
        ]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
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
  ): Promise<{ result: T; modelUsed: string } | null> {
    const response = await this.chatCompletion(messages, options);
    if (!response?.content) return null;

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
      return null;
    } catch (err) {
      log.warn("fallback LLM: failed to parse structured output:", err);
      return null;
    }
  }

  /**
   * Get the full model chain from gateway config.
   * Returns array of models in order: [primary, fallback1, fallback2, ...]
   *
   * When agentId is provided, looks up the matching entry in agents.list[]
   * and uses that persona's model chain. Falls back to agents.defaults.model
   * if agentId is not found or not provided.
   */
  private getModelChain(agentId?: string): ModelRef[] {
    const chain: ModelRef[] = [];
    const providers = this.gatewayConfig?.models?.providers ?? {};

    // Resolve the model config: agent persona chain or global defaults
    let modelConfig: { primary?: string; fallbacks?: string[] } | undefined;

    if (agentId) {
      const persona = this.gatewayConfig?.agents?.list?.find(
        (a) => a.id === agentId,
      );
      if (persona?.model) {
        modelConfig = persona.model;
        log.debug(`fallback LLM: using agent persona "${agentId}" model chain`);
      } else {
        log.warn(
          `fallback LLM: agent persona "${agentId}" not found or has no model config, falling back to defaults`,
        );
      }
    }

    if (!modelConfig) {
      modelConfig = this.gatewayConfig?.agents?.defaults?.model;
    }

    // Build list of model strings: primary + fallbacks
    const modelStrings: string[] = [];

    if (modelConfig?.primary) {
      modelStrings.push(modelConfig.primary);
    }

    if (Array.isArray(modelConfig?.fallbacks)) {
      for (const fb of modelConfig.fallbacks) {
        if (typeof fb === "string" && !modelStrings.includes(fb)) {
          modelStrings.push(fb);
        }
      }
    }

    // Parse each model string and look up provider config
    for (const modelString of modelStrings) {
      const modelRef = this.parseModelString(modelString, providers);
      if (modelRef) {
        chain.push(modelRef);
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
    // Parse "provider/model" format (e.g., "openai/gpt-5.2", "anthropic/claude-opus-4-6")
    const parts = modelString.split("/");
    if (parts.length < 2) {
      log.warn(`fallback LLM: invalid model format: ${modelString}`);
      return null;
    }

    const requestedProviderId = parts[0];
    const modelId = parts.slice(1).join("/"); // Handle cases like "openai/gpt-5.2-turbo"

    // Respect the active gateway config first so profile-local overrides and
    // credentials win. Fall back to the materialized models.json only when
    // the provider is absent from the loaded config (for built-in providers
    // registered by the gateway at runtime).
    const resolvedProvider = this.resolveProviderConfig(requestedProviderId, providers);
    const providerConfig = resolvedProvider?.config;
    if (!providerConfig) {
      log.warn(
        `fallback LLM: provider not found: ${requestedProviderId} ` +
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
          log.debug(`fallback LLM: provider "${providerId}" resolved via alias "${candidate}"`);
        }
        return { providerId: candidate, config };
      }
    }
    for (const candidate of fallbackCandidates) {
      const config = this.resolveFromModelsJson(candidate);
      if (config) {
        if (candidate !== providerId) {
          log.debug(`fallback LLM: provider "${providerId}" resolved via models.json alias "${candidate}"`);
        }
        return { providerId: candidate, config };
      }
      const builtInConfig = BUILT_IN_PROVIDER_FALLBACKS[candidate];
      if (builtInConfig) {
        if (candidate === providerId) {
          log.debug(`fallback LLM: provider "${providerId}" resolved from built-in defaults`);
          return { providerId, config: builtInConfig };
        }
        log.debug(`fallback LLM: provider "${providerId}" resolved via built-in alias "${candidate}"`);
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
      log.debug(`fallback LLM: resolved provider "${providerId}" from models.json (api: ${config.api ?? "default"})`);
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
    // Try the gateway's native runtime auth first — it handles all provider-
    // specific transforms (OAuth exchange, base URL rewrite, etc.)
    const runtimeAuth = model.providerConfig.api === "codex-cli"
      ? null
      : await this.resolveRuntimeAuth(model);
    const effectiveBaseUrl = runtimeAuth?.baseUrl ?? model.providerConfig.baseUrl;
    const resolvedApiKey = runtimeAuth?.apiKey
      ?? (
        model.providerConfig.api === "codex-cli" && model.providerConfig.apiKey === undefined
          ? undefined
          : await this.resolveFallbackApiKey(model)
      );

    // If the raw key looks like an unresolved secret ref and resolution fails,
    // skip this provider entirely so the chain falls through to the next.
    const rawKey = model.providerConfig.apiKey;
    const needsResolution = rawKey === "secretref-managed"
      || (typeof rawKey === "object" && rawKey !== null);
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

    if (model.providerConfig.api === "codex-cli") {
      return await callCodexCliFallback(
        effectiveConfig,
        model.modelId,
        messages,
        { timeoutMs: options.timeoutMs, signal: options.signal },
      );
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
      const getRuntimeAuth = await getGatewayRuntimeAuthForModel();
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
          `fallback LLM: resolved runtime auth for "${model.modelString}" (source: ${result.source ?? "unknown"}, mode: ${result.mode ?? "unknown"})`,
        );
        return { apiKey: result.apiKey, baseUrl: result.baseUrl };
      }
    } catch (err) {
      log.debug(
        `fallback LLM: gateway runtime auth failed for "${model.modelString}": ${err instanceof Error ? err.message : String(err)}`,
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
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      signal: options.signal,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${error}`);
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
      throw new Error(`Ollama API error: ${response.status} ${error}`);
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
      throw new Error(`OpenAI Responses API error: ${response.status} ${error}`);
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
      throw new Error(`Anthropic API error: ${response.status} ${error}`);
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

function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error("fallback LLM request aborted");
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

function extractResponsesOutputText(data: {
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
