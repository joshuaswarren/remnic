import { coerceNumber } from "./connectors/coerce.js";
import { parseBackgroundGeneration } from "./background-generation-config.js";
import type { BackgroundGenerationConfig } from "./background-generation-config.js";
import { readEnvVar } from "./runtime/env.js";

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
  /** Optional home directory override for local LLM helpers (LM Studio settings, CLI PATH). */
  localLlmHomeDir?: string;
  /** Optional absolute path to LMS CLI binary (preferred over auto-detection). */
  localLmsCliPath?: string;
  /** Optional bin directory prepended to PATH for LMS CLI execution. */
  localLmsBinDir?: string;
  /** Hard timeout for local LLM and gateway fallback requests (ms). */
  localLlmTimeoutMs: number;
  /** Max context window for local LLM (override auto-detection). Set lower if your LLM server defaults to smaller contexts. */
  localLlmMaxContext?: number;
}

export type LocalLlmParseResult = LocalLlmConfig & {
  backgroundGeneration?: BackgroundGenerationConfig;
};

function parseLocalLlmTimeoutMs(value: unknown): number {
  const coerced = coerceNumber(value);
  if (coerced === undefined) return 180_000;
  return Math.min(86_400_000, Math.max(1, Math.floor(coerced)));
}

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
  for (const key of Object.getOwnPropertyNames(value)) {
    const headerValue = Reflect.get(value, key);
    if (typeof headerValue === "string") headers[key] = headerValue;
  }
  return headers;
}

export function parseLocalLlmConfig(
  cfg: Record<string, unknown>,
  localLlmApiKeyEnv: string | undefined,
  resolveEnvVars: (value: string) => string,
): LocalLlmParseResult {
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
    localLlmFallback: cfg.localLlmFallback !== false,
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
    localLlmTimeoutMs: parseLocalLlmTimeoutMs(cfg.localLlmTimeoutMs),
    localLlmMaxContext: parseLocalLlmMaxContext(cfg.localLlmMaxContext),
  };
}
