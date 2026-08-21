import type {
  AnthropicProviderConfig,
  CompletionOpts,
  CompletionResult,
  LlmProvider,
  TokenUsage,
} from "./types.js";
import { retryFetch } from "./retry-fetch.js";

interface AnthropicMessageResponse {
  model?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

class AnthropicProvider implements LlmProvider {
  readonly provider = "anthropic" as const;
  readonly id: string;
  readonly name: string;

  private readonly config: AnthropicProviderConfig;
  private usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  constructor(config: AnthropicProviderConfig) {
    this.config = config;
    this.id = `anthropic:${config.model}`;
    this.name = config.model;
  }

  async complete(
    prompt: string,
    opts: CompletionOpts = {},
  ): Promise<CompletionResult> {
    const startedAt = performance.now();
    const response = await retryFetch(
      this.urlFor("messages"),
      {
        method: "POST",
        headers: this.headers(opts.headers),
        signal: opts.signal,
        body: JSON.stringify({
          model: this.config.model,
          system: opts.systemPrompt,
          max_tokens: opts.maxTokens ?? 1_024,
          temperature: opts.temperature,
          messages: [{ role: "user", content: prompt }],
        }),
      },
      this.config.retryOptions,
    );

    if (!response.ok) {
      throw new Error(
        `Anthropic completion failed: ${response.status} ${response.statusText}`,
      );
    }

    const payload = (await response.json()) as AnthropicMessageResponse;
    const inputTokens = payload.usage?.input_tokens ?? 0;
    const outputTokens = payload.usage?.output_tokens ?? 0;
    this.recordUsage(inputTokens, outputTokens);

    return {
      text: (payload.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("")
        .trim(),
      tokens: {
        input: inputTokens,
        output: outputTokens,
      },
      latencyMs: Math.round(performance.now() - startedAt),
      model: payload.model ?? this.config.model,
    };
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
      "anthropic-version": this.config.anthropicVersion ?? "2023-06-01",
      ...(this.config.apiKey ? { "x-api-key": this.config.apiKey } : {}),
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
    const baseUrl = this.config.baseUrl ?? "https://api.anthropic.com/v1";
    const normalizedBase = baseUrl.endsWith("/")
      ? baseUrl.slice(0, -1)
      : baseUrl;
    const normalizedPath = pathname.startsWith("/")
      ? pathname.slice(1)
      : pathname;

    return `${normalizedBase}/${normalizedPath}`;
  }
}

export function createAnthropicProvider(
  config: AnthropicProviderConfig,
): LlmProvider {
  return new AnthropicProvider(config);
}
