/**
 * Local-LLM bench provider — issue #566 slice 5.
 *
 * Talks to a user-hosted OpenAI-compatible endpoint (llama.cpp,
 * vLLM, LM Studio, etc.) using the exact same wire contract
 * (`/v1/chat/completions` + `/v1/models`) that the Remnic core
 * `LocalLlmClient` uses. The goal is transport-level parity:
 * anything `remnic bench published --provider local-llm` can reach
 * is something the running plugin can also reach.
 *
 * Why this is a distinct provider from `openai`:
 *
 *   - The OpenAI-compatible provider treats `baseUrl` as optional
 *     and defaults to `https://api.openai.com/v1`. That default is
 *     wrong for local servers, and silently falling through to it
 *     violates CLAUDE.md rule 51 (reject invalid user input).
 *   - `local-llm` REQUIRES `baseUrl` at the CLI boundary so the
 *     user must explicitly point at their server. A missing
 *     base URL is a user error, not a default.
 *   - Discovery for `local-llm` is reserved for the future — the
 *     built-in `discoverAllProviders` probe does not assume a
 *     local-llm URL is reachable. Users opt in with `--base-url`.
 *
 * See `packages/remnic-core/src/summarizer.ts` for the core-side
 * `LocalLlmClient` invocation pattern and
 * `packages/plugin-openclaw/openclaw.plugin.json` for the
 * `localLlmUrl` / `localLlmModel` config that this provider
 * mirrors.
 */

import type {
  CompletionOpts,
  CompletionResult,
  DiscoveredModel,
  LlmProvider,
  LocalLlmProviderConfig,
  TokenUsage,
} from "./types.js";
import { isThinkingCompatibleBackend } from "./openai-compatible.js";
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

class LocalLlmProvider implements LlmProvider {
  readonly provider = "local-llm" as const;
  readonly id: string;
  readonly name: string;

  private readonly config: LocalLlmProviderConfig;
  private usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  constructor(config: LocalLlmProviderConfig) {
    if (!config.baseUrl || config.baseUrl.trim().length === 0) {
      // CLAUDE.md rule 51: reject invalid input at the boundary with
      // a concrete hint rather than silently defaulting to OpenAI.
      throw new Error(
        "local-llm provider requires --base-url (e.g. http://localhost:8080/v1). " +
          "Valid examples: llama.cpp (http://localhost:8080/v1), " +
          "vLLM (http://localhost:8000/v1), LM Studio (http://localhost:1234/v1).",
      );
    }
    this.config = config;
    this.id = `local-llm:${config.model}`;
    this.name = config.model;
  }

  async complete(
    prompt: string,
    opts: CompletionOpts = {},
  ): Promise<CompletionResult> {
    const startedAt = performance.now();
    let response: Response;
    try {
      response = await retryFetch(
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
            isThinkingCompatibleBackend(this.normalizedBaseUrl())
              ? { chat_template_kwargs: { enable_thinking: false } }
              : {}),
          }),
        },
        this.config.retryOptions,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `local-llm completion failed: ${msg} (base-url=${this.config.baseUrl}, model=${this.config.model})`,
      );
    }

    if (!response.ok) {
      const errorBody = await readErrorBody(response);
      throw new Error(
        `local-llm completion failed: ${response.status} ${response.statusText}${errorBody ? ` — ${errorBody}` : ""} ` +
          `(base-url=${this.config.baseUrl}, model=${this.config.model})`,
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
    let response: Response;
    try {
      response = await retryFetch(
        this.urlFor("models"),
        {
          method: "GET",
          headers: this.headers(),
        },
        this.config.retryOptions,
      );
    } catch (err) {
      throw new Error(
        `local-llm model discovery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `local-llm model discovery failed: ${response.status} ${response.statusText}`,
      );
    }

    const payload = (await response.json()) as ModelsResponse;
    return (payload.data ?? []).map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      contextLength: model.context_length ?? 0,
      capabilities: model.capabilities ?? ["completion"],
      ...(model.quantization ? { quantization: model.quantization } : {}),
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

  private headers(
    extraHeaders: Record<string, string> = {},
  ): Record<string, string> {
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
    const normalizedBase = this.normalizedBaseUrl();
    const normalizedPath = pathname.startsWith("/")
      ? pathname.slice(1)
      : pathname;
    return `${normalizedBase}/${normalizedPath}`;
  }

  private normalizedBaseUrl(): string {
    // Codex P1 on PR #613: if the user passed a bare host like
    // `http://localhost:8080` (no `/v1`), concatenating
    // `chat/completions` would 404 on every OpenAI-compatible server
    // that only exposes `/v1/*`. Tolerate both forms so `--base-url`
    // behaves the same as the plugin's `localLlmUrl`.
    const stripped = this.config.baseUrl.endsWith("/")
      ? this.config.baseUrl.slice(0, -1)
      : this.config.baseUrl;
    const hasV1Suffix = /\/v\d+$/.test(stripped);
    return hasV1Suffix ? stripped : `${stripped}/v1`;
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

export function createLocalLlmProvider(
  config: LocalLlmProviderConfig,
): LlmProvider {
  return new LocalLlmProvider(config);
}
