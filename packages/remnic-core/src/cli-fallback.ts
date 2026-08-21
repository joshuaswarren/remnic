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
