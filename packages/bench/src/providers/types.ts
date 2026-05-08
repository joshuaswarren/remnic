/**
 * Minimal LLM provider contract for the bench engine.
 */

import type {
  BenchReasoningEffort,
  BuiltInProvider,
} from "../types.js";

export interface CompletionOpts {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  tokens: { input: number; output: number };
  latencyMs: number;
  model: string;
}

export interface DiscoveredModel {
  id: string;
  name: string;
  contextLength: number;
  capabilities: ("completion" | "embedding" | "vision")[];
  quantization?: string;
  parameterCount?: string;
}

export interface ProviderBaseConfig {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  retryOptions?: { maxAttempts?: number; baseBackoffMs?: number; timeoutMs?: number; max429WaitMs?: number };
  /** Suppress thinking/reasoning tokens for thinking-capable models (Qwen 3.5, Gemma 4, DeepSeek). */
  disableThinking?: boolean;
}

export interface OpenAiCompatibleProviderConfig extends ProviderBaseConfig {
  provider?: "openai" | "litellm";
}

export interface AnthropicProviderConfig extends ProviderBaseConfig {
  provider?: "anthropic";
  anthropicVersion?: string;
}

export interface OllamaProviderConfig extends ProviderBaseConfig {
  provider?: "ollama";
}

/**
 * `local-llm` targets a user-hosted OpenAI-compatible endpoint
 * (llama.cpp, vLLM, LM Studio, etc.). `baseUrl` is required at the
 * CLI layer — it mirrors the plugin's `localLlmUrl` config and is
 * what tells the bench which local server to talk to. The transport
 * is intentionally OpenAI-compatible: `/v1/chat/completions` +
 * `/v1/models`. Issue #566 slice 5.
 */
export interface LocalLlmProviderConfig extends ProviderBaseConfig {
  provider?: "local-llm";
  baseUrl: string;
}

export interface CodexCliProviderConfig extends ProviderBaseConfig {
  provider?: "codex-cli";
  /** Codex CLI model reasoning effort. Bench CLI defaults this to xhigh. */
  reasoningEffort?: BenchReasoningEffort;
  /** Optional executable override for tests or non-standard Codex CLI installs. */
  executable?: string;
  /**
   * Optional diagnostics artifact directory. When set, the provider writes
   * per-call metadata that helps debug slow benchmark completions without
   * depending on transient temp workspaces.
   */
  diagnosticsDir?: string;
  /**
   * `metadata` stores hashes/counts only. `full` additionally stores the full
   * benchmark prompt and should only be used for isolated benchmark datasets.
   */
  diagnosticsMode?: "metadata" | "full";
}

export type ProviderFactoryConfig =
  | (OpenAiCompatibleProviderConfig & { provider: "openai" | "litellm" })
  | (AnthropicProviderConfig & { provider: "anthropic" })
  | (OllamaProviderConfig & { provider: "ollama" })
  | (LocalLlmProviderConfig & { provider: "local-llm" })
  | (CodexCliProviderConfig & { provider: "codex-cli" });

export interface ProviderDiscoveryResult {
  provider: BuiltInProvider;
  models: DiscoveredModel[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface LlmProvider {
  id: string;
  name: string;
  provider: BuiltInProvider;
  complete(prompt: string, opts?: CompletionOpts): Promise<CompletionResult>;
  embed?(texts: string[]): Promise<number[][]>;
  discover?(): Promise<DiscoveredModel[]>;
  getUsage(): TokenUsage;
  resetUsage(): void;
}
