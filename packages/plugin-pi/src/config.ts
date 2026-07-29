import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Leaf submodule (not the `@remnic/core` barrel) so the omp pre-bundle's
// `bun build` does not pull the rest of core — including the LanceDB native
// asset — into the extension bundle. See PR #1641.
import { expandTildePath } from "@remnic/core/utils/path";

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
  /**
   * Per-turn request budget for observe/recall. MUST stay below the host's
   * in-handler kill budget (Pi/omp kills handlers at 30 s). Defaults to 20 s,
   * capped at 25 s so a misconfiguration can never produce a structurally
   * unsatisfiable timeout (issue #1626).
   */
  turnRequestTimeoutMs: number;
  /**
   * Soft cap on a single observe POST body in bytes. The client chunks observe
   * batches to stay under this; individual oversized messages are truncated
   * with a marker. Defaults to 100 KiB, safely under the daemon's default
   * 128 KiB `maxBodyBytes` (issue #1600).
   */
  observeMaxBytes: number;
  /**
   * Maximum retry attempts for observe/recall on transient connection-level
   * failures (socket close, ECONNRESET, EPIPE). Observe is dedupe-safe so
   * retrying is harmless (issue #1602).
   */
  observeMaxRetries: number;
  /**
   * Cooldown base for the daemon-reachability circuit breaker. When observe/
   * recall fails on a timeout or connection error, subsequent turns skip fast
   * for an exponentially growing window starting at this value (issue #1626).
   */
  daemonCooldownMs: number;
  /**
   * Number of explicit recall timeout errors in the last {@link recallTimeoutWindow}
   * recall calls that permanently disables automatic recall for the process lifetime.
   */
  recallTimeoutThreshold: number;
  /**
   * Size of the rolling window of recent recall calls used by the recall-timeout
   * circuit breaker.
   */
  recallTimeoutWindow: number;
}

export interface LoadConfigOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_CONFIG: RemnicPiConfig = {
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
  // Default 20 s is comfortably under the Pi/omp 30 s handler budget (#1626).
  turnRequestTimeoutMs: 20000,
  // Default 100 KiB leaves headroom under the daemon's 128 KiB default (#1600).
  observeMaxBytes: 102400,
  observeMaxRetries: 2,
  // Base cooldown for the circuit breaker; doubles on consecutive failures (#1626).
  daemonCooldownMs: 5000,
  // Recall-timeout circuit breaker: 7 timeouts in the last 10 recall calls trip permanently.
  recallTimeoutThreshold: 7,
  recallTimeoutWindow: 10,
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

/**
 * Like {@link coercePositiveInt} but allows 0, for knobs where 0 is a
 * meaningful "disabled" value (e.g. observeMaxRetries). Still rejects
 * negatives, non-integers, and values above the cap.
 */
function coerceNonNegativeInt(value: unknown, fallback: number, max: number, fieldName: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return fallback;
    if (!/^[+-]?\d+$/.test(trimmed)) {
      throw new Error(`Invalid numeric value for Remnic Pi config field ${fieldName}: expected an integer from 0 to ${max}`);
    }
    parsed = Number(trimmed);
  } else {
    throw new Error(`Invalid numeric value for Remnic Pi config field ${fieldName}: expected an integer from 0 to ${max}`);
  }
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`Invalid numeric value for Remnic Pi config field ${fieldName}: expected an integer from 0 to ${max}`);
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
  // REMNIC_PI_CONFIG keeps precedence for upstream Pi; REMNIC_OMP_CONFIG lets an
  // omp (oh-my-pi) direct load (`omp -e npm:@remnic/plugin-pi`) point the shared
  // runtime module at its own config without an explicit configPath. Connector
  // installs always pass an explicit configPath, so this only affects direct loads.
  return expandTildePath(
    options.configPath || env.REMNIC_PI_CONFIG || env.REMNIC_OMP_CONFIG || defaultConfigPath(env),
  );
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

  const requestTimeoutMs = coercePositiveInt(
    fileConfig.requestTimeoutMs,
    DEFAULT_CONFIG.requestTimeoutMs,
    60_000,
    "requestTimeoutMs",
  );
  // When turnRequestTimeoutMs is not explicitly set, derive it from the
  // configured requestTimeoutMs (capped at the default turn budget) so an
  // existing install that lowered requestTimeoutMs below 20s keeps its tighter
  // per-turn budget instead of being silently raised back to 20s (codex review).
  const turnFallback = Math.min(requestTimeoutMs, DEFAULT_CONFIG.turnRequestTimeoutMs);
  const turnRequestTimeoutMs = coercePositiveInt(
    fileConfig.turnRequestTimeoutMs,
    turnFallback,
    25_000,
    "turnRequestTimeoutMs",
  );
  const recallTimeoutThreshold = coercePositiveInt(
    fileConfig.recallTimeoutThreshold,
    DEFAULT_CONFIG.recallTimeoutThreshold,
    1000,
    "recallTimeoutThreshold",
  );
  const recallTimeoutWindow = coercePositiveInt(
    fileConfig.recallTimeoutWindow,
    DEFAULT_CONFIG.recallTimeoutWindow,
    1000,
    "recallTimeoutWindow",
  );
  if (recallTimeoutThreshold > recallTimeoutWindow) {
    throw new Error(
      `Invalid recall timeout circuit breaker config: threshold (${recallTimeoutThreshold}) cannot exceed window (${recallTimeoutWindow})`,
    );
  }

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
    requestTimeoutMs,
    startupRequestTimeoutMs: coercePositiveInt(
      fileConfig.startupRequestTimeoutMs,
      DEFAULT_CONFIG.startupRequestTimeoutMs,
      60_000,
      "startupRequestTimeoutMs",
    ),
    turnRequestTimeoutMs,
    observeMaxBytes: coercePositiveInt(
      fileConfig.observeMaxBytes,
      DEFAULT_CONFIG.observeMaxBytes,
      8_388_608,
      "observeMaxBytes",
    ),
    observeMaxRetries: coerceNonNegativeInt(fileConfig.observeMaxRetries, DEFAULT_CONFIG.observeMaxRetries, 5, "observeMaxRetries"),
    daemonCooldownMs: coercePositiveInt(fileConfig.daemonCooldownMs, DEFAULT_CONFIG.daemonCooldownMs, 60_000, "daemonCooldownMs"),
    recallTimeoutThreshold,
    recallTimeoutWindow,
  };
}
