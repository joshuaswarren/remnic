import { log } from "./logger.js";
import type { PluginConfig } from "./types.js";
import fs from "node:fs";
import os from "node:os";
import type { ModelRegistry } from "./model-registry.js";
import { launchProcessSync } from "./runtime/child-process.js";
import { mergeEnv, readEnvVar } from "./runtime/env.js";

/** Trim trailing slash characters without backtracking regex. */
function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === "/") end--;
  return s.substring(0, end);
}

function stripTrailingV1Path(s: string): string {
  return s.endsWith("/v1") ? s.slice(0, -3) : s;
}

function explicitPortFromUrl(s: string): number | null {
  try {
    const parsed = new URL(s);
    if (!parsed.port) return null;
    const port = Number(parsed.port);
    return Number.isInteger(port) ? port : null;
  } catch {
    return null;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLlamaCppPropsResponse(value: unknown): boolean {
  return (
    isObjectRecord(value) &&
    isObjectRecord(value.default_generation_settings) &&
    typeof value.total_slots === "number" &&
    (
      typeof value.model_path === "string" ||
      typeof value.chat_template === "string" ||
      typeof value.build_info === "string"
    )
  );
}

function isLlamaCppModelsResponse(value: unknown): boolean {
  if (!isObjectRecord(value) || !Array.isArray(value.data)) {
    return false;
  }
  return value.data.some((entry) => {
    if (!isObjectRecord(entry)) return false;
    if (entry.owned_by === "llamacpp") return true;
    if (typeof entry.id === "string" && entry.id.endsWith(".gguf")) return true;
    const meta = entry.meta;
    return (
      isObjectRecord(meta) &&
      ("n_ctx_train" in meta || "n_params" in meta || "vocab_type" in meta)
    );
  });
}

function isLmStudioApiV1ModelsResponse(value: unknown): boolean {
  if (!isObjectRecord(value) || !Array.isArray(value.models)) {
    return false;
  }
  return value.models.some((entry) => {
    if (!isObjectRecord(entry)) return false;
    return (
      typeof entry.key === "string" &&
      typeof entry.display_name === "string" &&
      (
        typeof entry.format === "string" ||
        typeof entry.max_context_length === "number" ||
        Array.isArray(entry.loaded_instances)
      )
    );
  });
}

function isLmStudioApiV0ModelsResponse(value: unknown): boolean {
  if (!isObjectRecord(value) || !Array.isArray(value.data)) {
    return false;
  }
  return value.data.some((entry) => {
    if (!isObjectRecord(entry)) return false;
    return (
      typeof entry.id === "string" &&
      typeof entry.publisher === "string" &&
      (
        typeof entry.compatibility_type === "string" ||
        typeof entry.max_context_length === "number" ||
        typeof entry.state === "string"
      )
    );
  });
}

function isLmStudioNativeModelsResponse(value: unknown): boolean {
  return isLmStudioApiV1ModelsResponse(value) || isLmStudioApiV0ModelsResponse(value);
}

/**
 * Local LLM client for OpenAI-compatible endpoints (LM Studio, Ollama, MLX, etc.)
 *
 * Based on openclaw-tactician's provider detection patterns for consistency.
 * Provides privacy-preserving, cost-effective LLM operations with
 * graceful fallback to cloud providers when local LLM is unavailable.
 */
export type LocalLlmType = "lmstudio" | "ollama" | "mlx" | "vllm" | "llamacpp" | "generic";

/**
 * Backends known to honor `chat_template_kwargs: { enable_thinking: false }`
 * on OpenAI-compatible `/v1/chat/completions`.  LM Studio, vLLM, and
 * llama.cpp forward this field to the jinja chat template, where thinking-capable
 * models (Qwen 3.5, Gemma 4, DeepSeek) suppress reasoning tokens.
 *
 * Strict OpenAI-compatible backends (standard OpenAI, Azure OpenAI, some
 * proxies) reject unknown request fields with 400 — which trips the
 * `localLlm400*` cooldown path.  `LocalLlmClient` therefore only injects
 * the kwarg when the detected backend is in this set; unknown / `generic`
 * / `ollama` / `mlx` fail open (no injection, no 400 risk).  Issue #548.
 */
const THINKING_COMPATIBLE_BACKENDS: ReadonlySet<LocalLlmType> = new Set([
  "lmstudio",
  "vllm",
  "llamacpp",
]);

const THINKING_SUPPRESSED_OPERATIONS: ReadonlySet<string> = new Set([
  "extraction",
  "extraction-judge",
  "contradiction-judge",
  "contradiction_verification",
  "link_suggestion",
  "memory_summarization",
  "proactive_extraction",
  "lcm-summarize",
  "day_summary",
  "hourly_summary",
  "hourly_summary_extended",
]);

interface LocalServerConfig {
  type: LocalLlmType;
  defaultPort: number;
  healthEndpoint: string;
  modelsEndpoint: string;
  detectFn: (response: unknown) => boolean;
}

const LOCAL_SERVERS: LocalServerConfig[] = [
  {
    type: "ollama",
    defaultPort: 11434,
    healthEndpoint: "/",
    modelsEndpoint: "/api/tags",
    detectFn: (resp) => typeof resp === "string" && resp.includes("Ollama"),
  },
  {
    type: "llamacpp",
    defaultPort: 8080,
    healthEndpoint: "/health",
    modelsEndpoint: "/v1/models",
    detectFn: (resp) => isObjectRecord(resp) && resp.status === "ok",
  },
  {
    type: "mlx",
    defaultPort: 8080,
    healthEndpoint: "/v1/models",
    modelsEndpoint: "/v1/models",
    detectFn: (resp) => isObjectRecord(resp) && Array.isArray(resp.data),
  },
  {
    type: "lmstudio",
    defaultPort: 1234,
    healthEndpoint: "/v1/models",
    modelsEndpoint: "/v1/models",
    detectFn: (resp) => isObjectRecord(resp) && Array.isArray(resp.data),
  },
  {
    type: "vllm",
    defaultPort: 8000,
    healthEndpoint: "/health",
    modelsEndpoint: "/v1/models",
    detectFn: (resp) => resp === "" || (isObjectRecord(resp) && !("status" in resp)),
  },
];

function orderedLocalServers(configuredBaseUrl: string): LocalServerConfig[] {
  const configuredPort = explicitPortFromUrl(configuredBaseUrl);
  if (configuredPort === null) return LOCAL_SERVERS;
  const matching = LOCAL_SERVERS.filter(
    (serverConfig) => serverConfig.defaultPort === configuredPort,
  );
  if (matching.length === 0) return LOCAL_SERVERS;
  const matchingTypes = new Set(matching.map((serverConfig) => serverConfig.type));
  return [
    ...matching,
    ...LOCAL_SERVERS.filter((serverConfig) => !matchingTypes.has(serverConfig.type)),
  ];
}

export interface LocalModelInfo {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
}

export type LocalLlmRequestPriority = "recall-critical" | "background";

interface LocalLlmChatCompletionOptions {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: string };
  timeoutMs?: number;
  operation?: string;
  forceDisableThinking?: boolean;
  priority?: LocalLlmRequestPriority;
}

interface LocalLlmQueuedRequest {
  messages: Array<{ role: string; content: string }>;
  options: LocalLlmChatCompletionOptions;
  priority: LocalLlmRequestPriority;
  enqueuedAtMs: number;
  resolve: (value: LocalLlmChatCompletionResult | null) => void;
}

interface LocalLlmChatCompletionResult {
  content: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

const LOCAL_LLM_GLOBAL_BACKEND_STATE = "__openclawEngramLocalLlmBackendState";

type LocalLlmBackendState = {
  untilMs: number;
  reason: string;
};
export class LocalLlmClient {
  private config: PluginConfig;
  private isAvailable: boolean | null = null;
  private lastHealthCheck: number = 0;
  private detectedType: LocalLlmType | null = null;
  private cachedModelInfo: LocalModelInfo | null = null;
  private cachedLmsContext: number | null = null;
  private lastLmsCheck: number = 0;
  private consecutive400s: number = 0;
  private cooldownUntilMs: number = 0;
  private modelRegistry?: ModelRegistry;
  private _disableThinking: boolean = false;
  private readonly requestQueues: Record<LocalLlmRequestPriority, LocalLlmQueuedRequest[]> = {
    "recall-critical": [],
    background: [],
  };
  private readonly queueProcessing = new Set<LocalLlmRequestPriority>();
  private queueDrainScheduled: boolean = false;
  private static readonly HEALTH_CHECK_INTERVAL_MS = 60000; // 1 minute
  private static readonly LMS_CACHE_INTERVAL_MS = 30000; // 30 seconds

  constructor(config: PluginConfig, modelRegistry?: ModelRegistry) {
    this.config = config;
    this.modelRegistry = modelRegistry;
  }

  /**
   * Request thinking/reasoning suppression on the next chat completion.
   *
   * When `true`, the client will inject
   * `chat_template_kwargs: { enable_thinking: false }` into the request
   * body — **but only when the detected backend is known to support it**
   * (LM Studio, vLLM; see `THINKING_COMPATIBLE_BACKENDS`).  Strict
   * OpenAI-compat backends reject unknown fields with 400; on those the
   * client fails open (thinking runs normally).  This is the safe
   * default for Remnic extraction-style operations: measurable latency
   * win on thinking-capable backends, zero risk on others. Consolidation
   * operations keep thinking enabled unless explicitly added to
   * `THINKING_SUPPRESSED_OPERATIONS`. Issues #548 and #979.
   */
  set disableThinking(value: boolean) {
    this._disableThinking = value;
  }

  private resolveHomeDir(): string {
    return this.config.localLlmHomeDir || readEnvVar("HOME") || os.homedir();
  }

  private buildRequestHeaders(base: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      ...base,
      ...(this.config.localLlmHeaders ?? {}),
    };
    if (this.config.localLlmApiKey && this.config.localLlmAuthHeader !== false) {
      headers.Authorization = `Bearer ${this.config.localLlmApiKey}`;
    }
    return headers;
  }

  private isAbortError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const maybe = err as { name?: string; message?: string };
    return (
      maybe.name === "AbortError" ||
      maybe.message === "This operation was aborted" ||
      maybe.message === "The operation was aborted"
    );
  }

  /**
   * Set the ModelRegistry for caching detected capabilities
   */
  setModelRegistry(registry: ModelRegistry): void {
    this.modelRegistry = registry;
  }

  /**
   * Get the detected server type (null if not detected)
   */
  getDetectedType(): LocalLlmType | null {
    return this.detectedType;
  }

  private getBackendKey(): string {
    return trimTrailingSlashes(
      this.config.localLlmUrl.replace("localhost", "127.0.0.1"),
    ).replace(/\/v1$/, "");
  }

  private getGlobalBackendState(): Map<string, LocalLlmBackendState> {
    const globalAny = globalThis as typeof globalThis & {
      [LOCAL_LLM_GLOBAL_BACKEND_STATE]?: Map<string, LocalLlmBackendState>;
    };
    if (!globalAny[LOCAL_LLM_GLOBAL_BACKEND_STATE]) {
      globalAny[LOCAL_LLM_GLOBAL_BACKEND_STATE] = new Map();
    }
    return globalAny[LOCAL_LLM_GLOBAL_BACKEND_STATE];
  }

  private getTrippedBackendState(now: number): LocalLlmBackendState | null {
    const state = this.getGlobalBackendState().get(this.getBackendKey()) ?? null;
    if (!state) return null;
    if (state.untilMs <= now) {
      this.getGlobalBackendState().delete(this.getBackendKey());
      this.lastHealthCheck = 0;
      return null;
    }
    return state;
  }

  private markBackendUnavailable(reason: string, durationMs: number): void {
    const normalizedReason = this.normalizeBackendTripReason(reason);
    if (durationMs > 0) {
      const untilMs = Date.now() + durationMs;
      this.getGlobalBackendState().set(this.getBackendKey(), { untilMs, reason: normalizedReason });
    } else {
      this.getGlobalBackendState().delete(this.getBackendKey());
    }
    this.isAvailable = false;
    this.lastHealthCheck = 0;
    log.warn(
      `local LLM backend unavailable for ${durationMs}ms: model=${this.config.localLlmModel} reason=${normalizedReason}`,
    );
  }

  private extractNonRecoverableBackendReason(reason: string): string | null {
    const match = reason.match(
      /Failed to load model|Library not loaded|different Team IDs|code signature|llm_engine_mlx_amphibian/i,
    );
    return match?.[0] ?? null;
  }

  private extractNonRecoverableBackendReasonFromErrorText(errorText: string): string | null {
    const directReason = this.extractNonRecoverableBackendReason(errorText);
    if (directReason) return directReason;
    try {
      const parsed = JSON.parse(errorText) as { error?: { message?: string } };
      return this.extractNonRecoverableBackendReason(parsed?.error?.message ?? "");
    } catch {
      return null;
    }
  }

  private normalizeBackendTripReason(reason: string): string {
    const cleaned = reason.replace(/\s+/g, " ").replace(/^[-:–—\s]+/, "").trim();
    if (!cleaned) return "unknown local backend failure";
    return cleaned.length > 160 ? `${cleaned.slice(0, 157)}...` : cleaned;
  }

  /**
   * Fetch with timeout for health checks
   */
  private async fetchWithTimeout(
    url: string,
    timeoutMs: number = 2000,
    headers?: Record<string, string>,
  ): Promise<{ ok: boolean; data: unknown; status: number | null }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: this.buildRequestHeaders({ Accept: "application/json", ...(headers ?? {}) }),
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return { ok: false, data: null, status: response.status };
      }

      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        return { ok: true, data: await response.json(), status: response.status };
      } else {
        return { ok: true, data: await response.text(), status: response.status };
      }
    } catch (err) {
      clearTimeout(timeout);
      return { ok: false, data: null, status: null };
    }
  }

  private async probeLmStudioNativeModels(
    probeBaseUrl: string,
  ): Promise<{ matched: boolean; unauthorized: boolean }> {
    let unauthorized = false;
    for (const endpoint of ["/api/v1/models", "/api/v0/models"]) {
      const probe = await this.fetchWithTimeout(`${probeBaseUrl}${endpoint}`);
      if (probe.ok && isLmStudioNativeModelsResponse(probe.data)) {
        return { matched: true, unauthorized };
      }
      if (probe.status === 401 || probe.status === 403) {
        unauthorized = true;
      }
    }
    return { matched: false, unauthorized };
  }

  /**
   * Check if local LLM is available
   * Uses 127.0.0.1 instead of localhost to avoid DNS issues (consistent with tactician)
   */
  async checkAvailability(): Promise<boolean> {
    // Cache health check results for 1 minute
    const now = Date.now();
    const trippedState = this.getTrippedBackendState(now);
    if (trippedState) {
      this.isAvailable = false;
      this.lastHealthCheck = 0;
      log.info(
        `local LLM availability: backend circuit open for ${Math.max(0, trippedState.untilMs - now)}ms (${trippedState.reason})`,
      );
      return false;
    }
    if (this.isAvailable !== null && now - this.lastHealthCheck < LocalLlmClient.HEALTH_CHECK_INTERVAL_MS) {
      return this.isAvailable;
    }

    // Normalize URL - replace localhost with 127.0.0.1, remove trailing slashes.
    // Probe server-native endpoints from the server root even when users configure
    // the OpenAI-compatible `/v1` base URL for chat completions.
    const configuredBaseUrl = trimTrailingSlashes(
      this.config.localLlmUrl.replace("localhost", "127.0.0.1"),
    );
    const probeBaseUrl = stripTrailingV1Path(configuredBaseUrl);
    let sawUnauthorizedProbe = false;

    // Try to detect which server type is running
    for (const serverConfig of orderedLocalServers(configuredBaseUrl)) {
      const healthUrl = `${probeBaseUrl}${serverConfig.healthEndpoint}`;
      log.debug(`checking ${serverConfig.type} at ${healthUrl}`);

      const result = await this.fetchWithTimeout(healthUrl);
      if (result.ok && serverConfig.detectFn(result.data)) {
        if (serverConfig.type === "mlx") {
          const lmStudioProbe = await this.probeLmStudioNativeModels(probeBaseUrl);
          if (lmStudioProbe.unauthorized) {
            sawUnauthorizedProbe = true;
          }
          if (lmStudioProbe.matched) {
            this.isAvailable = true;
            this.detectedType = "lmstudio";
            this.lastHealthCheck = now;
            log.info(`detected lmstudio at ${configuredBaseUrl}`);
            return true;
          }
        }
        if (serverConfig.type === "llamacpp") {
          let sawLlamaCppSignal = false;
          const propsProbe = await this.fetchWithTimeout(`${probeBaseUrl}/props`);
          if (propsProbe.ok && isLlamaCppPropsResponse(propsProbe.data)) {
            sawLlamaCppSignal = true;
          }
          if (propsProbe.status === 401 || propsProbe.status === 403) {
            sawUnauthorizedProbe = true;
          }

          const modelsUrl = `${probeBaseUrl}${serverConfig.modelsEndpoint}`;
          const modelsProbe = await this.fetchWithTimeout(modelsUrl);
          if (modelsProbe.ok && isLlamaCppModelsResponse(modelsProbe.data)) {
            sawLlamaCppSignal = true;
          }
          if (modelsProbe.status === 401 || modelsProbe.status === 403) {
            sawUnauthorizedProbe = true;
            continue;
          }

          const authConfigured =
            Boolean(this.config.localLlmApiKey) &&
            this.config.localLlmAuthHeader !== false;
          if (!sawLlamaCppSignal || (authConfigured && !modelsProbe.ok)) {
            continue;
          }
        }
        this.isAvailable = true;
        this.detectedType = serverConfig.type;
        this.lastHealthCheck = now;
        log.info(`detected ${serverConfig.type} at ${configuredBaseUrl}`);
        return true;
      }
      if (result.status === 401 || result.status === 403) {
        sawUnauthorizedProbe = true;
      }
    }

    // Generic check if specific detection failed
    try {
      const modelsUrl = `${probeBaseUrl}/v1/models`;
      const result = await this.fetchWithTimeout(modelsUrl);
      if (result.ok) {
        this.isAvailable = true;
        this.detectedType = "generic";
        this.lastHealthCheck = now;
        log.info(`detected generic OpenAI-compatible server at ${configuredBaseUrl}`);
        return true;
      }
      if (result.status === 401 || result.status === 403) {
        sawUnauthorizedProbe = true;
      }
    } catch {
      // Fall through to unavailable
    }

    this.isAvailable = false;
    this.detectedType = null;
    this.lastHealthCheck = now;
    if (sawUnauthorizedProbe) {
      log.warn(
        `local LLM availability probe was unauthorized at ${configuredBaseUrl}; verify localLlmApiKey and localLlmAuthHeader settings`,
      );
    }
    log.debug("local LLM not available at", configuredBaseUrl);
    return false;
  }

  /**
   * Try to get context window from LM Studio settings.json as fallback.
   * This reads the defaultContextLength setting which is what LM Studio uses
   * when loading models without explicit context configuration.
   */
  private getContextFromLmStudioSettings(): number | null {
    try {
      const homeDir = this.resolveHomeDir();
      const settingsPath = `${homeDir}/.cache/lm-studio/settings.json`;

      if (!fs.existsSync(settingsPath)) {
        log.debug(`LM Studio settings: file not found at ${settingsPath}`);
        return null;
      }

      const content = fs.readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(content) as {
        defaultContextLength?: {
          type?: string;
          value?: number;
        };
      };

      if (settings.defaultContextLength?.value) {
        const contextWindow = settings.defaultContextLength.value;
        log.debug(`LM Studio settings: found default context length: ${contextWindow}`);
        return contextWindow;
      }

      return null;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.debug(`LM Studio settings: failed to read - ${errorMsg}`);
      return null;
    }
  }

  /**
   * Try to get context window from LMS CLI (LM Studio specific).
   * Uses --json flag for reliable parsing.
   * Returns null if LMS CLI is not available or model not found.
   */
  private getContextFromLmsCli(modelId: string): number | null {
    try {
      // Check if lms CLI exists in common locations.
      // HOME may be absent in launchd environments, so prefer the resolved helper.
      const homeDir = this.resolveHomeDir();
      const lmsPaths = [
        this.config.localLmsCliPath || "",
        `${homeDir}/.cache/lm-studio/bin/lms`,
        "/usr/local/bin/lms",
        "/opt/homebrew/bin/lms",
      ];

      const lmsPath = lmsPaths.find((p) => p.length > 0 && fs.existsSync(p));
      if (!lmsPath) {
        log.debug(`LMS CLI: not found in standard locations (checked: ${lmsPaths.join(", ")})`);
        return null;
      }

      // Run lms ps --json to get loaded models with context
      // Use spawnSync with shell and explicit PATH to ensure lms can find its dependencies
      log.debug(`LMS CLI: running: ${lmsPath} ps --json`);
      const existingPath = readEnvVar("PATH") || "";
      const result = launchProcessSync(lmsPath, ["ps", "--json"], {
        encoding: "utf-8",
        timeout: 5000,
        shell: false, // Don't use shell for JSON output - more reliable
        env: mergeEnv({
          PATH: `${this.config.localLmsBinDir || `${homeDir}/.cache/lm-studio/bin`}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${existingPath}`,
          HOME: homeDir,
        }),
      });

      if (result.error) {
        log.debug(`LMS CLI: spawn error - ${result.error.message}`);
        return null;
      }

      if (result.stderr && result.stderr.trim()) {
        log.debug(`LMS CLI: stderr - ${result.stderr.slice(0, 200)}`);
      }

      const output = result.stdout || "";
      if (!output.trim()) {
        log.debug("LMS CLI: empty output - LM Studio may not be running or no models loaded");
        return null;
      }

      // Parse JSON output
      let models: Array<{
        identifier?: string;
        modelKey?: string;
        contextLength?: number;
        maxContextLength?: number;
      }>;

      try {
        models = JSON.parse(output) as typeof models;
      } catch (parseErr) {
        log.debug(`LMS CLI: JSON parse error - ${parseErr}`);
        return null;
      }

      if (!Array.isArray(models) || models.length === 0) {
        log.debug("LMS CLI: no models loaded");
        return null;
      }

      // Find the model matching our configured model ID
      const model = models.find((m) =>
        m.identifier === modelId ||
        m.modelKey === modelId ||
        (m.identifier?.includes(modelId.replace(/@\d+bit$/, "")))
      );

      if (!model) {
        log.debug(`LMS CLI: model "${modelId}" not found in loaded models: ${models.map(m => m.identifier).join(", ")}`);
        return null;
      }

      // Use contextLength (actual configured) or fall back to maxContextLength (model max)
      const contextWindow = model.contextLength || model.maxContextLength;

      if (contextWindow) {
        log.info(`LMS CLI detected context window: ${contextWindow} for ${modelId} (max: ${model.maxContextLength})`);
        return contextWindow;
      }

      return null;
    } catch (err) {
      // LMS CLI not available or failed
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.debug(`LMS CLI: failed - ${errorMsg}`);
      return null;
    }
  }

  /**
   * Get full model info from LMS CLI including context length and max context length.
   * Returns null if LMS CLI is unavailable or model not found.
   */
  private getLmsModelInfo(modelId: string): { contextLength: number; maxContextLength: number; identifier: string } | null {
    try {
      const result = launchProcessSync("lms", ["ps", "--json"], {
        encoding: "utf-8",
        timeout: 5000,
        shell: false,
      });

      if (result.error) {
        return null;
      }

      const output = result.stdout || "";
      if (!output.trim()) {
        return null;
      }

      let models: Array<{
        identifier?: string;
        modelKey?: string;
        contextLength?: number;
        maxContextLength?: number;
      }>;

      try {
        models = JSON.parse(output) as typeof models;
      } catch {
        return null;
      }

      if (!Array.isArray(models) || models.length === 0) {
        return null;
      }

      const model = models.find((m) =>
        m.identifier === modelId ||
        m.modelKey === modelId ||
        (m.identifier?.includes(modelId.replace(/@\d+bit$/, "")))
      );

      if (!model || !model.contextLength) {
        return null;
      }

      return {
        contextLength: model.contextLength,
        maxContextLength: model.maxContextLength || model.contextLength,
        identifier: model.identifier || modelId,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get context window for the configured model, using cache if available.
   * This method caches the result to avoid repeated LMS CLI calls.
   * Order: ModelRegistry (persistent) -> memory cache -> LMS CLI -> settings.json
   */
  getCachedContextWindow(modelId: string): number | null {
    const now = Date.now();

    // 1. Check ModelRegistry for persisted context window
    if (this.modelRegistry) {
      const caps = this.modelRegistry.getCapabilities(modelId);
      if (caps.source === "lmstudio" && caps.contextWindow) {
        log.debug(`ModelRegistry: using persisted LM Studio context: ${caps.contextWindow}`);
        // Also update memory cache
        this.cachedLmsContext = caps.contextWindow;
        this.lastLmsCheck = now;
        return caps.contextWindow;
      }
    }

    // 2. Return in-memory cached value if still valid
    if (this.cachedLmsContext && now - this.lastLmsCheck < LocalLlmClient.LMS_CACHE_INTERVAL_MS) {
      log.debug(`LMS CLI: returning in-memory cached context: ${this.cachedLmsContext}`);
      return this.cachedLmsContext;
    }

    // 3. Try LMS CLI (authoritative source)
    const lmsInfo = this.getLmsModelInfo(modelId);
    if (lmsInfo?.contextLength) {
      this.cachedLmsContext = lmsInfo.contextLength;
      this.lastLmsCheck = now;
      // Calculate appropriate output tokens based on context size
      // Use 12.5% of context window, capped at 16K (generous but safe)
      const calculatedOutputTokens = Math.min(Math.floor(lmsInfo.contextLength / 8), 16384);
      const outputTokens = Math.max(calculatedOutputTokens, 4096); // Minimum 4K
      // Persist to ModelRegistry with detected capabilities
      if (this.modelRegistry) {
        this.modelRegistry.setCapabilities(modelId, {
          maxPositionEmbeddings: lmsInfo.maxContextLength || lmsInfo.contextLength,
          contextWindow: lmsInfo.contextLength,
          supportsExtendedContext: (lmsInfo.maxContextLength || lmsInfo.contextLength) > 65536,
          typicalOutputTokens: outputTokens,
          source: "lmstudio",
        });
        log.info(`LMS CLI: Stored capabilities for ${modelId}: ${lmsInfo.contextLength} context, ${outputTokens} output tokens`);
      }
      return lmsInfo.contextLength;
    }

    // Legacy: Try LMS CLI context only (fallback)
    const legacyContext = this.getContextFromLmsCli(modelId);
    if (legacyContext) {
      this.cachedLmsContext = legacyContext;
      this.lastLmsCheck = now;
      // Persist to ModelRegistry with calculated output tokens
      if (this.modelRegistry) {
        const calculatedOutputTokens = Math.min(Math.floor(legacyContext / 8), 16384);
        const outputTokens = Math.max(calculatedOutputTokens, 4096);
        this.modelRegistry.setCapabilities(modelId, {
          maxPositionEmbeddings: legacyContext,
          contextWindow: legacyContext,
          supportsExtendedContext: false,
          typicalOutputTokens: outputTokens,
          source: "lmstudio",
        });
      }
      return legacyContext;
    }

    // 4. Fall back to LM Studio settings.json
    const settingsContext = this.getContextFromLmStudioSettings();
    if (settingsContext) {
      log.info(`LM Studio settings: using default context: ${settingsContext}`);
      this.cachedLmsContext = settingsContext;
      this.lastLmsCheck = now;
      return settingsContext;
    }

    return null;
  }

  /**
   * Clear the LMS context cache. Call this when the model changes.
   */
  clearContextCache(): void {
    this.cachedLmsContext = null;
    this.lastLmsCheck = 0;
    log.debug("LMS CLI: context cache cleared");
  }

  private remainingCooldownMs(now: number = Date.now()): number {
    return Math.max(0, this.cooldownUntilMs - now);
  }

  private scheduleQueueDrain(): void {
    if (this.queueDrainScheduled) return;
    this.queueDrainScheduled = true;

    queueMicrotask(() => {
      this.queueDrainScheduled = false;
      this.startAvailableQueuedRequests();
    });
  }

  private hasQueuedRequests(): boolean {
    return (
      this.requestQueues["recall-critical"].length > 0 ||
      this.requestQueues.background.length > 0
    );
  }

  private dequeueQueuedRequest(priority: LocalLlmRequestPriority): LocalLlmQueuedRequest | null {
    const next = this.requestQueues[priority].shift();
    return next ?? null;
  }

  private failOpenQueuedRequestsForCooldown(): number {
    let dropped = 0;
    for (const priority of ["recall-critical", "background"] as const) {
      while (this.requestQueues[priority].length > 0) {
        const queued = this.requestQueues[priority].shift();
        queued?.resolve(null);
        dropped += 1;
      }
    }
    return dropped;
  }

  private startAvailableQueuedRequests(): void {
    if (!this.queueProcessing.has("recall-critical")) {
      const nextCritical = this.dequeueQueuedRequest("recall-critical");
      if (nextCritical) {
        this.queueProcessing.add("recall-critical");
        void this.runQueuedRequest(nextCritical);
      }
    }

    if (!this.queueProcessing.has("background")) {
      const nextBackground = this.dequeueQueuedRequest("background");
      if (nextBackground) {
        this.queueProcessing.add("background");
        void this.runQueuedRequest(nextBackground);
      }
    }
  }

  private async runQueuedRequest(next: LocalLlmQueuedRequest): Promise<void> {
    try {
      const remainingCooldownMs = this.remainingCooldownMs();
      if (remainingCooldownMs > 0) {
        const additionalDropped = this.failOpenQueuedRequestsForCooldown();
        log.warn(
          `local LLM: cooldown active (${remainingCooldownMs}ms remaining), dropping ${additionalDropped + 1} queued request(s) fail-open`,
        );
        next.resolve(null);
        return;
      }

      let result: LocalLlmChatCompletionResult | null = null;
      try {
        result = await this.runChatCompletionRequest(next.messages, next.options, {
          priority: next.priority,
          enqueuedAtMs: next.enqueuedAtMs,
        });
      } catch (err) {
        log.warn(`local LLM queue drain failed open: ${err instanceof Error ? err.message : String(err)}`);
      }
      next.resolve(result);
    } finally {
      this.queueProcessing.delete(next.priority);
      if (this.hasQueuedRequests()) {
        this.scheduleQueueDrain();
      }
    }
  }

  private async runChatCompletionRequest(
    messages: Array<{ role: string; content: string }>,
    options: LocalLlmChatCompletionOptions,
    queueMeta?: { priority: LocalLlmRequestPriority; enqueuedAtMs: number },
  ): Promise<LocalLlmChatCompletionResult | null> {
    log.debug(
      `local LLM chatCompletion: localLlmEnabled=${this.config.localLlmEnabled}, model=${this.config.localLlmModel}`,
    );

    const operation = options.operation ?? "unspecified";
    const startedAtMs = Date.now();
    if (queueMeta) {
        log.debug(
          `local LLM queue start: priority=${queueMeta.priority} waitMs=${startedAtMs - queueMeta.enqueuedAtMs} op=${operation}`,
        );
    }

    try {
      const isAvailable = await this.checkAvailability();
      if (!isAvailable) {
        log.debug(
          `local LLM: checkAvailability returned false for ${this.config.localLlmUrl}`,
        );
        return null;
      }

      const promptChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
      const requestBody: Record<string, unknown> = {
        model: this.config.localLlmModel,
        messages,
        temperature: options.temperature ?? 0.7,
        // Use max_tokens consistent with cloud models
        max_tokens: options.maxTokens ?? 4096,
      };

      // Skip response_format for local LLMs - they don't support json_object type
      // The prompts already instruct the model to output JSON
      // Only send if it's json_schema type which some local LLMs support
      if (options.responseFormat?.type === "json_schema") {
        requestBody.response_format = options.responseFormat;
      }

      // Suppress thinking/reasoning for operations that benefit from terse,
      // structured output. Thinking-capable models (Qwen 3.5, Gemma 4,
      // DeepSeek) default to thinking-on via their chat template; sending
      // `chat_template_kwargs: { enable_thinking: false }` tells the template
      // to skip reasoning tokens. Consolidation operations on the main client
      // intentionally keep thinking enabled so entity resolution and
      // deduplication can use the model's reasoning path. Fast-tier callers can
      // still force suppression per request to preserve their low-latency
      // contract.
      //
      // Gate the injection on detected backend support (issue #548,
      // Codex P1 on PR #550): `chat_template_kwargs` is an LM Studio /
      // vLLM / llama.cpp extension, not part of standard OpenAI chat
      // completions.  Strict OpenAI-compatible backends reject
      // unknown fields with 400, which trips the 400-cooldown path and
      // can effectively disable local extraction.  Fail open when the
      // backend hasn't been positively identified as thinking-capable.
      const shouldSuppressThinking =
        options.forceDisableThinking === true ||
        (this._disableThinking &&
          THINKING_SUPPRESSED_OPERATIONS.has(operation));
      if (
        shouldSuppressThinking &&
        this.detectedType !== null &&
        THINKING_COMPATIBLE_BACKENDS.has(this.detectedType)
      ) {
        requestBody.chat_template_kwargs = { enable_thinking: false };
      }

      // Normalize URL (use 127.0.0.1 instead of localhost)
      const baseUrl = trimTrailingSlashes(
        this.config.localLlmUrl.replace("localhost", "127.0.0.1"),
      );
      const chatUrl = baseUrl.endsWith("/v1")
        ? `${baseUrl}/chat/completions`
        : `${baseUrl}/v1/chat/completions`;

      const requestBodyJson = JSON.stringify(requestBody);
      log.debug(
        `local LLM: sending request to ${chatUrl} with model ${this.config.localLlmModel}`,
      );
      // Avoid logging request bodies by default (can contain sensitive user content).
      log.debug(`local LLM: request body length=${requestBodyJson.length}`);

      // Write request body to file for debugging
      if (this.config.debug) {
        try {
          const { writeFileSync } = await import("node:fs");
          writeFileSync("/tmp/engram-last-request.json", requestBodyJson);
        } catch {
          /* ignore */
        }
      }

      const effectiveTimeoutMs =
        typeof options.timeoutMs === "number"
          ? Math.min(this.config.localLlmTimeoutMs, options.timeoutMs)
          : this.config.localLlmTimeoutMs;
      const maxAttempts = 1 + Math.max(0, this.config.localLlmRetry5xxCount);
      let response: Response | null = null;
      let lastAbortError: Error | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const attemptAbort = new AbortController();
        const attemptTimeout = setTimeout(() => attemptAbort.abort(), effectiveTimeoutMs);
        try {
          response = await fetch(chatUrl, {
            method: "POST",
            headers: this.buildRequestHeaders({
              "Content-Type": "application/json",
            }),
            body: JSON.stringify(requestBody),
            signal: attemptAbort.signal,
          });
        } catch (err) {
          if (!this.isAbortError(err)) throw err;
          lastAbortError = err instanceof Error ? err : new Error(String(err));
          if (attempt < maxAttempts) {
            const backoffMs = this.config.localLlmRetryBackoffMs * attempt;
            log.warn(
              `local LLM request aborted: op=${operation} attempt=${attempt}/${maxAttempts} timeoutMs=${effectiveTimeoutMs} model=${this.config.localLlmModel}; retrying after ${backoffMs}ms`,
            );
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue;
          }
          break;
        } finally {
          clearTimeout(attemptTimeout);
        }

        if (response.ok) break;
        if (response.status >= 500 && attempt < maxAttempts) {
          try {
            const errorText = await response.clone().text();
            const nonRecoverableReason =
              this.extractNonRecoverableBackendReasonFromErrorText(errorText);
            if (nonRecoverableReason) {
              this.markBackendUnavailable(
                nonRecoverableReason,
                this.config.localLlm400CooldownMs,
              );
              this.consecutive400s = 0;
              return null;
            }
          } catch (e) {
            log.debug(`local LLM failed to inspect retryable error body: ${e}`);
          }
        }
        if (response.status < 500 || attempt >= maxAttempts) break;

        const backoffMs = this.config.localLlmRetryBackoffMs * attempt;
        log.warn(
          `local LLM request got ${response.status}; retrying (attempt ${attempt + 1}/${maxAttempts}) after ${backoffMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
      log.debug(
        `local LLM: received response, status=${response?.status}, ok=${response?.ok}`,
      );

      if (!response) {
        if (lastAbortError) {
          log.warn(
            `local LLM request aborted after ${maxAttempts} attempt(s): op=${operation} timeoutMs=${effectiveTimeoutMs} model=${this.config.localLlmModel} promptChars=${promptChars} durationMs=${Date.now() - startedAtMs}`,
          );
        } else {
          log.warn(
            `local LLM request failed: no response object (op=${operation} model=${this.config.localLlmModel} durationMs=${Date.now() - startedAtMs})`,
          );
        }
        return null;
      }

      if (!response.ok) {
        let reason = "";
        let errorText = "";
        try {
          errorText = await response.text();
          // Try to extract a stable error message without logging content.
          try {
            const parsed = JSON.parse(errorText) as { error?: { message?: string } };
            reason = parsed?.error?.message ? ` — ${parsed.error.message}` : "";
          } catch {
            // Keep a short preview in debug only.
            log.debug(`local LLM error body: ${errorText.slice(0, 500)}`);
          }
        } catch (e) {
          log.debug(`local LLM failed to read error body: ${e}`);
        }
        log.warn(
          `local LLM request failed: ${response.status} ${response.statusText}${reason} ` +
          `(op=${operation}, model=${this.config.localLlmModel}, url=${chatUrl}, promptChars=${promptChars}, maxTokens=${requestBody.max_tokens as number})`,
        );
        const nonRecoverableReason =
          this.extractNonRecoverableBackendReason(reason) ??
          this.extractNonRecoverableBackendReasonFromErrorText(errorText);
        if (nonRecoverableReason) {
          this.markBackendUnavailable(
            nonRecoverableReason,
            this.config.localLlm400CooldownMs,
          );
          this.consecutive400s = 0;
          return null;
        }
        if (response.status === 400) {
          this.consecutive400s += 1;
          if (this.consecutive400s >= this.config.localLlm400TripThreshold) {
            this.cooldownUntilMs = Date.now() + this.config.localLlm400CooldownMs;
            log.warn(
              `local LLM: entering cooldown for ${this.config.localLlm400CooldownMs}ms ` +
                `after ${this.consecutive400s} consecutive 400 responses`,
            );
            this.consecutive400s = 0;
          }
        } else {
          this.consecutive400s = 0;
        }
        return null;
      }
      this.consecutive400s = 0;

      const data = (await response.json()) as {
        choices?: Array<{
          message?: { content?: string; reasoning_content?: string };
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };

      log.debug(
        `local LLM response: choices=${data.choices?.length}, usage=${JSON.stringify(data.usage)}`,
      );

      // Thinking models (e.g. Qwen 3.5) may put their response in
      // `reasoning_content` and leave `content` empty. Fall back to
      // reasoning_content so engram still gets a usable result.
      const msg = data.choices?.[0]?.message;
      const content = msg?.content || msg?.reasoning_content || "";
      if (!content) {
        log.warn(`local LLM returned empty content. choices=${JSON.stringify(data.choices)?.slice(0, 200)}`);
        return null;
      }

      // Estimate tokens if not provided by local LLM
      const usage = data.usage
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
            totalTokens: data.usage.total_tokens ?? 0,
          }
        : this.estimateTokens(messages, content);

      const durationMs = Date.now() - startedAtMs;
      if (this.config.slowLogEnabled && durationMs >= this.config.slowLogThresholdMs) {
        const promptChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
        const op = options.operation ? ` op=${options.operation}` : "";
        log.warn(
          `SLOW local LLM:${op} durationMs=${durationMs} model=${this.config.localLlmModel} url=${chatUrl} promptChars=${promptChars} outputTokens=${usage.completionTokens} totalTokens=${usage.totalTokens}`,
        );
      }

      log.debug("local LLM: request succeeded, tokens:", usage.totalTokens);
      return { content, usage };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startedAtMs;
      if (this.isAbortError(err)) {
        log.warn(
          `local LLM request aborted: op=${operation} timeoutMs=${options.timeoutMs ?? this.config.localLlmTimeoutMs} model=${this.config.localLlmModel} durationMs=${durationMs} error=${errMsg}`,
        );
        return null;
      }
      log.warn(`local LLM request error: op=${operation} error=${errMsg}`);
      this.isAvailable = false; // Mark as unavailable on non-abort errors
      const nonRecoverableReason = this.extractNonRecoverableBackendReason(errMsg);
      if (nonRecoverableReason) {
        this.markBackendUnavailable(
          nonRecoverableReason,
          this.config.localLlm400CooldownMs,
        );
      }
      return null;
    } finally {
      if (queueMeta) {
        const finishedAtMs = Date.now();
        const waitMs = startedAtMs - queueMeta.enqueuedAtMs;
        log.debug(
          `local LLM queue finish: priority=${queueMeta.priority} waitMs=${waitMs} runMs=${finishedAtMs - startedAtMs} totalMs=${finishedAtMs - queueMeta.enqueuedAtMs} op=${operation}`,
        );
      }
    }
  }

  /**
   * Query the local LLM server for loaded model information.
   * Returns null if unavailable or if the model is not found.
   */
  async getLoadedModelInfo(): Promise<LocalModelInfo | null> {
    const baseUrl = trimTrailingSlashes(
      this.config.localLlmUrl.replace("localhost", "127.0.0.1"),
    );

    // Handle URL construction - localLlmUrl may already include /v1
    const modelsUrl = baseUrl.endsWith("/v1")
      ? `${baseUrl}/models`
      : `${baseUrl}/v1/models`;
    log.debug(`Fetching model info from ${modelsUrl}`);

    try {
      const result = await this.fetchWithTimeout(modelsUrl, 3000);
      if (!result.ok) {
        if (result.status === 401 || result.status === 403) {
          log.warn(
            `Local LLM: unauthorized while fetching models from ${modelsUrl}; verify localLlmApiKey and localLlmAuthHeader settings`,
          );
        }
        log.warn(`Local LLM: Failed to fetch models from ${modelsUrl} - server returned error`);
        return null;
      }
      if (!result.data) {
        log.warn(`Local LLM: No data returned from ${modelsUrl}`);
        return null;
      }

      const data = result.data as {
        data?: Array<{
          id?: string;
          object?: string;
          owned_by?: string;
          // LM Studio specific fields
          max_context_length?: number;
          max_tokens?: number;
          // Ollama specific
          name?: string;
          details?: {
            parameter_size?: string;
            family?: string;
          };
        }>;
      };

      if (!Array.isArray(data.data) || data.data.length === 0) {
        log.warn("Local LLM returned no models");
        return null;
      }

      // Verbose model listings are noisy on every gateway restart. Keep it debug-only.
      const modelIds = data.data.map((m) => m.id).filter(Boolean);
      log.debug(
        `Local LLM: Found ${modelIds.length} model(s). First 10: ${modelIds.slice(0, 10).join(", ")}`,
      );

      // Find the model matching our configured model ID
      const configuredModel = this.config.localLlmModel;
      let model = data.data.find((m) => m.id === configuredModel);

      // If not found by exact match, try partial match (handle suffixes like @4bit)
      if (!model) {
        model = data.data.find((m) =>
          configuredModel.includes(m.id || "") ||
          (m.id || "").includes(configuredModel.replace(/@\d+bit$/, ""))
        );
      }

      // If still not found, use the first loaded model and warn
      if (!model) {
        model = data.data[0];
        const availablePreview = data.data
          .map((m) => m.id)
          .filter(Boolean)
          .slice(0, 10)
          .join(", ");
        log.warn(
          `Configured model "${configuredModel}" not found in local LLM. ` +
          `Using "${model.id}" instead. Available (first 10): ${availablePreview}`
        );
      }

      // Extract context window - try multiple field names
      let contextWindow = model.max_context_length || model.max_tokens;

      // If API doesn't report context window, try LMS CLI (LM Studio specific)
      if (!contextWindow) {
        log.info("Local LLM: API did not report context window, trying LMS CLI...");
        const lmsContext = this.getCachedContextWindow(model.id || "");
        if (lmsContext) {
          contextWindow = lmsContext;
        }
      }

      this.cachedModelInfo = {
        id: model.id || "unknown",
        contextWindow: contextWindow,
        maxTokens: model.max_tokens,
      };

      log.info(
        `Local LLM model detected: ${this.cachedModelInfo.id}, ` +
        `context window: ${contextWindow?.toLocaleString() || "unknown (may use default)"}`
      );

      return this.cachedModelInfo;
    } catch (err) {
      log.warn(`Failed to fetch model info: ${err}`);
      return null;
    }
  }

  /**
   * Check if the configured model is available and get its actual context window.
   * Warns if there's a mismatch between expected and actual context.
   */
  async validateModelConfig(expectedContextWindow?: number): Promise<{
    available: boolean;
    actualContextWindow?: number;
    warnings: string[];
  }> {
    const warnings: string[] = [];

    const modelInfo = await this.getLoadedModelInfo();
    if (!modelInfo) {
      return { available: false, warnings: ["Could not query local LLM for model info"] };
    }

    // If we have expected context and the server reports one, check for mismatch
    if (expectedContextWindow && modelInfo.contextWindow) {
      if (modelInfo.contextWindow < expectedContextWindow) {
        warnings.push(
          `Context window mismatch: Model ${modelInfo.id} supports ${modelInfo.contextWindow.toLocaleString()} tokens, ` +
          `but engram is configured for ${expectedContextWindow.toLocaleString()}. ` +
          `Set localLlmMaxContext: ${modelInfo.contextWindow} in config to avoid errors.`
        );
      }
    }

    // Warn if server doesn't report context window (common with some local LLM setups)
    if (!modelInfo.contextWindow) {
      warnings.push(
        `Local LLM server did not report context window for ${modelInfo.id}. ` +
        `If you get "context length exceeded" errors, set localLlmMaxContext in config.`
      );
    }

    return {
      available: true,
      actualContextWindow: modelInfo.contextWindow,
      warnings,
    };
  }

  /**
   * Make a chat completion request to local LLM
   */
  async chatCompletion(
    messages: Array<{ role: string; content: string }>,
    options: LocalLlmChatCompletionOptions = {},
  ): Promise<LocalLlmChatCompletionResult | null> {
    if (!this.config.localLlmEnabled) {
      log.debug("local LLM: disabled, returning null");
      return null;
    }

    const remainingMs = this.remainingCooldownMs();
    if (remainingMs > 0) {
      log.debug(`local LLM: cooldown active (${remainingMs}ms remaining), skipping request`);
      return null;
    }
    if (options.priority) {
      const priority = options.priority;
      return await new Promise<LocalLlmChatCompletionResult | null>((resolve) => {
        this.requestQueues[priority].push({
          messages,
          options,
          priority,
          enqueuedAtMs: Date.now(),
          resolve,
        });
        this.scheduleQueueDrain();
      });
    }

    return await this.runChatCompletionRequest(messages, options);
  }

  /**
   * Estimate tokens when local LLM doesn't return usage stats
   * Rough estimate: 1 token ≈ 4 characters
   */
  private estimateTokens(
    messages: Array<{ role: string; content: string }>,
    response: string
  ): { promptTokens: number; completionTokens: number; totalTokens: number } {
    const promptChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const promptTokens = Math.ceil(promptChars / 4);
    const completionTokens = Math.ceil(response.length / 4);

    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }

  /**
   * Try local LLM first, fallback to cloud provider if configured
   */
  async withFallback<T>(
    localOperation: () => Promise<T | null>,
    fallbackOperation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    // Try local LLM first if enabled
    if (this.config.localLlmEnabled) {
      const localResult = await localOperation();
      if (localResult !== null) {
        log.debug(`${operationName}: used local LLM`);
        return localResult;
      }

      // Local failed or unavailable
      if (this.config.localLlmFallback) {
        log.info(`${operationName}: local LLM unavailable, falling back to cloud`);
      } else {
        throw new Error(`${operationName}: local LLM unavailable and fallback disabled`);
      }
    }

    // Use fallback (cloud provider)
    return fallbackOperation();
  }
}
