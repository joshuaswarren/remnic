/**
 * @remnic/server
 *
 * Standalone Remnic memory server.
 *
 * Loads config from `remnic.config.json` (or env vars), creates an Orchestrator,
 * and starts the HTTP access server with MCP endpoint — no OpenClaw required.
 *
 * Usage:
 *   npx --package @remnic/server remnic-server
 *   npx --package @remnic/server remnic-server --config ./my-remnic.json
 *   npx --package @remnic/server remnic-server --port 4320
 */

import fs from "node:fs";
import path from "node:path";
import { parseConfig, isOpenaiApiKeyDisabled, resolveRemnicConfigRecord, Orchestrator, EngramAccessService, EngramAccessHttpServer, initLogger, log, getAllValidTokens, getAllValidTokenEntriesCached, loadTokenStore, expandTildePath, type PluginConfig, type RemnicAdminControls, type RemnicAdminDashboardStatus, type RemnicAdminModelOption, type RemnicAdminConfigPatch } from "@remnic/core";
import { probeBetterSqlite3Driver } from "@remnic/core/runtime/better-sqlite";
import { applyOAuthEnvOverrides, buildOAuthRequestHandler } from "./oauth.js";
import { envOverrides, readCompatEnv } from "./server-env.js";
import {
  STARTUP_DEGRADED_AFTER_ATTEMPTS,
  abortableDelay,
  completeStartupReadiness,
  runStartupSearchWarmup,
  type StartupReadinessState,
} from "./startup-readiness.js";
import { createSupportPassportServerRuntime } from "./support-passport-runtime.js";
import { parseAdminConsoleConfig, type AdminConsoleServerFields, type ParsedAdminConsoleConfig } from "./admin-console-config.js";
export { envOverrides };
export {
  completeStartupReadiness,
  runStartupSearchWarmup,
  type StartupReadinessOutcome,
  type StartupReadinessState,
} from "./startup-readiness.js";

// ── Config loading ──────────────────────────────────────────────────────────

export interface ServerConfig {
  remnic: Record<string, unknown>;
  server: {
    host?: string;
    port?: unknown;
    authToken?: string;
    principal?: string;
    maxBodyBytes?: number;
    /** Max write requests per rolling window before 429 write_rate_limited (issue #1937). */
    writeRateLimitMaxRequests?: number;
    /** Rolling window for the write rate limit, in ms (issue #1937). */
    writeRateLimitWindowMs?: number;
    readinessOverride?: boolean;
    /**
     * Failed search warm-up attempts before the init gate opens in degraded
     * mode (issue #2215). 0 keeps the strict gate (health stays 503 until
     * warm-up completes).
     */
    readinessDegradedAfterAttempts?: unknown;
    /** OAuth authorization-server facade for ChatGPT dev-mode apps (parsed by oauth.ts). */
    oauth?: unknown;
  } & AdminConsoleServerFields;
}

function parseServerPort(value: unknown, source: string): number {
  const port = typeof value === "string" ? Number(value.trim()) : value;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error(`Invalid ${source}: expected an integer port from 1 to 65535`);
  }
  return port;
}

function parseOptionalString(value: unknown, source: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid ${source}: expected a string`);
  }
  return value;
}

function parseOptionalNonEmptyString(value: unknown, source: string): string | undefined {
  const parsed = parseOptionalString(value, source);
  if (parsed === undefined) return undefined;
  if (parsed.trim() === "") {
    throw new Error(`Invalid ${source}: expected a non-empty string`);
  }
  return parsed;
}

function parseOptionalPositiveInteger(value: unknown, source: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  if (
    typeof parsed !== "number" ||
    !Number.isInteger(parsed) ||
    parsed < 1
  ) {
    throw new Error(`Invalid ${source}: expected a positive integer`);
  }
  return parsed;
}

function parseOptionalBoolean(value: unknown, source: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  throw new Error(`Invalid ${source}: expected a boolean`);
}

function parseOptionalNonNegativeInteger(value: unknown, source: string): number | undefined {
  if (value === undefined) return undefined;
  // Reject blank strings BEFORE coercion: Number("") is 0, which would
  // silently enable the 0-means-strict-gate semantics (codex review).
  const parsed = typeof value === "string"
    ? value.trim() === "" ? Number.NaN : Number(value.trim())
    : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${source}: expected a non-negative integer`);
  }
  return parsed;
}

export interface ParsedServerConfig extends ParsedAdminConsoleConfig {
  host: string;
  port: number;
  authToken?: string;
  principal?: string;
  maxBodyBytes?: number;
  writeRateLimitMaxRequests?: number;
  writeRateLimitWindowMs?: number;
  readinessOverride: boolean;
  readinessDegradedAfterAttempts: number;
}

export function parseServerConfig(
  raw: Partial<ServerConfig["server"]>,
  options?: { portSource?: string },
): ParsedServerConfig {
  return {
    host: parseOptionalNonEmptyString(raw.host, "server.host") ?? "127.0.0.1",
    port: raw.port === undefined
      ? 4318
      : parseServerPort(raw.port, options?.portSource ?? "server.port"),
    authToken: parseOptionalString(raw.authToken, "server.authToken"),
    principal: parseOptionalString(raw.principal, "server.principal"),
    maxBodyBytes: parseOptionalPositiveInteger(raw.maxBodyBytes, "server.maxBodyBytes"),
    writeRateLimitMaxRequests: parseOptionalPositiveInteger(
      raw.writeRateLimitMaxRequests,
      "server.writeRateLimitMaxRequests",
    ),
    writeRateLimitWindowMs: parseOptionalPositiveInteger(
      raw.writeRateLimitWindowMs,
      "server.writeRateLimitWindowMs",
    ),
    ...parseAdminConsoleConfig(raw),
    readinessOverride: parseOptionalBoolean(raw.readinessOverride, "server.readinessOverride") ?? false,
    readinessDegradedAfterAttempts:
      parseOptionalNonNegativeInteger(
        raw.readinessDegradedAfterAttempts,
        "server.readinessDegradedAfterAttempts",
      ) ?? STARTUP_DEGRADED_AFTER_ATTEMPTS,
  };
}

