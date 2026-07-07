import type { CodexCliReasoningEffort } from "./types.js";

export interface CodexCliFallbackMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CodexCliFallbackConfig {
  apiKey?: string | Record<string, unknown>;
  executable?: unknown;
  codexCliExecutable?: unknown;
  reasoningEffort?: unknown;
  codexCliReasoningEffort?: unknown;
  retryOptions?: {
    timeoutMs?: unknown;
  };
}

export interface CodexCliFallbackOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CodexCliFallbackResult {
  content: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export interface CodexCliFallbackRequest {
  config: CodexCliFallbackConfig;
  modelId: string;
  messages: CodexCliFallbackMessage[];
  options: CodexCliFallbackOptions;
}

export type CodexCliFallbackRunner = (
  request: CodexCliFallbackRequest,
) => Promise<CodexCliFallbackResult>;

const VALID_CODEX_CLI_REASONING_EFFORTS = new Set<CodexCliReasoningEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
]);

let processRunner: CodexCliFallbackRunner | undefined;

/**
 * Registers the process-local Codex CLI transport. Core deliberately does not
 * import child_process so host adapters such as OpenClaw do not ship shell
 * execution in their plugin bundle; benchmark/standalone runtimes opt in.
 */
export function setCodexCliFallbackRunnerForProcess(
  runner: CodexCliFallbackRunner | undefined,
): () => void {
  const previous = processRunner;
  processRunner = runner;
  return () => {
    processRunner = previous;
  };
}

export async function callCodexCliFallback(
  config: CodexCliFallbackConfig,
  modelId: string,
  messages: CodexCliFallbackMessage[],
  options: CodexCliFallbackOptions = {},
): Promise<CodexCliFallbackResult> {
  if (!processRunner) {
    throw new Error(
      'codex-cli fallback transport is not registered; install a runner with setCodexCliFallbackRunnerForProcess() before using api: "codex-cli"',
    );
  }

  return await processRunner({
    config: normalizeCodexCliFallbackConfig(config),
    modelId: normalizeCodexCliModel(modelId),
    messages,
    options: normalizeCodexCliFallbackOptions(options),
  });
}

function normalizeCodexCliFallbackConfig(
  config: CodexCliFallbackConfig,
): CodexCliFallbackConfig {
  return {
    ...config,
    ...(config.executable !== undefined
      ? { executable: normalizeOptionalString(config.executable, "codex-cli executable") }
      : {}),
    ...(config.codexCliExecutable !== undefined
      ? { codexCliExecutable: normalizeOptionalString(config.codexCliExecutable, "codex-cli executable") }
      : {}),
    ...(config.reasoningEffort !== undefined
      ? { reasoningEffort: normalizeCodexCliReasoningEffort(config.reasoningEffort) }
      : {}),
    ...(config.codexCliReasoningEffort !== undefined
      ? { codexCliReasoningEffort: normalizeCodexCliReasoningEffort(config.codexCliReasoningEffort) }
      : {}),
    ...(config.retryOptions?.timeoutMs !== undefined
      ? { retryOptions: { timeoutMs: normalizeCodexCliTimeoutMs(config.retryOptions.timeoutMs) } }
      : {}),
  };
}

function normalizeCodexCliFallbackOptions(
  options: CodexCliFallbackOptions,
): CodexCliFallbackOptions {
  return {
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: normalizeCodexCliTimeoutMs(options.timeoutMs) }
      : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

function normalizeOptionalString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeCodexCliModel(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("codex-cli model must be a non-empty string");
  }
  return trimmed;
}

function normalizeCodexCliReasoningEffort(value: unknown): CodexCliReasoningEffort {
  if (typeof value !== "string") {
    throw new Error("codex-cli reasoningEffort must be one of low, medium, high, xhigh");
  }
  const normalized = value.trim().toLowerCase();
  if (VALID_CODEX_CLI_REASONING_EFFORTS.has(normalized as CodexCliReasoningEffort)) {
    return normalized as CodexCliReasoningEffort;
  }
  throw new Error("codex-cli reasoningEffort must be one of low, medium, high, xhigh");
}

function normalizeCodexCliTimeoutMs(value: unknown): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("codex-cli timeoutMs must be a positive integer");
  }
  return parsed;
}

export const __codexCliFallbackTestHooks = {
  setRunCodexCliForTest: setCodexCliFallbackRunnerForProcess,
};

export interface ClaudeCliFallbackMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// Claude CLI fallback (issue #1728): mirrors the Codex CLI inversion pattern.
// The internal-provider path (`--internal-provider claude-cli`) routes through
// fallback-llm.ts -> callClaudeCliFallback -> this registered runner, which the
// bench runtime wires to the claude-cli provider transport.
// ---------------------------------------------------------------------------

