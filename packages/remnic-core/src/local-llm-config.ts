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
