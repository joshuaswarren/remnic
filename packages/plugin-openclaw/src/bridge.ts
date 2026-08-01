/**
 * OEO Bridge — Embedded vs Delegate mode for the OpenClaw Remnic bridge.
 *
 * Embedded mode (default): Starts EMO in-process AND exposes HTTP :4318
 * so external agents (Claude Code, Codex, etc.) can share the same memory.
 *
 * Delegate mode: Connects to a running EMO daemon instead of starting in-process.
 * Used when `remnic daemon install` has been run and the daemon is already active.
 */

import fs from "node:fs";
import path from "node:path";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { expandTildePath } from "@remnic/core";

export type BridgeMode = "embedded" | "delegate";

export interface BridgeConfig {
  mode: BridgeMode;
  daemonHost: string;
  daemonPort: number;
}

export type DaemonAuthTokenSource =
  | "OPENCLAW_REMNIC_ACCESS_TOKEN"
  | "OPENCLAW_ENGRAM_ACCESS_TOKEN"
  | "REMNIC_AUTH_TOKEN"
  | "ENGRAM_AUTH_TOKEN"
  | "remnic token store"
  | "engram token store"
  | "daemon configuration"
  | "no configured token";

export interface DaemonAuthToken {
  readonly token: string;
  readonly source: DaemonAuthTokenSource;
}

/** Everything a delegate-mode request needs to reach the standalone daemon. */
export interface DelegateDaemonTarget {
  host: string;
  port: number;
  resolveAuthToken: () => DaemonAuthToken;
}

/** Base URL for a daemon route, bracketing a bare IPv6 literal host. */
export function daemonUrl(target: DelegateDaemonTarget, pathname: string): string {
  const host =
    target.host.includes(":") && !target.host.startsWith("[") ? `[${target.host}]` : target.host;
  return `http://${host}:${target.port}${pathname}`;
}