interface ResolvedConfigPath {
  path: string;
  explicit: boolean;
  source: string;
}

function resolveUserPath(value: string): string {
  return path.resolve(expandTildePath(value));
}

function resolveConfigPath(cliPath?: string): ResolvedConfigPath {
  if (cliPath) {
    return { path: resolveUserPath(cliPath), explicit: true, source: "--config" };
  }

  const envPath = readCompatEnv("REMNIC_CONFIG_PATH", "ENGRAM_CONFIG_PATH");
  if (envPath) {
    return { path: resolveUserPath(envPath), explicit: true, source: "REMNIC_CONFIG_PATH/ENGRAM_CONFIG_PATH" };
  }

  const homeDir = process.env.HOME ?? "~";
  const candidates = [
    path.join(process.cwd(), "remnic.config.json"),
    path.join(process.cwd(), "engram.config.json"),
    path.join(homeDir, ".config", "remnic", "config.json"),
    path.join(homeDir, ".config", "engram", "config.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return { path: candidate, explicit: false, source: "auto-discovery" };
    }
  }

  return { path: path.join(homeDir, ".config", "remnic", "config.json"), explicit: false, source: "auto-discovery" };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requirePlainConfigBlock(
  raw: Record<string, unknown>,
  key: "remnic" | "engram" | "server",
  configPath: string,
): Record<string, unknown> | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    throw new Error(`Invalid config file ${configPath}: ${key} must be a JSON object`);
  }
  return value;
}

export function loadConfigFile(configPath: string): ServerConfig {
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!isPlainRecord(raw)) {
    throw new Error(`Invalid config file ${configPath}: top-level config must be a JSON object`);
  }
  requirePlainConfigBlock(raw, "remnic", configPath);
  requirePlainConfigBlock(raw, "engram", configPath);
  const server = requirePlainConfigBlock(raw, "server", configPath);
  return {
    remnic: resolveRemnicConfigRecord(raw),
    server: server ?? {},
  };
}

function loadResolvedConfig(resolved: ResolvedConfigPath): ServerConfig {
  if (!fs.existsSync(resolved.path)) {
    if (resolved.explicit) {
      throw new Error(`Config file from ${resolved.source} not found: ${resolved.path}`);
    }
    return { remnic: {}, server: {} };
  }

  const stat = fs.statSync(resolved.path);
  if (!stat.isFile()) {
    if (!resolved.explicit) {
      return { remnic: {}, server: {} };
    }
    throw new Error(`Config file from ${resolved.source} is not a regular file: ${resolved.path}`);
  }

  return loadConfigFile(resolved.path);
}
type ServerRuntimeOptions = {
  configPath?: string;
  host?: string;
  port?: number;
  authToken?: string;
};

type EffectiveServerRuntimeConfig = {
  resolvedConfigPath: ResolvedConfigPath;
  fileConfig: ServerConfig;
  envRemnic: Record<string, unknown> | undefined;
  serverConfig: Partial<ServerConfig["server"]>;
  parsedServerConfig: ParsedServerConfig;
};

function resolveEffectiveServerRuntimeConfig(
  options?: ServerRuntimeOptions,
): EffectiveServerRuntimeConfig {
  const resolvedConfigPath = resolveConfigPath(options?.configPath);
  const fileConfig = loadResolvedConfig(resolvedConfigPath);
  const { remnic: envRemnic, ...envServer } = envOverrides();
  const cliServerConfig: Partial<ServerConfig["server"]> = {};
  if (options?.host !== undefined) cliServerConfig.host = options.host;
  if (options?.port !== undefined) cliServerConfig.port = parseServerPort(options.port, "options.port");
  if (options?.authToken !== undefined) cliServerConfig.authToken = options.authToken;

  const serverConfig = {
    ...fileConfig.server,
    ...envServer,
    ...cliServerConfig,
  };
  const portSource = cliServerConfig.port !== undefined
    ? "options.port"
    : envServer.port !== undefined
      ? "REMNIC_PORT/ENGRAM_PORT"
      : "server.port";

  return {
    resolvedConfigPath,
    fileConfig,
    envRemnic,
    serverConfig,
    parsedServerConfig: parseServerConfig(serverConfig, { portSource }),
  };
}

