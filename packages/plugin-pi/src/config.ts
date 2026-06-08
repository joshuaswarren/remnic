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
  startupRequestTimeoutMs: number;
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
  requestTimeoutMs: 60000,
  startupRequestTimeoutMs: 1000,
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

function coercePositiveInt(value: unknown, fallback: number, max: number, fieldName: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return fallback;
    if (!/^[+-]?\d+$/.test(trimmed)) {
      throw new Error(`Invalid numeric value for Remnic Pi config field ${fieldName}: expected an integer from 1 to ${max}`);
    }
    parsed = Number(trimmed);
  } else {
    throw new Error(`Invalid numeric value for Remnic Pi config field ${fieldName}: expected an integer from 1 to ${max}`);
  }
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`Invalid numeric value for Remnic Pi config field ${fieldName}: expected an integer from 1 to ${max}`);
  }
  return parsed;
}

function coerceOptionalNonEmptyString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  throw new Error(`Invalid string value for Remnic Pi config field ${fieldName}`);
}

function coerceOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  throw new Error(`Invalid string value for Remnic Pi config field ${fieldName}`);
}

function coerceOptionalHttpUrl(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid URL value for Remnic Pi config field ${fieldName}: expected an http or https URL`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return trimTrailingSlashes(trimmed);
  } catch {
    // Fall through to the shared error below.
  }
  throw new Error(`Invalid URL value for Remnic Pi config field ${fieldName}: expected an http or https URL`);
}

function coerceRecallMode(value: unknown): RemnicPiConfig["recallMode"] {
  if (value === undefined || value === null || value === "") return DEFAULT_CONFIG.recallMode;
  if (
    value === "minimal" ||
    value === "full" ||
    value === "graph_mode" ||
    value === "no_recall" ||
    value === "auto"
  ) {
    return value;
  }
  throw new Error(`Invalid recallMode value for Remnic Pi config: ${JSON.stringify(value)}`);
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
    coerceOptionalHttpUrl(fileConfig.remnicDaemonUrl, "remnicDaemonUrl") ??
    coerceOptionalHttpUrl(env.REMNIC_DAEMON_URL, "REMNIC_DAEMON_URL") ??
    DEFAULT_CONFIG.remnicDaemonUrl;
  const authToken =
    coerceOptionalString(fileConfig.authToken, "authToken") ??
    coerceOptionalString(env.REMNIC_PI_AUTH_TOKEN, "REMNIC_PI_AUTH_TOKEN");
  const namespace = coerceOptionalNonEmptyString(fileConfig.namespace, "namespace");

  return {
    remnicDaemonUrl: daemonUrl,
    authToken,
    namespace,
    recallMode: coerceRecallMode(fileConfig.recallMode),
    recallTopK: coercePositiveInt(fileConfig.recallTopK, DEFAULT_CONFIG.recallTopK, 50, "recallTopK"),
    recallBudgetChars: coercePositiveInt(fileConfig.recallBudgetChars, DEFAULT_CONFIG.recallBudgetChars, 64000, "recallBudgetChars"),
    recallEnabled: coerceBoolean(fileConfig.recallEnabled, DEFAULT_CONFIG.recallEnabled, "recallEnabled"),
    observeEnabled: coerceBoolean(fileConfig.observeEnabled, DEFAULT_CONFIG.observeEnabled, "observeEnabled"),
    observeSkipExtraction: coerceBoolean(fileConfig.observeSkipExtraction, DEFAULT_CONFIG.observeSkipExtraction, "observeSkipExtraction"),
    compactionEnabled: coerceBoolean(fileConfig.compactionEnabled, DEFAULT_CONFIG.compactionEnabled, "compactionEnabled"),
    mcpToolsEnabled: coerceBoolean(fileConfig.mcpToolsEnabled, DEFAULT_CONFIG.mcpToolsEnabled, "mcpToolsEnabled"),
    statusEnabled: coerceBoolean(fileConfig.statusEnabled, DEFAULT_CONFIG.statusEnabled, "statusEnabled"),
    requestTimeoutMs: coercePositiveInt(fileConfig.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs, 60_000, "requestTimeoutMs"),
    startupRequestTimeoutMs: coercePositiveInt(
      fileConfig.startupRequestTimeoutMs,
      DEFAULT_CONFIG.startupRequestTimeoutMs,
      60_000,
      "startupRequestTimeoutMs",
    ),
  };
}
