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
import { isIPv4 } from "node:net";
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
  /**
   * When present, a 200 response body is parsed as JSON and the string value
   * at `captureField` is written here UTF-8 encoded, length-prefixed in the
   * first 4 bytes. Absent for plain liveness probes, which never read a body.
   */
  capture?: SharedArrayBuffer;
  captureField?: string;
}

interface HealthWorkerResponse {
  statusCode?: number;
  resume(): void;
  setEncoding?(encoding: string): void;
  on?(event: "data" | "end", handler: (chunk?: string) => void): void;
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
          if (statusCode === 200 && data.capture && data.captureField && res.on) {
            // Only the capture probe reads a body; every other caller resumes
            // the stream immediately so the socket is freed.
            let body = "";
            res.setEncoding?.("utf8");
            res.on("data", (chunk) => {
              // Bound the buffered body: a runaway response must not grow the
              // worker's heap while the caller blocks on Atomics.wait.
              if (body.length < 65_536) body += chunk ?? "";
            });
            res.on("end", () => {
              try {
                const parsed: unknown = JSON.parse(body);
                const value =
                  typeof parsed === "object" && parsed !== null
                    ? (parsed as Record<string, unknown>)[data.captureField as string]
                    : undefined;
                if (typeof value === "string") {
                  const bytes = new TextEncoder().encode(value);
                  const capture = new Uint8Array(data.capture as SharedArrayBuffer);
                  const length = Math.min(bytes.length, capture.length - 4);
                  new DataView(data.capture as SharedArrayBuffer).setUint32(0, length);
                  capture.set(bytes.subarray(0, length), 4);
                }
              } catch {
                // A malformed body leaves the capture empty; the caller treats
                // an empty capture as "unknown", never as a match.
              }
              finish(true);
            });
            return;
          }
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
const SYSTEMD_USER_SERVICE_PATHS = [
  [".config", "systemd", "user", "remnic.service"],
  [".config", "systemd", "user", "engram.service"],
] as const;
// A packaged fleet install commonly runs the daemon as a SYSTEM unit rather
// than a per-user one, so a home-relative scan alone misses it and auto mode
// would never probe (issue #2120).
const SYSTEMD_SYSTEM_SERVICE_PATHS = [
  "/etc/systemd/system/remnic.service",
  "/etc/systemd/system/engram.service",
  "/lib/systemd/system/remnic.service",
  "/usr/lib/systemd/system/remnic.service",
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
  for (const segments of [...LAUNCHD_SERVICE_PATHS, ...SYSTEMD_USER_SERVICE_PATHS]) {
    if (fileExists(path.join(homeDir, ...segments))) return true;
  }
  return SYSTEMD_SYSTEM_SERVICE_PATHS.some((unitPath) => fileExists(unitPath));
}

/**
 * Whether a daemon endpoint names THIS host.
 *
 * Literal only: a prefix test would accept a DNS name like
 * `127.daemon.example` that resolves anywhere. A wildcard bind
 * (`0.0.0.0` / `::`) names every interface on this host, so it counts as local
 * — `server.host: "0.0.0.0"` is the documented daemon configuration.
 */
export function isLoopbackDaemonHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (loopbackForWildcardBind(normalized) !== undefined) return true;
  return isIPv4(normalized) && normalized.split(".")[0] === "127";
}

/** Normalize a host for node:http/health use: strip surrounding IPv6 brackets
 * (`[::1]` → `::1`). URL builders re-bracket as needed. */
/**
 * A wildcard bind names every interface on THIS host, not a remote one. The
 * documented `server.host: "0.0.0.0"` daemon config would otherwise be
 * classified as remote — leaving `auto` embedded beside a same-host daemon on
 * the same corpus — and is not a portable destination address either, so it is
 * dialed through the matching loopback.
 */
export function loopbackForWildcardBind(host: string): string | undefined {
  const normalized = host.trim().toLowerCase();
  if (normalized === "0.0.0.0") return DEFAULT_HOST;
  if (normalized === "::" || normalized === "[::]") return "::1";
  return undefined;
}

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

