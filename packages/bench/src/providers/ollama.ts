import type {
  CompletionOpts,
  CompletionResult,
  DiscoveredModel,
  LlmProvider,
  OllamaProviderConfig,
  TokenUsage,
} from "./types.js";
import { retryFetch } from "./retry-fetch.js";

interface OllamaGenerateResponse {
  model?: string;
  response?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaTagsResponse {
  models?: Array<{
    name: string;
    details?: {
      parameter_size?: string;
      quantization_level?: string;
    };
  }>;
}

class OllamaProvider implements LlmProvider {
  readonly provider = "ollama" as const;
  readonly id: string;
  readonly name: string;

  private readonly config: OllamaProviderConfig;
  private usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  constructor(config: OllamaProviderConfig) {
    this.config = config;
    this.id = `ollama:${config.model}`;
    this.name = config.model;
  }

  async complete(
    prompt: string,
    opts: CompletionOpts = {},
  ): Promise<CompletionResult> {
    const startedAt = performance.now();
    const response = await retryFetch(
      this.urlFor("generate"),
      {
        method: "POST",
        headers: this.headers(opts.headers),
        signal: opts.signal,
        body: JSON.stringify({
          model: this.config.model,
          prompt,
          system: opts.systemPrompt,
          stream: false,
          options: {
            temperature: opts.temperature,
            num_predict: opts.maxTokens,
          },
        }),
      },
      this.config.retryOptions,
    );

    if (!response.ok) {
      throw new Error(
        `Ollama completion failed: ${response.status} ${response.statusText}`,
      );
    }

    const payload = (await response.json()) as OllamaGenerateResponse;
    const inputTokens = payload.prompt_eval_count ?? 0;
    const outputTokens = payload.eval_count ?? 0;
    this.recordUsage(inputTokens, outputTokens);

    return {
      text: payload.response?.trim() ?? "",
      tokens: {
        input: inputTokens,
        output: outputTokens,
      },
      latencyMs: Math.round(performance.now() - startedAt),
      model: payload.model ?? this.config.model,
    };
  }

  async discover(): Promise<DiscoveredModel[]> {
    const response = await retryFetch(
      this.urlFor("tags"),
      {
        method: "GET",
        headers: this.headers(),
      },
      this.config.retryOptions,
    );

    if (!response.ok) {
      throw new Error(
        `Ollama model discovery failed: ${response.status} ${response.statusText}`,
      );
    }

    const payload = (await response.json()) as OllamaTagsResponse;
    return (payload.models ?? []).map((model) => ({
      id: model.name,
      name: model.name,
      contextLength: 0,
      capabilities: ["completion"],
      ...(model.details?.quantization_level
        ? { quantization: model.details.quantization_level }
        : {}),
      ...(model.details?.parameter_size
        ? { parameterCount: model.details.parameter_size }
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
      totalTokens: this.usage.totalTokens + inputTokens + outputTokens,
    };
  }

  private urlFor(pathname: string): string {
    const baseUrl = this.config.baseUrl ?? "http://localhost:11434/api";
    const normalizedBase = baseUrl.endsWith("/")
      ? baseUrl.slice(0, -1)
      : baseUrl;
    const normalizedPath = pathname.startsWith("/")
      ? pathname.slice(1)
      : pathname;

    return `${normalizedBase}/${normalizedPath}`;
  }
}

export function createOllamaProvider(
  config: OllamaProviderConfig,
): LlmProvider {
  return new OllamaProvider(config);
}
