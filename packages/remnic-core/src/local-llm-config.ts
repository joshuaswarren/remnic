import { coerceNumber } from "./connectors/coerce.js";
import { parseBackgroundGeneration } from "./background-generation-config.js";
import type { BackgroundGenerationConfig } from "./background-generation-config.js";
import { readEnvVar } from "./runtime/env.js";
import { parseTaskLlmConfig } from "./task-llm-config.js";
export interface LocalLlmConfig {
  // Local LLM Provider (v2.1)
  localLlmEnabled: boolean;
  localLlmUrl: string;
  localLlmModel: string;
  /** Optional API key for authenticated OpenAI-compatible endpoints. */
  localLlmApiKey?: string;
  /** Optional environment-variable name that supplies localLlmApiKey at runtime. */
  localLlmApiKeyEnv?: string;
  /** Additional headers for local/compatible endpoint requests. */
  localLlmHeaders?: Record<string, string>;
  /** If false, do not send Authorization header even when localLlmApiKey is set. */
  localLlmAuthHeader: boolean;
  localLlmFallback: boolean;
  taskLlmFallback?: boolean;
  /** Optional home directory override for local LLM helpers (LM Studio settings, CLI PATH). */
  localLlmHomeDir?: string;
  /** Optional absolute path to LMS CLI binary (preferred over auto-detection). */
  localLmsCliPath?: string;
  /** Optional bin directory prepended to PATH for LMS CLI execution. */
  localLmsBinDir?: string;
  /** Hard timeout for local LLM requests (ms). Legacy alias for the task-chain timeout when `taskLlmTimeoutMs` is absent. */
  localLlmTimeoutMs: number;
  /** Timeout for the gateway/task LLM chain (ms). */
  taskLlmTimeoutMs?: number;
  /** Max context window for local LLM (override auto-detection). Set lower if your LLM server defaults to smaller contexts. */
  localLlmMaxContext?: number;
}

export type LocalLlmParseResult = LocalLlmConfig & {
  backgroundGeneration?: BackgroundGenerationConfig;
};


function parseLocalLlmMaxContext(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const coerced = coerceNumber(value);
  if (
    coerced === undefined ||
    !Number.isFinite(coerced) ||
    !Number.isInteger(coerced) ||
    coerced < 1024
  ) {
    throw new Error(
      `localLlmMaxContext must be an integer greater than or equal to 1024; got ${JSON.stringify(value)}`,
    );
  }
  return coerced;
}

function copyStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue === "string") headers[key] = headerValue;
  }
  return headers;
}

export function parseLocalLlmConfig(
  cfg: Record<string, unknown>,
  localLlmApiKeyEnv: string | undefined,
  resolveEnvVars: (value: string) => string,
): LocalLlmParseResult {
  const taskLlm = parseTaskLlmConfig(cfg);
  return {
    backgroundGeneration: parseBackgroundGeneration(cfg, resolveEnvVars),
    localLlmEnabled: cfg.localLlmEnabled === true || cfg.localLlmEnabled === "true",
    localLlmUrl:
      typeof cfg.localLlmUrl === "string" && cfg.localLlmUrl.length > 0
        ? cfg.localLlmUrl
        : "http://localhost:1234/v1",
    localLlmModel:
      typeof cfg.localLlmModel === "string" && cfg.localLlmModel.length > 0
        ? cfg.localLlmModel
        : "local-model",
    localLlmApiKey:
      typeof cfg.localLlmApiKey === "string" && cfg.localLlmApiKey.length > 0
        ? resolveEnvVars(cfg.localLlmApiKey)
        : localLlmApiKeyEnv === undefined
          ? undefined
          : readEnvVar(localLlmApiKeyEnv),
    localLlmApiKeyEnv,
    localLlmHeaders: copyStringRecord(cfg.localLlmHeaders),
    localLlmAuthHeader: cfg.localLlmAuthHeader !== false,
    localLlmFallback: taskLlm.fallback,
    taskLlmFallback: taskLlm.fallback,
    localLlmHomeDir:
      typeof cfg.localLlmHomeDir === "string" && cfg.localLlmHomeDir.length > 0
        ? cfg.localLlmHomeDir
        : undefined,
    localLmsCliPath:
      typeof cfg.localLmsCliPath === "string" && cfg.localLmsCliPath.length > 0
        ? cfg.localLmsCliPath
        : undefined,
    localLmsBinDir:
      typeof cfg.localLmsBinDir === "string" && cfg.localLmsBinDir.length > 0
        ? cfg.localLmsBinDir
        : undefined,
    localLlmTimeoutMs: taskLlm.localTimeoutMs,
    taskLlmTimeoutMs: taskLlm.timeoutMs,
    localLlmMaxContext: parseLocalLlmMaxContext(cfg.localLlmMaxContext),
  };
}
