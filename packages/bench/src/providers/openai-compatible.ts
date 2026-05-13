/**
 * Minimal OpenAI-compatible provider for phase 1 bench execution.
 */

import type {
  CompletionOpts,
  CompletionResult,
  DiscoveredModel,
  LlmProvider,
  OpenAiCompatibleProviderConfig,
  TokenUsage,
} from "./types.js";
import { retryFetch } from "./retry-fetch.js";

interface ChatCompletionResponse {
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

interface ModelsResponse {
  data?: Array<{
    id: string;
    name?: string;
    context_length?: number;
    capabilities?: Array<"completion" | "embedding" | "vision">;
    quantization?: string;
    parameter_count?: string;
  }>;
}

class OpenAiCompatibleProvider implements LlmProvider {
  readonly provider: "openai" | "litellm";
  readonly id: string;
  readonly name: string;

  private readonly config: Required<Pick<OpenAiCompatibleProviderConfig, "model">> &
    OpenAiCompatibleProviderConfig;
  private usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  constructor(config: OpenAiCompatibleProviderConfig) {
    this.config = config;
    this.provider = config.provider ?? "openai";
    this.id = `${this.provider}:${config.model}`;
    this.name = config.model;
  }

  async complete(
    prompt: string,
    opts: CompletionOpts = {},
  ): Promise<CompletionResult> {
    const startedAt = performance.now();
    const response = await retryFetch(
      this.urlFor("chat/completions"),
      {
        method: "POST",
        headers: this.headers(opts.headers),
        signal: opts.signal,
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            ...(opts.systemPrompt
              ? [{ role: "system", content: opts.systemPrompt }]
              : []),
            { role: "user", content: prompt },
          ],
          temperature: opts.temperature,
          max_tokens: opts.maxTokens,
          ...(this.config.disableThinking &&
          isThinkingCompatibleBackend(this.config.baseUrl)
            ? { chat_template_kwargs: { enable_thinking: false } }
            : {}),
        }),
      },
      this.config.retryOptions,
    );

    if (!response.ok) {
      const errorBody = await readErrorBody(response);
      const contextHint = buildContextHint(errorBody, this.config.baseUrl);
      throw new Error(
        `OpenAI-compatible completion failed: ${response.status} ${response.statusText}${errorBody ? ` — ${errorBody}` : ""}${contextHint}`,
      );
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const promptTokens = payload.usage?.prompt_tokens ?? 0;
    const completionTokens = payload.usage?.completion_tokens ?? 0;

    this.recordUsage(promptTokens, completionTokens);

    return {
      text: readMessageText(payload),
      tokens: {
        input: promptTokens,
        output: completionTokens,
      },
      latencyMs: Math.round(performance.now() - startedAt),
      model: payload.model ?? this.config.model,
    };
  }

  async discover(): Promise<DiscoveredModel[]> {
    const response = await retryFetch(
      this.urlFor("models"),
      {
        method: "GET",
        headers: this.headers(),
      },
      this.config.retryOptions,
    );

    if (!response.ok) {
      throw new Error(
        `OpenAI-compatible model discovery failed: ${response.status} ${response.statusText}`,
      );
    }

    const payload = (await response.json()) as ModelsResponse;
    return (payload.data ?? []).map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      contextLength: model.context_length ?? 0,
      capabilities: model.capabilities ?? ["completion"],
      ...(model.quantization
        ? { quantization: model.quantization }
        : {}),
      ...(model.parameter_count
        ? { parameterCount: model.parameter_count }
        : {}),
    }));
  }

  getUsage(): TokenUsage {
    return { ...this.usage };
  }

  resetUsage(): void {
    this.usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
  }

  private headers(extraHeaders: Record<string, string> = {}): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.config.apiKey
        ? { authorization: `Bearer ${this.config.apiKey}` }
        : {}),
      ...(this.config.headers ?? {}),
      ...extraHeaders,
    };
  }

  private recordUsage(inputTokens: number, outputTokens: number): void {
    this.usage = {
      inputTokens: this.usage.inputTokens + inputTokens,
      outputTokens: this.usage.outputTokens + outputTokens,
      totalTokens:
        this.usage.totalTokens + inputTokens + outputTokens,
    };
  }

  private urlFor(pathname: string): string {
    const baseUrl = this.config.baseUrl ?? "https://api.openai.com/v1";
    const normalizedBase = baseUrl.endsWith("/")
      ? baseUrl.slice(0, -1)
      : baseUrl;
    const normalizedPath = pathname.startsWith("/")
      ? pathname.slice(1)
      : pathname;

    return `${normalizedBase}/${normalizedPath}`;
  }
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (text.length === 0) {
      return "";
    }

    return text.replace(/\s+/g, " ").slice(0, 400);
  } catch {
    return "";
  }
}

function buildContextHint(errorBody: string, baseUrl?: string): string {
  if (!isContextWindowError(errorBody)) {
    return "";
  }

  if (isLmStudioBaseUrl(baseUrl)) {
    return " — LM Studio is running this model with a context window that is too small for this benchmark. Increase the model context length in LM Studio and rerun.";
  }

  return " — The OpenAI-compatible model server is running this model with a context window that is too small for this benchmark. Increase the loaded model context length and rerun.";
}

function isContextWindowError(errorBody: string): boolean {
  const normalized = errorBody.toLowerCase();
  return (
    normalized.includes("context length") ||
    normalized.includes("n_keep") ||
    normalized.includes("n_ctx")
  );
}

export function isLmStudioBaseUrl(baseUrl?: string): boolean {
  if (!baseUrl) {
    return false;
  }

  try {
    const url = new URL(baseUrl);
    return (
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.port === "1234"
    );
  } catch {
    return false;
  }
}

function isVllmBaseUrl(baseUrl?: string): boolean {
  if (!baseUrl) {
    return false;
  }

  try {
    const url = new URL(baseUrl);
    const normalizedPath = url.pathname.replace(/\/+$/, "");
    return (
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.port === "8000" &&
      normalizedPath === "/v1"
    );
  } catch {
    return false;
  }
}

export function isThinkingCompatibleBackend(baseUrl?: string): boolean {
  return isLmStudioBaseUrl(baseUrl) || isVllmBaseUrl(baseUrl);
}

function readMessageText(payload: ChatCompletionResponse): string {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => part.text ?? "")
      .join("")
      .trim();
  }

  return "";
}

export function createOpenAiCompatibleProvider(
  config: OpenAiCompatibleProviderConfig,
): LlmProvider {
  return new OpenAiCompatibleProvider(config);
}