export interface ClaudeCliFallbackConfig {
  apiKey?: string | Record<string, unknown>;
  baseUrl?: unknown;
  executable?: unknown;
  claudeCliExecutable?: unknown;
  reasoningEffort?: unknown;
  claudeCliReasoningEffort?: unknown;
  retryOptions?: {
    timeoutMs?: unknown;
  };
}

export interface ClaudeCliFallbackOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ClaudeCliFallbackResult {
  content: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export interface ClaudeCliFallbackRequest {
  config: ClaudeCliFallbackConfig;
  modelId: string;
  messages: ClaudeCliFallbackMessage[];
  options: ClaudeCliFallbackOptions;
}

export type ClaudeCliFallbackRunner = (
  request: ClaudeCliFallbackRequest,
) => Promise<ClaudeCliFallbackResult>;

let claudeProcessRunner: ClaudeCliFallbackRunner | undefined;

/**
 * Registers the process-local Claude CLI transport. Same inversion rationale
 * as the Codex runner: core does not import child_process so host adapters do
 * not ship shell execution; benchmark/standalone runtimes opt in.
 */
export function setClaudeCliFallbackRunnerForProcess(
  runner: ClaudeCliFallbackRunner | undefined,
): () => void {
  const previous = claudeProcessRunner;
  claudeProcessRunner = runner;
  return () => {
    claudeProcessRunner = previous;
  };
}

export async function callClaudeCliFallback(
  config: ClaudeCliFallbackConfig,
  modelId: string,
  messages: ClaudeCliFallbackMessage[],
  options: ClaudeCliFallbackOptions = {},
): Promise<ClaudeCliFallbackResult> {
  if (!claudeProcessRunner) {
    throw new Error(
      'claude-cli fallback transport is not registered; install a runner with setClaudeCliFallbackRunnerForProcess() before using api: "claude-cli"',
    );
  }

  return await claudeProcessRunner({
    config: normalizeClaudeCliFallbackConfig(config),
    modelId: normalizeClaudeCliModel(modelId),
    messages,
    options: normalizeClaudeCliFallbackOptions(options),
  });
}

function normalizeClaudeCliFallbackConfig(
  config: ClaudeCliFallbackConfig,
): ClaudeCliFallbackConfig {
  return {
    ...config,
    ...(config.executable !== undefined
      ? { executable: normalizeOptionalString(config.executable, "claude-cli executable") }
      : {}),
    ...(config.baseUrl !== undefined
      ? { baseUrl: normalizeOptionalString(config.baseUrl, "claude-cli baseUrl") }
      : {}),
    ...(config.claudeCliExecutable !== undefined
      ? { claudeCliExecutable: normalizeOptionalString(config.claudeCliExecutable, "claude-cli executable") }
      : {}),
    ...(config.reasoningEffort !== undefined
      ? { reasoningEffort: normalizeClaudeCliReasoningEffort(config.reasoningEffort) }
      : {}),
    ...(config.claudeCliReasoningEffort !== undefined
      ? { claudeCliReasoningEffort: normalizeClaudeCliReasoningEffort(config.claudeCliReasoningEffort) }
      : {}),
    ...(config.retryOptions?.timeoutMs !== undefined
      ? { retryOptions: { timeoutMs: normalizeClaudeCliTimeoutMs(config.retryOptions.timeoutMs) } }
      : {}),
  };
}

function normalizeClaudeCliFallbackOptions(
  options: ClaudeCliFallbackOptions,
): ClaudeCliFallbackOptions {
  return {
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: normalizeClaudeCliTimeoutMs(options.timeoutMs) }
      : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

function normalizeClaudeCliModel(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("claude-cli model must be a non-empty string");
  }
  return trimmed;
}

function normalizeClaudeCliReasoningEffort(value: unknown): CodexCliReasoningEffort {
  if (typeof value !== "string") {
    throw new Error("claude-cli reasoningEffort must be one of low, medium, high, xhigh");
  }
  const normalized = value.trim().toLowerCase();
  if (VALID_CODEX_CLI_REASONING_EFFORTS.has(normalized as CodexCliReasoningEffort)) {
    return normalized as CodexCliReasoningEffort;
  }
  throw new Error("claude-cli reasoningEffort must be one of low, medium, high, xhigh");
}

function normalizeClaudeCliTimeoutMs(value: unknown): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("claude-cli timeoutMs must be a positive integer");
  }
  return parsed;
}

export const __claudeCliFallbackTestHooks = {
  setRunClaudeCliForTest: setClaudeCliFallbackRunnerForProcess,
};

