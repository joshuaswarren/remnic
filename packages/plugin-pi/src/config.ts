import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { expandTildePath } from "@remnic/core";

import { REMNIC_PI_EXTENSION_DIR_NAME, resolvePiAgentHome } from "./paths.js";

export interface RemnicPiConfig {
  remnicDaemonUrl: string;
  authToken?: string;
  namespace?: string;
  recallMode: "auto" | "minimal" | "full" | "graph_mode" | "no_recall";
  recallTopK: number;
  recallBudgetChars: number;
  recallEnabled: boolean;
  observeEnabled: boolean;
  observeSkipExtraction: boolean;
  compactionEnabled: boolean;
  mcpToolsEnabled: boolean;
  statusEnabled: boolean;
  requestTimeoutMs: number;
}

export interface LoadConfigOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_CONFIG: RemnicPiConfig = {
  remnicDaemonUrl: "http://127.0.0.1:4318",
  recallMode: "auto",
  recallTopK: 8,
  recallBudgetChars: 12000,
  recallEnabled: true,
  observeEnabled: true,
  observeSkipExtraction: false,
  compactionEnabled: true,
  mcpToolsEnabled: true,
  statusEnabled: true,
  requestTimeoutMs: 5000,
};

function defaultConfigPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolvePiAgentHome(env), "extensions", REMNIC_PI_EXTENSION_DIR_NAME, "remnic.config.json");
}

function coerceBoolean(value: unknown, fallback: boolean, fieldName: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  throw new Error(`Invalid boolean value for Remnic Pi config field ${fieldName}`);
}

function coercePositiveInt(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function normalizeRecallMode(value: unknown): RemnicPiConfig["recallMode"] {
  return value === "minimal" ||
    value === "full" ||
    value === "graph_mode" ||
    value === "no_recall" ||
    value === "auto"
    ? value
    : "auto";
}

function readConfigFile(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error("expected a JSON object");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load Remnic Pi config at ${configPath}: ${reason}`);
  }
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

export function resolveConfigPath(options: LoadConfigOptions = {}): string {
  const env = options.env ?? process.env;
  return expandTildePath(options.configPath || env.REMNIC_PI_CONFIG || defaultConfigPath(env));
}

export function loadConfig(options: LoadConfigOptions = {}): RemnicPiConfig {
  const env = options.env ?? process.env;
  const fileConfig = readConfigFile(resolveConfigPath(options));
  const daemonUrl =
    typeof fileConfig.remnicDaemonUrl === "string" && fileConfig.remnicDaemonUrl.trim().length > 0
      ? fileConfig.remnicDaemonUrl.trim()
      : typeof env.REMNIC_DAEMON_URL === "string" && env.REMNIC_DAEMON_URL.trim().length > 0
        ? env.REMNIC_DAEMON_URL.trim()
        : DEFAULT_CONFIG.remnicDaemonUrl;
  const authToken =
    typeof fileConfig.authToken === "string" && fileConfig.authToken.trim().length > 0
      ? fileConfig.authToken.trim()
      : typeof env.REMNIC_PI_AUTH_TOKEN === "string" && env.REMNIC_PI_AUTH_TOKEN.trim().length > 0
        ? env.REMNIC_PI_AUTH_TOKEN.trim()
        : undefined;
  const namespace =
    typeof fileConfig.namespace === "string" && fileConfig.namespace.trim().length > 0
      ? fileConfig.namespace.trim()
      : undefined;

  return {
    remnicDaemonUrl: trimTrailingSlashes(daemonUrl),
    authToken,
    namespace,
    recallMode: normalizeRecallMode(fileConfig.recallMode),
    recallTopK: coercePositiveInt(fileConfig.recallTopK, DEFAULT_CONFIG.recallTopK, 50),
    recallBudgetChars: coercePositiveInt(fileConfig.recallBudgetChars, DEFAULT_CONFIG.recallBudgetChars, 64000),
    recallEnabled: coerceBoolean(fileConfig.recallEnabled, DEFAULT_CONFIG.recallEnabled, "recallEnabled"),
    observeEnabled: coerceBoolean(fileConfig.observeEnabled, DEFAULT_CONFIG.observeEnabled, "observeEnabled"),
    observeSkipExtraction: coerceBoolean(fileConfig.observeSkipExtraction, DEFAULT_CONFIG.observeSkipExtraction, "observeSkipExtraction"),
    compactionEnabled: coerceBoolean(fileConfig.compactionEnabled, DEFAULT_CONFIG.compactionEnabled, "compactionEnabled"),
    mcpToolsEnabled: coerceBoolean(fileConfig.mcpToolsEnabled, DEFAULT_CONFIG.mcpToolsEnabled, "mcpToolsEnabled"),
    statusEnabled: coerceBoolean(fileConfig.statusEnabled, DEFAULT_CONFIG.statusEnabled, "statusEnabled"),
    requestTimeoutMs: coercePositiveInt(fileConfig.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs, 60_000),
  };
}