const DAEMON_CAPTURE_BYTES = 1_024;

/**
 * Run one blocking daemon probe on a worker thread. `register()` is
 * synchronous, so this is the only way to consult the daemon before deciding
 * how to register. When `captureField` is set, the probe targets the detailed
 * health route and returns that field's string value from the response body.
 */
function probeDaemonSync(options: {
  host: string;
  port: number;
  timeoutMs: number;
  path: string;
  fallbackPath: string | null;
  captureField?: string;
}): { ok: boolean; captured?: string } {
  const { host, port, timeoutMs } = options;
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false };
  const deadline = Date.now() + timeoutMs;

  let worker: Worker | undefined;
  try {
    const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const view = new Int32Array(state);
    const capture = options.captureField
      ? new SharedArrayBuffer(DAEMON_CAPTURE_BYTES)
      : undefined;
    const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(HEALTH_WORKER_SOURCE)}`);
    const workerOptions: WorkerOptions & { type: "module" } = {
      type: "module",
      workerData: {
        host,
        port,
        path: options.path,
        fallbackPath: options.fallbackPath,
        token: loadDaemonAuth().token,
        deadline,
        state,
        ...(capture ? { capture, captureField: options.captureField } : {}),
      },
    };
    worker = new Worker(workerUrl, workerOptions);

    Atomics.wait(view, 0, 0, Math.max(0, deadline - Date.now()));
    const status = Atomics.load(view, 0);
    if (status === 0) void worker.terminate();
    if (status !== 1) return { ok: false };
    if (!capture) return { ok: true };
    const length = new DataView(capture).getUint32(0);
    return {
      ok: true,
      captured:
        length > 0
          ? new TextDecoder().decode(new Uint8Array(capture, 4, Math.min(length, capture.byteLength - 4)))
          : undefined,
    };
  } catch {
    if (worker) void worker.terminate();
    return { ok: false };
  }
}

export function checkDaemonHealthSync(
  host: string,
  port: number,
  timeoutMs = DEFAULT_DAEMON_HEALTH_TIMEOUT_MS,
): boolean {
  return probeDaemonSync({
    host,
    port,
    timeoutMs,
    path: LIVENESS_PATH,
    fallbackPath: LEGACY_HEALTH_PATH,
  }).ok;
}

/**
 * Read the memoryDir a healthy daemon is serving. Returns `undefined` for the
 * directory when the daemon answers but does not report one (an older build,
 * or a token without health access), which callers must treat as "unknown" —
 * never as a match.
 */
export function readDaemonMemoryDirSync(
  host: string,
  port: number,
  timeoutMs = DEFAULT_DAEMON_HEALTH_TIMEOUT_MS,
): { healthy: boolean; memoryDir?: string } {
  const probe = probeDaemonSync({
    host,
    port,
    timeoutMs,
    path: LEGACY_HEALTH_PATH,
    fallbackPath: null,
    captureField: "memoryDir",
  });
  return { healthy: probe.ok, memoryDir: probe.captured };
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
  const resolved = readConfiguredDaemonHost();
  return loopbackForWildcardBind(resolved) ?? resolved;
}

function readConfiguredDaemonHost(): string {
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

/** What a caller may ask for; `auto` defers to same-host daemon detection. */
export type BridgeModeRequest = BridgeMode | "auto";

/**
 * Same-host daemon detection for `bridgeMode: "auto"` (issue #2120).
 *
 * Explicit overrides are the CALLER's job — `resolveBridgeMode` consults this
 * only after env and config both say `auto`. Two gates must pass before an
 * auto deployment delegates:
 *
 *   1. Liveness — a PID file or a local/service-configured endpoint is only a
 *      hint (PIDs go stale and get reused), so the endpoint must answer.
 *   2. Corpus identity — the daemon must report the SAME memoryDir the plugin
 *      is configured for. Delegating to a daemon serving a different corpus
 *      would silently redirect every recall and write; an unknown memoryDir
 *      (older daemon, or a token without health access) is not a match.
 */
export function detectDaemonBridgeMode(options: {
  /** The plugin's configured memoryDir, used for the corpus-identity gate. */
  memoryDir: string;
  timeoutMs?: number;
  onSkip?: (reason: string) => void;
}): BridgeConfig {
  const daemonHost = readDaemonHost();
  const daemonPort = readDaemonPort();
  const embedded: BridgeConfig = { mode: "embedded", daemonHost, daemonPort };

  if (!isDaemonRunning() && !shouldProbeDaemonHealth(daemonHost)) {
    options.onSkip?.("no daemon PID, service unit, or local endpoint to probe");
    return embedded;
  }
  const health = readDaemonMemoryDirSync(daemonHost, daemonPort, options.timeoutMs);
  if (!health.healthy) {
    options.onSkip?.(`no healthy daemon at ${daemonHost}:${daemonPort}`);
    return embedded;
  }
  if (health.memoryDir === undefined) {
    options.onSkip?.(
      `daemon at ${daemonHost}:${daemonPort} did not report a memoryDir, so its corpus cannot be confirmed`,
    );
    return embedded;
  }
  if (!sameMemoryCorpus(options.memoryDir, health.memoryDir)) {
    options.onSkip?.(
      `daemon at ${daemonHost}:${daemonPort} serves a different memoryDir than this plugin`,
    );
    return embedded;
  }
  return { mode: "delegate", daemonHost, daemonPort };
}

/**
 * Whether two memoryDir values name the same corpus. Both sides are
 * tilde-expanded and resolved; symlinks are NOT followed, because a mismatch
 * must fail closed and a realpath here would need I/O on a path that may not
 * exist yet.
 */
function sameMemoryCorpus(pluginMemoryDir: string, daemonMemoryDir: string): boolean {
  const normalize = (value: string): string =>
    path.normalize(path.resolve(expandTildePath(value.trim()))).replace(/[\\/]+$/, "");
  if (!pluginMemoryDir.trim() || !daemonMemoryDir.trim()) return false;
  return normalize(pluginMemoryDir) === normalize(daemonMemoryDir);
}

/**
 * Resolve the bridge mode for the plugin runtime (issue #2120).
 *
 * Precedence is env override > plugin config > `embedded`. `auto` is the only
 * value that consults detection: it exists so a fleet can ship ONE config that
 * delegates on hosts running a same-corpus daemon and stays embedded
 * everywhere else. `embedded` remains the default precisely because
 * auto-flipping a co-located deployment on restart would be a silent behavior
 * change; `auto` makes that flip an explicit opt-in.
 */
export function resolveBridgeMode(
  configBridgeMode: string,
  options: { memoryDir?: string; timeoutMs?: number; onSkip?: (reason: string) => void } = {},
): BridgeConfig {
  const envMode = readCompatEnv("REMNIC_BRIDGE_MODE", "ENGRAM_BRIDGE_MODE")?.toLowerCase();
  const isRequest = (value: string): value is BridgeModeRequest =>
    value === "embedded" || value === "delegate" || value === "auto";
  let requested: BridgeModeRequest;
  if (envMode !== undefined && envMode !== "") {
    if (!isRequest(envMode)) {
      throw new Error(
        `Invalid REMNIC_BRIDGE_MODE env override: ${envMode} (expected "embedded", "delegate", or "auto")`,
      );
    }
    requested = envMode;
  } else if (configBridgeMode === undefined || configBridgeMode === "") {
    requested = "embedded";
  } else if (isRequest(configBridgeMode)) {
    requested = configBridgeMode;
  } else {
    throw new Error(
      `Invalid bridgeMode: ${String(configBridgeMode)} (expected "embedded", "delegate", or "auto")`,
    );
  }
  if (requested === "auto") {
    const memoryDir = options.memoryDir ?? "";
    if (!memoryDir.trim()) {
      throw new Error('bridgeMode "auto" requires a configured memoryDir to verify the daemon corpus');
    }
    return detectDaemonBridgeMode({
      memoryDir,
      timeoutMs: options.timeoutMs,
      onSkip: options.onSkip,
    });
  }
  return {
    mode: requested,
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