export function mergeRemnicConfigForServer(
  fileRemnic: Record<string, unknown>,
  envRemnic: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const effectiveEnvRemnic = { ...(envRemnic ?? {}) };
  if (isOpenaiApiKeyDisabled(fileRemnic.openaiApiKey)) {
    // A local/gateway-only deployment can explicitly disable the direct
    // OpenAI client. Preserve that opt-out even when the process has a
    // global OPENAI_API_KEY for unrelated tools.
    delete effectiveEnvRemnic.openaiApiKey;
  }
  return { ...fileRemnic, ...effectiveEnvRemnic };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const WRITABLE_BOOLEAN_CONFIG_KEYS = new Set([
  "citationsAutoDetect",
  "citationsEnabled",
  "embeddingFallbackEnabled",
  "enrichmentAutoOnCreate",
  "enrichmentEnabled",
  "feedbackEnabled",
  "hostEmbeddingProviderEnabled",
  "localLlmDisableThinking",
  "localLlmEnabled",
  "localLlmFallback",
  "taskLlmFallback",
  "localLlmFastEnabled",
  "memoryExtensionsEnabled",
  "namespacesEnabled",
  "qmdEnabled",
  "queryExpansionEnabled",
  "recallPlannerEnabled",
  "recallPlannerLlmEnabled",
  "recallPlannerTelemetryEnabled",
  "rerankEnabled",
]);

const WRITABLE_STRING_CONFIG_KEYS = new Set([
  "embeddingFallbackModel",
  "embeddingFallbackProvider",
  "fastGatewayAgentId",
  "gatewayAgentId",
  "localLlmFastModel",
  "localLlmModel",
  "localLlmUrl",
  "model",
  "modelSource",
  "openaiBaseUrl",
  "qmdEmbedModel",
  "qmdGenerateModel",
  "qmdRerankModel",
  "recallPlannerModel",
]);

function isWritableConfigKey(key: string): boolean {
  return WRITABLE_BOOLEAN_CONFIG_KEYS.has(key) || WRITABLE_STRING_CONFIG_KEYS.has(key);
}

function hasEnv(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0;
}

function fileExists(candidate: string): boolean {
  try {
    return fs.existsSync(expandTildePath(candidate));
  } catch {
    return false;
  }
}

function canWriteConfigPath(configPath: string): boolean {
  try {
    if (fs.existsSync(configPath)) {
      fs.accessSync(configPath, fs.constants.W_OK);
      return true;
    }
    fs.accessSync(path.dirname(configPath), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function writeConfigFileAtomically(configPath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.tmp-${process.pid}-${Date.now()}`,
  );
  let completed = false;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(tmpPath, configPath);
    try {
      fs.chmodSync(configPath, 0o600);
    } catch {
      // Best effort for platforms/filesystems that do not support chmod.
    }
    completed = true;
  } finally {
    if (!completed) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Best effort cleanup for failed writes.
      }
    }
  }
}

function readJsonRecordIfPresent(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {};
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!isPlainRecord(parsed)) {
    throw new Error(`Invalid config file ${configPath}: top-level config must be a JSON object`);
  }
  return parsed;
}

function resolveEditableRemnicBlock(root: Record<string, unknown>): Record<string, unknown> {
  if (isPlainRecord(root.remnic)) return root.remnic;
  if (isPlainRecord(root.engram)) return root.engram;
  return root;
}

function normalizePatchValue(key: string, value: unknown): string | boolean | null {
  if (!isWritableConfigKey(key)) {
    throw new Error(`Unsupported admin config key: ${key}`);
  }
  if (value === null) return null;
  if (WRITABLE_BOOLEAN_CONFIG_KEYS.has(key)) {
    if (typeof value === "boolean") return value;
    throw new Error(`Invalid ${key}: expected boolean or null`);
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid ${key}: expected string or null`);
  }
  const normalized = value.trim();
  if (key === "modelSource" && normalized !== "plugin" && normalized !== "gateway") {
    throw new Error("Invalid modelSource: expected plugin or gateway");
  }
  if (
    key === "embeddingFallbackProvider" &&
    normalized !== "auto" &&
    normalized !== "openai" &&
    normalized !== "local"
  ) {
    throw new Error("Invalid embeddingFallbackProvider: expected auto, openai, or local");
  }
  return normalized;
}

function publicConfigValues(config: PluginConfig, serverConfig: ParsedServerConfig): Record<string, string | number | boolean | null> {
  return {
    adminConsoleEnabled: serverConfig.adminConsoleEnabled,
    reviewDeckEnabled: serverConfig.adminConsoleMemoryReviewEnabled,
    memoryDir: config.memoryDir,
    model: config.model,
    modelSource: config.modelSource,
    gatewayAgentId: config.gatewayAgentId || null,
    fastGatewayAgentId: config.fastGatewayAgentId || null,
    localLlmEnabled: config.localLlmEnabled,
    localLlmUrl: config.localLlmUrl || null,
    localLlmModel: config.localLlmModel || null,
    localLlmFastEnabled: config.localLlmFastEnabled,
    localLlmFastModel: config.localLlmFastModel || null,
    localLlmFallback: config.localLlmFallback,
    localLlmDisableThinking: config.localLlmDisableThinking,
    qmdEnabled: config.qmdEnabled,
    qmdEmbedModel: config.qmdEmbedModel || null,
    qmdRerankModel: config.qmdRerankModel || null,
    qmdGenerateModel: config.qmdGenerateModel || null,
    embeddingFallbackEnabled: config.embeddingFallbackEnabled,
    embeddingFallbackProvider: config.embeddingFallbackProvider,
    embeddingFallbackModel: config.embeddingFallbackModel || null,
    hostEmbeddingProviderEnabled: config.hostEmbeddingProviderEnabled,
    namespacesEnabled: config.namespacesEnabled,
    recallPlannerEnabled: config.recallPlannerEnabled,
    recallPlannerLlmEnabled: config.recallPlannerLlmEnabled,
    recallPlannerModel: config.recallPlannerModel || null,
    citationsEnabled: config.citationsEnabled,
    citationsAutoDetect: config.citationsAutoDetect,
    queryExpansionEnabled: config.queryExpansionEnabled,
    rerankEnabled: config.rerankEnabled,
    feedbackEnabled: config.feedbackEnabled,
    memoryExtensionsEnabled: config.memoryExtensionsEnabled,
    enrichmentEnabled: config.enrichmentEnabled,
    enrichmentAutoOnCreate: config.enrichmentAutoOnCreate,
  };
}

function configuredModels(config: PluginConfig): RemnicAdminModelOption[] {
  const models = new Map<string, RemnicAdminModelOption>();
  const add = (id: string | undefined, provider: string, label: string, enabled: boolean, isDefault = false, source = "config") => {
    const normalized = id?.trim();
    if (!normalized) return;
    const existing = models.get(`${provider}:${normalized}`);
    models.set(`${provider}:${normalized}`, {
      id: normalized,
      provider,
      label,
      detected: existing?.detected ?? true,
      enabled: existing?.enabled || enabled,
      default: existing?.default || isDefault,
      source,
    });
  };

  add(config.model, "openai", config.model, !isOpenaiApiKeyDisabled(config.openaiApiKey), config.modelSource === "plugin");
  add(config.gatewayAgentId, "gateway", config.gatewayAgentId, config.modelSource === "gateway", config.modelSource === "gateway");
  add(config.fastGatewayAgentId, "gateway", config.fastGatewayAgentId, config.modelSource === "gateway");
  add(config.localLlmModel, "local", config.localLlmModel, config.localLlmEnabled, config.localLlmEnabled);
  add(config.localLlmFastModel, "local", `${config.localLlmFastModel} (fast)`, config.localLlmFastEnabled);
  add(config.embeddingFallbackModel, config.embeddingFallbackProvider, `${config.embeddingFallbackModel} (embedding fallback)`, config.embeddingFallbackEnabled);
  add(config.qmdEmbedModel, "qmd", `${config.qmdEmbedModel} (embed)`, config.qmdEnabled);
  add(config.qmdRerankModel, "qmd", `${config.qmdRerankModel} (rerank)`, config.qmdEnabled);
  add(config.qmdGenerateModel, "qmd", `${config.qmdGenerateModel} (generate)`, config.qmdEnabled);
  add(config.recallPlannerModel, "planner", `${config.recallPlannerModel} (planner)`, config.recallPlannerLlmEnabled);

  return [...models.values()].sort((a, b) => `${a.provider}:${a.id}`.localeCompare(`${b.provider}:${b.id}`));
}

function isLikelyOllamaEndpoint(endpoint: string): boolean {
  return /(?:ollama|11434)/i.test(endpoint);
}

async function detectOllamaModels(baseUrl: string | undefined): Promise<RemnicAdminModelOption[]> {
  const configuredEndpoint = baseUrl?.trim();
  const envEndpoint = process.env.OLLAMA_HOST?.trim();
  const endpoint =
    configuredEndpoint && isLikelyOllamaEndpoint(configuredEndpoint)
      ? configuredEndpoint
      : envEndpoint;
  if (!endpoint) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 900);
  try {
    const url = new URL("/api/tags", endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return [];
    const payload = await response.json() as { models?: Array<{ name?: unknown; model?: unknown }> };
    return (payload.models ?? [])
      .map((model) => typeof model.name === "string" ? model.name : typeof model.model === "string" ? model.model : "")
      .filter((name) => name.length > 0)
      .map((name) => ({
        id: name,
        label: name,
        provider: "ollama",
        detected: true,
        enabled: true,
        source: "ollama",
        endpoint,
      }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function dashboardHarnesses(config: PluginConfig) {
  const openclawDetected = hasEnv("OPENCLAW_HOME") || hasEnv("OPENCLAW_WORKSPACE") || fileExists("~/.openclaw");
  const codexDetected = hasEnv("CODEX_HOME") || fileExists("~/.codex/auth.json") || fileExists("~/.codex");
  return [
    {
      id: "remnic-http",
      label: "Remnic HTTP API",
      detected: true,
      enabled: true,
      source: "server",
      detail: "MCP and REST access server",
    },
    {
      id: "openclaw",
      label: "OpenClaw",
      detected: openclawDetected,
      enabled: config.modelSource === "gateway" || config.hostEmbeddingProviderEnabled,
      source: openclawDetected ? "host" : "not detected",
      detail: "Gateway and host adapters",
    },
    {
      id: "codex",
      label: "Codex",
      detected: codexDetected,
      enabled: config.citationsEnabled || config.citationsAutoDetect,
      source: codexDetected ? "host" : "not detected",
      detail: "Citation-aware adapter",
    },
    {
      id: "qmd",
      label: "QMD Search",
      detected: Boolean(config.qmdPath) || config.qmdEnabled,
      enabled: config.qmdEnabled,
      source: config.qmdPath ? "qmdPath" : "config",
      detail: config.qmdSearchStrategy,
    },
  ];
}

function dashboardProviders(config: PluginConfig) {
  const localLlmUrl = config.localLlmUrl || "";
  const gatewayIds = [config.gatewayAgentId, config.fastGatewayAgentId].filter(Boolean).join(" ");
  const openaiBaseUrl = process.env.OPENAI_BASE_URL || "";
  const sageRouterDetected =
    hasEnv("SAGE_ROUTER_URL") ||
    hasEnv("SAGE_ROUTER_HOST") ||
    /sage[-_ ]?router/i.test(`${gatewayIds} ${openaiBaseUrl}`);
  const ollamaDetected = hasEnv("OLLAMA_HOST") || /(?:ollama|11434)/i.test(localLlmUrl);
  const localDetected = Boolean(localLlmUrl.trim());

  return [
    {
      id: "openai",
      label: "OpenAI",
      detected: !isOpenaiApiKeyDisabled(config.openaiApiKey),
      enabled: config.modelSource === "plugin" && !isOpenaiApiKeyDisabled(config.openaiApiKey),
      source: !isOpenaiApiKeyDisabled(config.openaiApiKey) ? "config/env" : "disabled",
      detail: config.model,
    },
    {
      id: "sage-router",
      label: "Sage Router",
      detected: sageRouterDetected,
      enabled: config.modelSource === "gateway" && sageRouterDetected,
      source: sageRouterDetected ? "gateway/env" : "not detected",
      detail: config.gatewayAgentId || config.fastGatewayAgentId || openaiBaseUrl || "OpenAI-compatible provider router",
    },
    {
      id: "ollama",
      label: "Ollama",
      detected: ollamaDetected,
      enabled: config.localLlmEnabled && ollamaDetected,
      source: ollamaDetected ? "localLlmUrl/OLLAMA_HOST" : "not detected",
      detail: "Local or cloud-compatible Ollama endpoint",
    },
    {
      id: "local-openai-compatible",
      label: "Local OpenAI-compatible",
      detected: localDetected && !ollamaDetected,
      enabled: config.localLlmEnabled && localDetected && !ollamaDetected,
      source: localDetected ? "localLlmUrl" : "not detected",
      detail: localLlmUrl || "Local provider endpoint",
    },
  ];
}

function dashboardFeatures(config: PluginConfig) {
  return [
    ["localLlmEnabled", "Local LLM", config.localLlmEnabled],
    ["localLlmFastEnabled", "Fast Local Tier", config.localLlmFastEnabled],
    ["qmdEnabled", "QMD Search", config.qmdEnabled],
    ["embeddingFallbackEnabled", "Embedding Fallback", config.embeddingFallbackEnabled],
    ["hostEmbeddingProviderEnabled", "Host Embeddings", config.hostEmbeddingProviderEnabled],
    ["namespacesEnabled", "Namespaces", config.namespacesEnabled],
    ["recallPlannerEnabled", "Recall Planner", config.recallPlannerEnabled],
    ["recallPlannerLlmEnabled", "Planner LLM", config.recallPlannerLlmEnabled],
    ["citationsEnabled", "Citations", config.citationsEnabled],
    ["citationsAutoDetect", "Citation Auto-detect", config.citationsAutoDetect],
    ["queryExpansionEnabled", "Query Expansion", config.queryExpansionEnabled],
    ["rerankEnabled", "Rerank", config.rerankEnabled],
    ["feedbackEnabled", "Feedback", config.feedbackEnabled],
    ["memoryExtensionsEnabled", "Memory Extensions", config.memoryExtensionsEnabled],
    ["enrichmentEnabled", "Entity Enrichment", config.enrichmentEnabled],
  ].map(([key, label, enabled]) => ({
    key: String(key),
    label: String(label),
    enabled: enabled === true,
    writable: WRITABLE_BOOLEAN_CONFIG_KEYS.has(String(key)),
    restartRequired: true,
  }));
}

export function createAdminControls(
  configPath: string,
  config: PluginConfig,
  serverConfig: ParsedServerConfig,
): RemnicAdminControls {
  let restartRequired = false;
  let displayConfig = config;
  const status = async (): Promise<RemnicAdminDashboardStatus> => {
    const models = configuredModels(displayConfig);
    const ollamaModels = await detectOllamaModels(displayConfig.localLlmUrl);
    const modelKeys = new Set(models.map((model) => `${model.provider}:${model.id}`));
    for (const model of ollamaModels) {
      if (!modelKeys.has(`${model.provider}:${model.id}`)) models.push(model);
    }
    return {
      config: {
        path: configPath,
        exists: fs.existsSync(configPath),
        writable: canWriteConfigPath(configPath),
        restartRequired,
        values: publicConfigValues(displayConfig, serverConfig),
      },
      harnesses: dashboardHarnesses(displayConfig),
      providers: dashboardProviders(displayConfig),
      models,
      features: dashboardFeatures(displayConfig),
    };
  };

  return {
    status,
    update: async (patch: RemnicAdminConfigPatch): Promise<RemnicAdminDashboardStatus> => {
      if (!isPlainRecord(patch)) {
        throw new Error("Admin config patch must be an object");
      }
      const normalizedEntries = Object.entries(patch).map(([key, value]) => [key, normalizePatchValue(key, value)] as const);
      if (normalizedEntries.length === 0) return status();

      const raw = readJsonRecordIfPresent(configPath);
      const target = resolveEditableRemnicBlock(raw);
      for (const [key, value] of normalizedEntries) {
        if (value === null) {
          delete target[key];
          if (target !== raw) delete raw[key];
        } else {
          target[key] = value;
        }
      }

      const nextDisplayConfig = parseConfig(resolveRemnicConfigRecord(raw));

      writeConfigFileAtomically(configPath, raw);
      displayConfig = nextDisplayConfig;
      restartRequired = true;
      return status();
    },
  };
}

async function cleanupFailedStartup(
  orchestrator: Orchestrator,
  httpServer: EngramAccessHttpServer,
): Promise<void> {
  try {
    await httpServer.stop();
  } catch (err) {
    log.warn(`HTTP startup failure cleanup could not stop server: ${err}`);
  }

  try {
    await orchestrator.destroy();
  } catch (err) {
    log.warn(`HTTP startup failure cleanup could not destroy orchestrator: ${err}`);
  }
}

// ── Server startup ──────────────────────────────────────────────────────────

export interface ServerResult {
  config: PluginConfig;
  service: EngramAccessService;
  httpServer: EngramAccessHttpServer;
  host: string;
  port: number;
  /** Stop HTTP, cancel startup work, abort deferred init, and destroy the orchestrator. */
  stop: () => Promise<void>;
  /** Cancel any pending startup-sync retry timers. Called automatically on shutdown. */
  cancelStartupSync: () => void;
  /** Abort deferred orchestrator initialization (QMD sync, warmup, cache). */
  abortDeferredInit: () => void;
}

export async function startServer(options?: ServerRuntimeOptions): Promise<ServerResult> {
  initLogger();

  // Startup driver-load check (issue #1829): attempt to load the better-sqlite3
  // native binding under THIS process. A wrong-ABI build previously threw inside
  // each projection open, was caught, and returned the same silent null as a
  // missing file — so every memory list fell back to a full-corpus scan with no
  // visible error. Probe once at startup and log LOUDLY. Do not crash: the
  // full-corpus fallback still serves, and the projection-open path records the
  // distinct rate-limited signal + doctor entry on its own.
  const driverProbe = probeBetterSqlite3Driver();
  if (!driverProbe.ok) {
    const detailSuffix = driverProbe.detail ? ` (${driverProbe.detail})` : "";
    const abiSuffix = driverProbe.nativeBindingMismatch
      ? " — the binding was built for a different Node.js ABI; rebuild it (`node scripts/ensure-better-sqlite3.mjs` or `pnpm rebuild better-sqlite3`)"
      : "";
    log.error(
      `better-sqlite3 native driver failed to load under the running process${detailSuffix}${abiSuffix}. SQLite-backed features (memory projection) will fall back to slower full-corpus scans until fixed.`,
    );
  }

  const {
    resolvedConfigPath,
    fileConfig,
    envRemnic,
    serverConfig,
    parsedServerConfig,
  } = resolveEffectiveServerRuntimeConfig(options);
  const remnicConfig = mergeRemnicConfigForServer(fileConfig.remnic, envRemnic);

  const config = parseConfig(remnicConfig);
  // Re-init now that config is known. The call at the top of startServer runs
  // BEFORE the config file is read, so it could only ever default `debug` to
  // false — `debug: true` was accepted, documented, and silently inert on the
  // standalone daemon, which is exactly the flag you reach for when the daemon
  // is misbehaving (issue #2209).
  initLogger(undefined, config.debug);
  log.debug(`debug logging enabled from config (${resolvedConfigPath.source})`);
  const orchestrator = new Orchestrator(config);
  await orchestrator.initialize();

  // Start the HTTP server immediately so health checks, MCP handshakes,
  // and liveness probes can connect while deferred init is still running.
  const readiness: StartupReadinessState = { ready: false, warmupAttempts: 0, lastError: null, degraded: false };

  const authToken = parsedServerConfig.authToken ?? readCompatEnv("REMNIC_AUTH_TOKEN", "ENGRAM_AUTH_TOKEN") ?? "";

  // Connector tokens are loaded dynamically per request via authTokensGetter
  // so that token generate/revoke takes effect without server restart
  if (!authToken && getAllValidTokens().length === 0) {
    log.warn("No auth token set — server will reject all requests. Set REMNIC_AUTH_TOKEN, server.authToken in config, or generate tokens with 'remnic token generate'.");
  }
  // OAuth facade (ChatGPT developer-mode apps): file block < REMNIC_OAUTH_* env.
  // Parsed strictly — invalid values abort startup with a precise message.
  const oauthConfig = applyOAuthEnvOverrides((serverConfig as { oauth?: unknown }).oauth);
  const oauthRequestHandler = buildOAuthRequestHandler(oauthConfig);
  const supportPassportRuntime = createSupportPassportServerRuntime(
    orchestrator, config, oauthRequestHandler,
    { reviewDeckEnabled: parsedServerConfig.adminConsoleMemoryReviewEnabled },
  ), { service } = supportPassportRuntime;
  const httpServer = new EngramAccessHttpServer({
    service,
    host: parsedServerConfig.host,
    port: parsedServerConfig.port,
    authToken: authToken || undefined,
    // Entry-based getter: validation + connector identity from ONE cached
    // snapshot (see tokens.ts). The path policy pins ChatGPT-minted OAuth
    // tokens (connector "chatgpt") to the MCP endpoint only — they never
    // authorize REST/admin routes. All other connector tokens keep full
    // access, matching pre-OAuth behavior.
    authTokenEntriesGetter: () => getAllValidTokenEntriesCached(),
    tokenPathPolicy: (connector, pathname) => connector !== "chatgpt" || pathname === "/mcp",
    readiness: () => readiness,
    principal: parsedServerConfig.principal,
    maxBodyBytes: parsedServerConfig.maxBodyBytes,
    writeRateLimitMaxRequests: parsedServerConfig.writeRateLimitMaxRequests,
    writeRateLimitWindowMs: parsedServerConfig.writeRateLimitWindowMs,
    adminConsoleEnabled: parsedServerConfig.adminConsoleEnabled,
    adminConsolePublicDir: parsedServerConfig.adminConsolePublicDir
      ? path.resolve(expandTildePath(parsedServerConfig.adminConsolePublicDir))
      : undefined,
    adminConsolePrefillToken: parsedServerConfig.adminConsolePrefillToken,
    adminControls: parsedServerConfig.adminConsoleEnabled
      ? createAdminControls(resolvedConfigPath.path, config, parsedServerConfig)
      : undefined,
    citationsEnabled: config.citationsEnabled,
    citationsAutoDetect: config.citationsAutoDetect,
    emitLegacyTools: config.emitLegacyTools,
    externalRequestHandler: supportPassportRuntime.externalRequestHandler,
    ...(oauthConfig.enabled
      ? {
          resourceMetadataUrl: new URL(
            "/.well-known/oauth-protected-resource/mcp",
            oauthConfig.issuerUrl,
          ).href,
        }
      : {}),
  });

  let host: string;
  let port: number;
  try {
    ({ host, port } = await httpServer.start());
  } catch (err) {
    await cleanupFailedStartup(orchestrator, httpServer);
    throw err;
  }

  // Fire-and-forget: wait for deferred init (QMD probe, collection setup,
  // warmup) then check QMD availability and retry if needed. This does NOT
  // block the server listener — connections are accepted immediately above.
  // An AbortController allows the shutdown handler to cancel pending retries.
  const startupSyncAbort = new AbortController();
  const readinessAbort = new AbortController();
  let startupSyncInFlight: Promise<boolean> | undefined;
  const ensureStartupSync = async (signal: AbortSignal): Promise<boolean> => {
    if (orchestrator.deferredSyncSucceeded) return true;
    if (startupSyncInFlight) return startupSyncInFlight;
    const attempt = orchestrator.startupSearchSync(signal).then((synced) => {
      if (synced) orchestrator.deferredSyncSucceeded = true;
      return synced;
    });
    startupSyncInFlight = attempt;
    try {
      return await attempt;
    } finally {
      if (startupSyncInFlight === attempt) startupSyncInFlight = undefined;
    }
  };
  const readinessTask = completeStartupReadiness({
    deferredReady: orchestrator.deferredReady,
    warmup: (signal) =>
      runStartupSearchWarmup({
        signal,
        isAvailable: () => orchestrator.qmd.isAvailable(),
        search: (onDegradation) =>
          orchestrator.qmd.search(
            "remnic startup readiness",
            config.defaultNamespace,
            1,
            undefined,
            {
              signal,
              onDegradation: (degradation) => onDegradation(degradation.code),
            },
          ),
      }),
    prepareWarmup: ensureStartupSync,
    state: readiness,
    override: parsedServerConfig.readinessOverride,
    degradedAfterAttempts: parsedServerConfig.readinessDegradedAfterAttempts,
    skipWarmup: () => orchestrator.qmd.debugStatus() === "backend=noop",
    openGate: () => {
      readiness.ready = true;
    },
    shutdownSignal: readinessAbort.signal,
  });
  // Wrap httpServer.stop() so that existing callers also get full lifecycle
  // cleanup: retry timers, deferred init, HTTP listener, and orchestrator.
  const originalStop = httpServer.stop.bind(httpServer);
  let stopPromise: Promise<void> | undefined;
  const stop = async (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      startupSyncAbort.abort();
      readinessAbort.abort();
      supportPassportRuntime.close();
      orchestrator.abortDeferredInit();
      try {
        await originalStop();
      } finally {
        try {
          await readinessTask;
        } finally {
          await orchestrator.destroy();
        }
      }
    })();
    return stopPromise;
  };
  httpServer.stop = stop;

  orchestrator.deferredReady.then(() => {
    if (startupSyncAbort.signal.aborted) {
      log.debug("QMD startup-sync: cancelled before deferred init completed");
      return;
    }

    // Skip retries when search is explicitly disabled via config or when the
    // orchestrator already resolved to a noop backend (e.g. missing collection
    // detected during deferredInitialize). Both cases mean no sync should ever
    // run; scheduling retries would create misleading operational noise and
    // unnecessary background work on every server start.
    if (!config.qmdEnabled || orchestrator.qmd.debugStatus() === "backend=noop") {
      log.debug("QMD startup-sync: search disabled or noop backend, skipping retries");
      return;
    }

    // Retry when either: (a) QMD is not available yet (cold-start race), or
    // (b) QMD is available but the deferred init sync step failed silently
    // (e.g., update errors swallowed by backend, throttle skip, transient
    // network failure). Without (b), the daemon permanently serves stale
    // recall after a failed sync despite healthy QMD probe.
    const needsRetry = !orchestrator.qmd.isAvailable() || !orchestrator.deferredSyncSucceeded;
    if (!needsRetry) {
      log.debug("QMD startup-sync: deferred init completed successfully, no retries needed");
      return;
    }

    const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];
    if (startupSyncAbort.signal.aborted) {
      log.debug("QMD startup-sync retry: cancelled before retry task started");
      return;
    }
    (async () => {
      for (const delay of RETRY_DELAYS_MS) {
        await abortableDelay(delay, startupSyncAbort.signal);

        if (startupSyncAbort.signal.aborted) {
          log.debug("QMD startup-sync retry: cancelled by shutdown");
          return;
        }

        const synced = await ensureStartupSync(startupSyncAbort.signal);
        if (!synced) {
          if (orchestrator.qmd.debugStatus() === "backend=noop") {
            log.debug("QMD startup-sync retry: search intentionally disabled; stopping retries");
            return;
          }
          log.debug(`QMD startup-sync retry: not available yet (next retry in ${RETRY_DELAYS_MS[RETRY_DELAYS_MS.indexOf(delay) + 1] ?? "n/a"}ms)`);
          continue;
        }

        return; // sync succeeded, stop retrying
      }

      log.warn("QMD startup-sync retry: exhausted all retries; search index may be stale");
    })().catch((err: unknown) => {
      log.warn(`QMD startup-sync retry: unexpected error: ${err}`);
    });
  }).catch((err: unknown) => {
    log.warn(`Deferred init error: ${err}`);
  });

  return { config, service, httpServer, host, port, stop, cancelStartupSync: () => startupSyncAbort.abort(), abortDeferredInit: () => orchestrator.abortDeferredInit() };
}

const HEALTHCHECK_TIMEOUT_MS = 5_000;
const HEALTHCHECK_PLACEHOLDER_TOKENS = new Set([
  "change-me",
  "changeme",
  "replace-me",
  "replace-this-token",
  "your-token",
  "your-token-here",
]);

function usableHealthcheckToken(value: string | undefined): string | undefined {
  const token = value?.trim();
  if (!token) return undefined;
  if (HEALTHCHECK_PLACEHOLDER_TOKENS.has(token.toLowerCase())) return undefined;
  if (/\$\{[^}]+\}|<[^>]+>/.test(token)) return undefined;
  return token;
}

function resolveHealthcheckToken(configuredToken: string | undefined): string | undefined {
  const configured = usableHealthcheckToken(configuredToken);
  if (configured) return configured;
  const entry = loadTokenStore().tokens.find(
    ({ connector, token }) => connector !== "chatgpt" && usableHealthcheckToken(token) !== undefined,
  );
  return usableHealthcheckToken(entry?.token);
}

export async function runServerHealthcheck(options?: {
  configPath?: string;
  port?: number;
  timeoutMs?: number;
}): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? HEALTHCHECK_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid timeoutMs: expected a positive integer");
  }
  const { parsedServerConfig } = resolveEffectiveServerRuntimeConfig({
    configPath: options?.configPath,
    port: options?.port,
  });
  const token = resolveHealthcheckToken(parsedServerConfig.authToken);
  if (!token) return false;

  try {
    const response = await fetch(
      `http://127.0.0.1:${parsedServerConfig.port}/engram/v1/health`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    return response.status === 200;
  } catch {
    return false;
  }
}

// ── CLI entry point ──────────────────────────────────────────────────────────

const BOOLEAN_CLI_OPTIONS = new Set(["help", "healthcheck"]);
const VALUE_CLI_OPTIONS = new Set(["config", "host", "port", "auth-token"]);

function parseCliArgs(argv: string[]): Record<string, string | undefined> {
  const args: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "-h") {
      args.help = "true";
      continue;
    }

    if (token.startsWith("--")) {
      const [key, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
      if (!key) {
        throw new Error(`Invalid option ${token}`);
      }

      if (BOOLEAN_CLI_OPTIONS.has(key)) {
        if (inlineValue !== undefined) {
          throw new Error(`Option --${key} does not accept a value`);
        }
        args[key] = "true";
        continue;
      }

      if (!VALUE_CLI_OPTIONS.has(key)) {
        throw new Error(`Unknown option --${key}`);
      }

      const value = inlineValue ?? argv[i + 1];
      if (
        value === undefined ||
        (inlineValue === undefined && value.startsWith("--")) ||
        value.trim() === ""
      ) {
        throw new Error(`Missing value for --${key}`);
      }

      args[key] = value;
      if (inlineValue === undefined) i++;
    }
  }
  return args;
}