/** Bearer header for a daemon request; empty when no token is configured. */
export function daemonAuthHeaders(target: DelegateDaemonTarget): Record<string, string> {
  const auth = target.resolveAuthToken();
  return auth.token ? { Authorization: `Bearer ${auth.token}` } : {};
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4318;
const LIVENESS_PATH = "/engram/v1/live";
const LEGACY_HEALTH_PATH = "/engram/v1/health";
export const DEFAULT_DAEMON_HEALTH_TIMEOUT_MS = 10_000;

function parseBridgeHealthTimeoutMs(value: unknown): number {
  if (value === undefined) return DEFAULT_DAEMON_HEALTH_TIMEOUT_MS;
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (
    typeof parsed !== "number" ||
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > 120_000
  ) {
    throw new Error(
      `bridgeHealthTimeoutMs must be an integer in [1, 120000]; got ${String(value)}`,
    );
  }
  return parsed;
}

export function parseOpenClawBridgeConfig(
  config: Record<string, unknown>,
): { healthTimeoutMs: number } {
  return {
    healthTimeoutMs: parseBridgeHealthTimeoutMs(config.bridgeHealthTimeoutMs),
  };
}

interface HealthWorkerData {
  state: SharedArrayBuffer;
  deadline: number;
  host: string;
  port: number;
  path: string;
  fallbackPath: string | null;
  token: string;
}

interface HealthWorkerResponse {
  statusCode?: number;
  resume(): void;
}

interface HealthWorkerRequest {
  on(event: "error" | "timeout", handler: () => void): HealthWorkerRequest;
  destroy(): void;
  end(): void;
}

type HealthRequest = (
  options: {
    hostname: string;
    port: number;
    path: string;
    method: "GET";
    timeout: number;
    headers: Record<string, string>;
  },
  onResponse: (response: HealthWorkerResponse) => void,
) => HealthWorkerRequest;

export function runHealthWorker(request: HealthRequest, data: HealthWorkerData): void {
  const view = new Int32Array(data.state);
  let completed = false;

  function finish(ok: boolean): void {
    if (completed) return;
    completed = true;
    Atomics.store(view, 0, ok ? 1 : 2);
    Atomics.notify(view, 0);
  }

  function probe(pathname: string, fallbackPath: string | null): void {
    const remainingMs = data.deadline - Date.now();
    if (remainingMs <= 0) {
      finish(false);
      return;
    }
    let responseReceived = false;
    try {
      const headers: Record<string, string> = {};
      if (data.token) headers.Authorization = `Bearer ${data.token}`;
      const req = request(
        {
          hostname: data.host,
          port: data.port,
          path: pathname,
          method: "GET",
          timeout: remainingMs,
          headers,
        },
        (res) => {
          responseReceived = true;
          const statusCode = res.statusCode;
          res.resume();
          if (statusCode === 200) {
            finish(true);
          } else if (statusCode === 404 && fallbackPath) {
            probe(fallbackPath, null);
          } else {
            finish(false);
          }
        },
      );
      req.on("error", () => {
        if (!responseReceived) finish(false);
      });
      req.on("timeout", () => {
        req.destroy();
        if (!responseReceived) finish(false);
      });
      req.end();
    } catch {
      finish(false);
    }
  }

  probe(data.path, data.fallbackPath);
}

const HEALTH_WORKER_SOURCE = `
import { request } from "node:http";
import { workerData } from "node:worker_threads";
const __name = (target) => target;
(${runHealthWorker.toString()})(request, workerData);
`;
const LAUNCHD_SERVICE_PATHS = [
  ["Library", "LaunchAgents", "ai.remnic.daemon.plist"],
  ["Library", "LaunchAgents", "ai.remnic.server.plist"],
  ["Library", "LaunchAgents", "ai.engram.daemon.plist"],
] as const;
const SYSTEMD_SERVICE_PATHS = [
  [".config", "systemd", "user", "remnic.service"],
  [".config", "systemd", "user", "engram.service"],
] as const;

function readEnv(name: string): string | undefined {
  const env = (globalThis.process as { env?: Record<string, string | undefined> } | undefined)?.["env"];
  return env?.[name];
}

function resolveHomeDir(): string {
  return readEnv("HOME") ?? readEnv("USERPROFILE") ?? "~";
}

function readCompatEnv(primary: string, legacy: string): string | undefined {
  return readEnv(primary) ?? readEnv(legacy);
}

function configPathCandidates(): string[] {
  const envPath = readCompatEnv("REMNIC_CONFIG_PATH", "ENGRAM_CONFIG_PATH");
  return [
    ...(envPath ? [path.resolve(expandTildePath(envPath))] : []),
    path.join(resolveHomeDir(), ".config", "remnic", "config.json"),
    path.join(resolveHomeDir(), ".config", "engram", "config.json"),
    path.join(process.cwd(), "remnic.config.json"),
    path.join(process.cwd(), "engram.config.json"),
  ];
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Detect whether a daemon is already running by checking the PID file.
 *
 * Keep this path subprocess-free: OpenClaw's plugin installer statically blocks
 * packaged plugins that invoke shell/process launch APIs.
 */
function isDaemonRunning(): boolean {
  for (const pidFile of [
    path.join(resolveHomeDir(), ".remnic", "server.pid"),
    path.join(resolveHomeDir(), ".engram", "server.pid"),
  ]) {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      process.kill(pid, 0);
      return true;
    } catch {
      // PID file missing or stale — continue checking
    }
  }
  return false;
}

function isDaemonServiceConfigured(): boolean {
  const homeDir = resolveHomeDir();
  for (const segments of [...LAUNCHD_SERVICE_PATHS, ...SYSTEMD_SERVICE_PATHS]) {
    if (fileExists(path.join(homeDir, ...segments))) return true;
  }
  return false;
}

/** Normalize a host for node:http/health use: strip surrounding IPv6 brackets
 * (`[::1]` → `::1`). URL builders re-bracket as needed. */
function normalizeDaemonHost(value: string): string {
  const match = value.trim().match(/^\[(.+)\]$/);
  return match ? match[1] : value.trim();
}

function coerceDaemonPort(value: unknown): number | undefined {
  const parsed = typeof value === "string" && value.trim() !== ""
    ? Number(value.trim())
    : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : undefined;
}

export function checkDaemonHealthSync(
  host: string,
  port: number,
  timeoutMs = DEFAULT_DAEMON_HEALTH_TIMEOUT_MS,
): boolean {
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return false;
  const deadline = Date.now() + timeoutMs;

  let worker: Worker | undefined;
  try {
    const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const view = new Int32Array(state);
    const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(HEALTH_WORKER_SOURCE)}`);
    const workerOptions: WorkerOptions & { type: "module" } = {
      type: "module",
      workerData: {
        host,
        port,
        path: LIVENESS_PATH,
        fallbackPath: LEGACY_HEALTH_PATH,
        token: loadDaemonAuth().token,
        deadline,
        state,
      },
    };
    worker = new Worker(workerUrl, workerOptions);

    Atomics.wait(view, 0, 0, Math.max(0, deadline - Date.now()));
    const status = Atomics.load(view, 0);
    if (status === 0) void worker.terminate();
    return status === 1;
  } catch {
    if (worker) void worker.terminate();
    return false;
  }
}

function shouldProbeDaemonHealth(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === DEFAULT_HOST ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    isDaemonServiceConfigured()
  );
}

/**
 * Read daemon host from environment or remnic config (server.host), mirroring
 * readDaemonPort's precedence. Falls back to DEFAULT_HOST.
 */
function readDaemonHost(): string {
  const envHost = readCompatEnv("REMNIC_HOST", "ENGRAM_HOST");
  if (envHost !== undefined && envHost.trim() !== "") return normalizeDaemonHost(envHost);
  for (const p of configPathCandidates()) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      const configHost = raw.server?.host;
      if (typeof configHost === "string" && configHost.trim() !== "") {
        return normalizeDaemonHost(configHost);
      }
    } catch {
      // Ignore malformed config files and continue to the next candidate.
    }
  }
  return DEFAULT_HOST;
}

/**
 * Read daemon port from environment or remnic config.
 */
function readDaemonPort(): number {
  const envPort = coerceDaemonPort(readCompatEnv("REMNIC_PORT", "ENGRAM_PORT"));
  if (envPort !== undefined) return envPort;

  for (const p of configPathCandidates()) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      const configPort = coerceDaemonPort(raw.server?.port);
      if (configPort !== undefined) return configPort;
    } catch {
      // Ignore malformed config files and continue to the next candidate.
    }
  }
  return DEFAULT_PORT;
}

/**
 * Determine bridge mode:
 * - If REMNIC_BRIDGE_MODE env is set, use that.
 * - If a daemon is already running, use delegate mode.
 * - Otherwise, use embedded mode.
 */
export function detectBridgeMode(): BridgeConfig {
  const envMode = readCompatEnv("REMNIC_BRIDGE_MODE", "ENGRAM_BRIDGE_MODE")?.toLowerCase();

  if (envMode === "delegate") {
    return {
      mode: "delegate",
      daemonHost: readDaemonHost(),
      daemonPort: readDaemonPort(),
    };
  }

  if (envMode === "embedded") {
    return {
      mode: "embedded",
      daemonHost: DEFAULT_HOST,
      daemonPort: readDaemonPort(),
    };
  }

  const daemonHost = readDaemonHost();
  const daemonPort = readDaemonPort();

  const hasDaemonPidHint = isDaemonRunning();

  // Auto-detect: PID files are only hints, because PIDs can be stale or reused.
  // Delegate only after the configured Remnic endpoint proves it is healthy.
  if (
    (hasDaemonPidHint || shouldProbeDaemonHealth(daemonHost)) &&
    checkDaemonHealthSync(daemonHost, daemonPort)
  ) {
    return {
      mode: "delegate",
      daemonHost,
      daemonPort,
    };
  }

  return {
    mode: "embedded",
    daemonHost: DEFAULT_HOST,
    daemonPort,
  };
}
/**
 * Resolve the bridge mode for the plugin runtime (issue #2120).
 *
 * Unlike `detectBridgeMode`, this resolver is EXPLICIT-ONLY: delegate mode
 * activates solely via `REMNIC_BRIDGE_MODE=delegate` (or the legacy env) or
 * the plugin config's `bridgeMode: "delegate"`. The auto-detection branch of
 * `detectBridgeMode` is intentionally not consulted — auto-flipping existing
 * co-located deployments (embedded plugin beside a same-host daemon) to
 * delegate on a restart would be a silent behavior change. Revisit once
 * delegate mode has production mileage.
 */
export function resolveBridgeMode(configBridgeMode: string): BridgeConfig {
  const envMode = readCompatEnv("REMNIC_BRIDGE_MODE", "ENGRAM_BRIDGE_MODE")?.toLowerCase();
  let mode: BridgeMode;
  if (envMode === "delegate" || envMode === "embedded") {
    mode = envMode;
  } else if (envMode !== undefined && envMode !== "") {
    throw new Error(
      `Invalid REMNIC_BRIDGE_MODE env override: ${envMode} (expected "embedded" or "delegate")`,
    );
  } else if (
    configBridgeMode === undefined ||
    configBridgeMode === "" ||
    configBridgeMode === "embedded"
  ) {
    mode = "embedded";
  } else if (configBridgeMode === "delegate") {
    mode = "delegate";
  } else {
    throw new Error(
      `Invalid bridgeMode: ${String(configBridgeMode)} (expected "embedded" or "delegate")`,
    );
  }
  return {
    mode,
    daemonHost: readDaemonHost(),
    daemonPort: readDaemonPort(),
  };
}

function isOpenClawTokenEntry(value: unknown): value is { token: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    "connector" in value &&
    value.connector === "openclaw" &&
    "token" in value &&
    typeof value.token === "string"
  );
}

/**
 * Load daemon credentials from the environment, standard token stores, or
 * daemon configuration. Shared by health and delegate requests.
 *
 * Environment precedence is primary-before-legacy (AGENTS.md §9): both current
 * names outrank both pre-rename aliases. A migrated deployment commonly still
 * exports `OPENCLAW_ENGRAM_ACCESS_TOKEN` from an old shell profile or unit
 * file; if that stale value outranked the `REMNIC_AUTH_TOKEN` the daemon is
 * actually running with, every request would 401 and the reported `source`
 * would point the operator at the wrong variable (issue #2286).
 */
export function loadDaemonAuth(): DaemonAuthToken {
  const environmentTokens = [
    ["OPENCLAW_REMNIC_ACCESS_TOKEN", readEnv("OPENCLAW_REMNIC_ACCESS_TOKEN")],
    ["REMNIC_AUTH_TOKEN", readEnv("REMNIC_AUTH_TOKEN")],
    ["OPENCLAW_ENGRAM_ACCESS_TOKEN", readEnv("OPENCLAW_ENGRAM_ACCESS_TOKEN")],
    ["ENGRAM_AUTH_TOKEN", readEnv("ENGRAM_AUTH_TOKEN")],
  ] as const;
  for (const [source, token] of environmentTokens) {
    if (token) return { token, source };
  }

  const tokenStores = [
    { path: path.join(resolveHomeDir(), ".remnic", "tokens.json"), source: "remnic token store" },
    { path: path.join(resolveHomeDir(), ".engram", "tokens.json"), source: "engram token store" },
  ] as const;
  for (const tokenStore of tokenStores) {
    if (!fs.existsSync(tokenStore.path)) continue;
    try {
      const store = JSON.parse(fs.readFileSync(tokenStore.path, "utf8"));
      const tokens = Array.isArray(store.tokens) ? store.tokens : [];
      const openClawToken = tokens.find(isOpenClawTokenEntry)?.token;
      if (typeof openClawToken === "string" && openClawToken.length > 0) {
        return { token: openClawToken, source: tokenStore.source };
      }
      if (
        typeof store === "object" &&
        store !== null &&
        "openclaw" in store &&
        typeof store.openclaw === "string" &&
        store.openclaw.length > 0 &&
        (store.openclaw.startsWith("remnic_") || store.openclaw.startsWith("engram_"))
      ) {
        return { token: store.openclaw, source: tokenStore.source };
      }
    } catch {
      continue;
    }
  }

  try {
    for (const configPath of configPathCandidates()) {
      if (!fs.existsSync(configPath)) continue;
      const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const token = raw.server?.authToken;
      if (typeof token === "string" && token.length > 0) {
        return { token, source: "daemon configuration" };
      }
    }
  } catch {
    return { token: "", source: "no configured token" };
  }
  return { token: "", source: "no configured token" };
}

/**
 * Check whether the standalone daemon is available for delegated requests.
 * Falls back to detailed health when the daemon predates the liveness route.
 */
export async function checkDaemonHealth(
  host: string,
  port: number,
  timeoutMs = DEFAULT_DAEMON_HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return false;
  const deadline = Date.now() + timeoutMs;
  try {
    const { request } = await import("node:http");
    const token = loadDaemonAuth().token;
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const probe = (requestPath: string): Promise<number | undefined> =>
      new Promise((resolve) => {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          resolve(undefined);
          return;
        }
        let settled = false;
        const finish = (statusCode: number | undefined): void => {
          if (settled) return;
          settled = true;
          resolve(statusCode);
        };
        const req = request(
          { hostname: host, port, path: requestPath, method: "GET", timeout: remainingMs, headers },
          (res) => {
            finish(res.statusCode);
            res.resume();
          },
        );
        req.on("error", () => finish(undefined));
        req.on("timeout", () => {
          req.destroy();
          finish(undefined);
        });
        req.end();
      });

    const livenessStatus = await probe(LIVENESS_PATH);
    if (livenessStatus === 200) return true;
    if (livenessStatus !== 404) return false;
    return await probe(LEGACY_HEALTH_PATH) === 200;
  } catch {
    return false;
  }
}
