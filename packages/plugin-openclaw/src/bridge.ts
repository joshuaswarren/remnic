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
import { Worker } from "node:worker_threads";

export type BridgeMode = "embedded" | "delegate";

export interface BridgeConfig {
  mode: BridgeMode;
  daemonHost: string;
  daemonPort: number;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4318;
const LEGACY_HEALTH_PATH = "/engram/v1/health";
const SYNC_HEALTH_TIMEOUT_MS = 2000;
const HEALTH_WORKER_SOURCE = `
import { request } from "node:http";
import { workerData } from "node:worker_threads";

const view = new Int32Array(workerData.state);
let completed = false;

function finish(ok) {
  if (completed) return;
  completed = true;
  Atomics.store(view, 0, ok ? 1 : 2);
  Atomics.notify(view, 0);
}

try {
  const headers = {};
  if (workerData.token) headers.Authorization = "Bearer " + workerData.token;
  const req = request(
    {
      hostname: workerData.host,
      port: workerData.port,
      path: workerData.path,
      method: "GET",
      timeout: workerData.timeoutMs,
      headers,
    },
    (res) => {
      finish(res.statusCode === 200);
      res.resume();
    },
  );
  req.on("error", () => finish(false));
  req.on("timeout", () => {
    req.destroy();
    finish(false);
  });
  req.end();
} catch {
  finish(false);
}
`;
const LAUNCHD_SERVICE_PATHS = [
  ["Library", "LaunchAgents", "ai.remnic.daemon.plist"],
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
    ...(envPath ? [path.resolve(envPath)] : []),
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

function coerceDaemonPort(value: unknown): number | undefined {
  const parsed = typeof value === "string" && value.trim() !== ""
    ? Number(value.trim())
    : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : undefined;
}

function checkDaemonHealthSync(host: string, port: number, timeoutMs = SYNC_HEALTH_TIMEOUT_MS): boolean {
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return false;

  let worker: Worker | undefined;
  try {
    const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const view = new Int32Array(state);
    const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(HEALTH_WORKER_SOURCE)}`);
    worker = new Worker(workerUrl, {
      type: "module",
      workerData: {
        host,
        port,
        path: LEGACY_HEALTH_PATH,
        token: loadAnyToken(),
        timeoutMs,
        state,
      },
    });

    Atomics.wait(view, 0, 0, timeoutMs + 250);
    const status = Atomics.load(view, 0);
    if (status === 0) void worker.terminate();
    return status === 1;
  } catch {
    if (worker) void worker.terminate();
    return false;
  }
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
      daemonHost: readCompatEnv("REMNIC_HOST", "ENGRAM_HOST") ?? DEFAULT_HOST,
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

  const daemonHost = readCompatEnv("REMNIC_HOST", "ENGRAM_HOST") ?? DEFAULT_HOST;
  const daemonPort = readDaemonPort();

  // Auto-detect: if daemon is running or service-managed and live, delegate; otherwise embedded.
  if (isDaemonRunning() || (isDaemonServiceConfigured() && checkDaemonHealthSync(daemonHost, daemonPort))) {
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
 * Load the first valid auth token for health check.
 */
function loadAnyToken(): string {
  const tokenPaths = [
    path.join(resolveHomeDir(), ".remnic", "tokens.json"),
    path.join(resolveHomeDir(), ".engram", "tokens.json"),
  ];
  for (const tokensPath of tokenPaths) {
    if (!fs.existsSync(tokensPath)) continue;
    try {
      const store = JSON.parse(fs.readFileSync(tokensPath, "utf8"));
      const tokens = Array.isArray(store.tokens) ? store.tokens : [];
      if (tokens.length > 0 && tokens[0].token) return tokens[0].token;
      if (typeof store === "object" && store !== null) {
        for (const val of Object.values(store)) {
          if (
            typeof val === "string" &&
            val.length > 0 &&
            (val.startsWith("remnic_") || val.startsWith("engram_"))
          ) {
            return val;
          }
        }
      }
    } catch {
      // Ignore malformed token files and continue to the next candidate.
    }
  }
  try {
    for (const p of configPathCandidates()) {
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, "utf8"));
        if (raw.server?.authToken) return raw.server.authToken;
      }
    }
  } catch {
    // ignore
  }
  return (
    readEnv("OPENCLAW_REMNIC_ACCESS_TOKEN") ??
    readEnv("OPENCLAW_ENGRAM_ACCESS_TOKEN") ??
    readCompatEnv("REMNIC_AUTH_TOKEN", "ENGRAM_AUTH_TOKEN") ??
    ""
  );
}

/**
 * Check if the daemon is reachable via HTTP health check.
 * Uses the authenticated legacy health endpoint for compatibility.
 */
export async function checkDaemonHealth(host: string, port: number): Promise<boolean> {
  try {
    const { request } = await import("node:http");
    const token = loadAnyToken();
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;

    return new Promise((resolve) => {
      const req = request(
        { hostname: host, port, path: LEGACY_HEALTH_PATH, method: "GET", timeout: 2000, headers },
        (res) => {
          resolve(res.statusCode === 200);
          res.resume();
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  } catch {
    return false;
  }
}