export async function cliMain(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseCliArgs(argv);

  if (args.help) {
    console.log(`
remnic-server — Standalone Remnic memory server

Usage:
  remnic-server [options]

Options:
  --config <path>     Path to config file (default: remnic.config.json)
  --host <addr>       Bind address (default: 127.0.0.1)
  --port <number>     Port number (default: 4318)
  --auth-token <tok>  Bearer token for auth (or set REMNIC_AUTH_TOKEN)
  --healthcheck       Probe the protected health endpoint and exit
  --help              Show this help

Environment:
  REMNIC_CONFIG_PATH   Config file path (ENGRAM_CONFIG_PATH also supported)
  REMNIC_PORT          Server port (ENGRAM_PORT also supported)
  REMNIC_HOST          Bind address (ENGRAM_HOST also supported)
  REMNIC_AUTH_TOKEN    Auth bearer token (ENGRAM_AUTH_TOKEN also supported)
  REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN
                       Prefill admin UI with REMNIC_AUTH_TOKEN when true
  REMNIC_MEMORY_DIR    Override memory directory (ENGRAM_MEMORY_DIR also supported)
  OPENAI_API_KEY       OpenAI API key for extraction; ignored when config sets openaiApiKey=false
`);
    process.exit(0);
  }

  if (args.healthcheck) {
    if (args["auth-token"] !== undefined) {
      throw new Error("Option --auth-token cannot be used with --healthcheck; use config or REMNIC_AUTH_TOKEN");
    }
    if (args.host !== undefined) {
      throw new Error("Option --host cannot be used with --healthcheck; loopback probing is automatic");
    }
    const healthy = await runServerHealthcheck({
      configPath: args.config,
      port: args.port === undefined ? undefined : parseServerPort(args.port, "--port"),
    });
    if (!healthy) throw new Error("Server healthcheck failed");
    return;
  }

  const result = await startServer({
    configPath: args.config,
    host: args.host,
    port: args.port === undefined ? undefined : parseServerPort(args.port, "--port"),
    authToken: args["auth-token"],
  });

  console.log(`Remnic server listening on http://${result.host}:${result.port}`);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await result.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Auto-run when executed directly
// Matches direct execution of `node .../remnic-server/dist/index.js` or
// `node .../remnic-server/src/index.ts`. Package command names are handled by
// the bin wrappers in ../bin so importing this module cannot start twice.
if (
  process.argv[1] &&
  /(?:remnic-server|engram-server)[\\/](?:dist|src)[\\/]index\.[jt]s$/.test(process.argv[1])
) {
  cliMain().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
