
import fs from "node:fs";
import path from "node:path";
import {
  isLoopbackDaemonHost,
  loopbackForSameHost,
  normalizeDaemonHost,
  sameHostDialFallback,
} from "./bridge-daemon-host.js";

export { isLoopbackDaemonHost, loopbackForSameHost, sameHostDialFallback } from "./bridge-daemon-host.js";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { configPathCandidates, readCompatEnv } from "@remnic/core";

import {
  HEALTH_WORKER_SOURCE,
  runHealthWorker,
  type HealthWorkerData,
} from "./bridge-health-worker.js";
import { resolveSystemUnitSources, resolveUnitEndpoint } from "./bridge-service-units.js";
import {
  isDaemonServiceConfigured,
  readServiceEndpoints,
  readUnitAuthToken,
  SYSTEMD_SYSTEM_UNIT_DIRS,
  systemdUserUnitDirs,
  type DaemonUnitSource,
} from "./bridge-unit-discovery.js";
// Re-exported so `bridge.js` stays the single import surface for consumers of
// daemon endpoint facts, however the discovery is split internally.
export {
  isDaemonServiceConfigured,
  readServiceEndpoints,
  readUnitAuthToken,
  SYSTEMD_SYSTEM_UNIT_DIRS,
  systemdUserUnitDirs,
  type DaemonUnitSource,
} from "./bridge-unit-discovery.js";

export { runHealthWorker } from "./bridge-health-worker.js";
import { daemonServesCorpus } from "./memory-read-scope.js";

export {
  resolveSystemUnitSources,
  resolveUnitConfigPath,
  resolveUnitEndpoint,
} from "./bridge-service-units.js";

export type BridgeMode = "embedded" | "delegate";

interface DaemonEndpointCandidate {
  host: string;
  port: number;
  configPath?: string;
  token: string;
  authTokenOverride?: string;
  authTokenUnit?: DaemonUnitSource;
  aliasGroup: string;
  fallbackToken?: string;
}

export interface BridgeConfig {
  mode: BridgeMode;
  daemonHost: string;
  daemonPort: number;
  daemonHostFallback?: string;
  healthVerified?: boolean;
  daemonConfigPath?: string;
  daemonAuthTokenOverride?: string;
  daemonAuthUnit?: DaemonUnitSource;
  daemonAuthPrefersConfig?: boolean;
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

export interface DelegateDaemonTarget {
  host: string;
  port: number;
  resolveAuthToken: () => DaemonAuthToken;
  invalidateAuthToken?: (auth: DaemonAuthToken) => void;
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

export type DaemonHealthFailure = "auth" | "network" | "http";

export interface DaemonHealthResult {
  readonly ok: boolean;
  readonly failure?: DaemonHealthFailure;
  readonly status?: number;
  readonly tokenSource?: DaemonAuthTokenSource;
}

function assertProbeBudget(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_DAEMON_HEALTH_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_BRIDGE_HEALTH_TIMEOUT_MS) {
    throw new Error(
      `timeoutMs must be an integer in [1, ${MAX_BRIDGE_HEALTH_TIMEOUT_MS}]; got ${String(timeoutMs)}`,
    );
  }
  return timeoutMs;
}

const MAX_BRIDGE_HEALTH_TIMEOUT_MS = 120_000;

function parseBridgeHealthTimeoutMs(value: unknown): number {
  if (value === undefined) return DEFAULT_DAEMON_HEALTH_TIMEOUT_MS;
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (
    typeof parsed !== "number" ||
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_BRIDGE_HEALTH_TIMEOUT_MS
  ) {
    throw new Error(
      `bridgeHealthTimeoutMs must be an integer in [1, ${MAX_BRIDGE_HEALTH_TIMEOUT_MS}]; got ${String(value)}`,
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

function readEnv(name: string): string | undefined {
  const env = (globalThis.process as { env?: Record<string, string | undefined> } | undefined)?.["env"];
  return env?.[name];
}

function resolveHomeDir(): string {
  return readEnv("HOME") ?? readEnv("USERPROFILE") ?? "~";
}

/**
 * The config path the INSTALLED daemon service is pinned to.
 *
 * The shipped systemd unit and launchd plist both set `REMNIC_CONFIG_PATH`
 * explicitly, and that variable lives only in the daemon's environment. Two
 * processes with different cwds can therefore never converge on the same file
 * by matching candidate order alone: a gateway started in a directory that
 * happens to hold a `remnic.config.json` would probe that endpoint, stay
 * embedded, and stack an orchestrator on the daemon's corpus. Reading the unit
 * asks the daemon which file it actually uses. Ranked below this process's own
 * `REMNIC_CONFIG_PATH`, which is a deliberate operator instruction.
 */


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

function coerceDaemonPort(value: unknown): number | undefined {
  const parsed = typeof value === "string" && value.trim() !== ""
    ? Number(value.trim())
    : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : undefined;
}

const DAEMON_CAPTURE_BYTES = 1_024;

function probeDaemonSync(options: {
  host: string;
  port: number;
  timeoutMs: number;
  path: string;
  fallbackPath: string | null;
  captureField?: string;
  /** Bind the credential to the config this endpoint came from. */
  configPath?: string;
  /** A unit-supplied credential, which outranks the config's. */
  authToken?: string;
}): {
  ok: boolean;
  captured?: string;
  rejectedAuth?: boolean;
  failure?: "auth" | "network" | "http";
  authSource?: DaemonAuthTokenSource;
} {
  const auth =
    options.authToken === undefined
      ? loadDaemonAuth(options.configPath)
      : { token: options.authToken, source: "daemon configuration" as const };
  const { host, port, timeoutMs } = options;
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, failure: "network" };
  }
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
        token: auth.token,
        deadline,
        state,
        ...(capture ? { capture, captureField: options.captureField } : {}),
      },
    };
    worker = new Worker(workerUrl, workerOptions);

    Atomics.wait(view, 0, 0, Math.max(0, deadline - Date.now()));
    const status = Atomics.load(view, 0);
    if (status === 0) void worker.terminate();
    if (status !== 1) {
      const failure = status === 3 ? "auth" : status === 4 ? "http" : "network";
      return {
        ok: false,
        failure,
        ...(status === 3 ? { rejectedAuth: true, authSource: auth.source } : {}),
      };
    }
    if (!capture) return { ok: true };
    const length = new DataView(capture).getUint32(0);
    if (length === 0) return { ok: true };
    if (length > capture.byteLength - 4) return { ok: true };
    return { ok: true, captured: new TextDecoder().decode(new Uint8Array(capture, 4, length)) };
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
  assertProbeBudget(timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const anonymous = probeDaemonSync({
    host,
    port,
    timeoutMs,
    path: LIVENESS_PATH,
    fallbackPath: LEGACY_HEALTH_PATH,
    authToken: "",
  });
  if (anonymous.ok || anonymous.rejectedAuth === true) return true;
  if (anonymous.failure === "network") return false;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  return probeDaemonSync({
    host,
    port,
    timeoutMs: remaining,
    path: LIVENESS_PATH,
    fallbackPath: LEGACY_HEALTH_PATH,
  }).ok;
}

export function readDaemonMemoryDirSync(
  host: string,
  port: number,
  timeoutMs = DEFAULT_DAEMON_HEALTH_TIMEOUT_MS,
  configPath?: string,
  authToken?: string,
): {
  healthy: boolean;
  memoryDir?: string;
  rejectedAuth?: boolean;
  failure?: "auth" | "network" | "http";
  authSource?: DaemonAuthTokenSource;
} {
  assertProbeBudget(timeoutMs);
  const probe = probeDaemonSync({
    host,
    port,
    timeoutMs,
    path: LEGACY_HEALTH_PATH,
    fallbackPath: null,
    captureField: "memoryDir",
    configPath,
    authToken,
  });
  return {
    healthy: probe.ok,
    memoryDir: probe.captured,
    ...(probe.failure === undefined ? {} : { failure: probe.failure }),
    ...(probe.rejectedAuth === true ? { rejectedAuth: true } : {}),
    ...(probe.authSource === undefined ? {} : { authSource: probe.authSource }),
  };
}


function shouldProbeDaemonHealth(host: string): boolean {
  return isLoopbackDaemonHost(host) || isDaemonServiceConfigured();
}

/**
 * Read daemon host from environment or remnic config (server.host), mirroring
 * readDaemonPort's precedence. Falls back to DEFAULT_HOST.
 */
function readDaemonHost(): string {
  const resolved = readConfiguredDaemonHost();
  return loopbackForSameHost(resolved) ?? resolved;
}

/**
 * The `server` block of the ONE config file the daemon would have booted from.
 *
 * The standalone server selects a single file (`resolveConfigPath`) and takes
 * every field from it, defaulting whatever that file omits. Scanning the whole
 * candidate list per field would synthesize an endpoint that exists in no
 * file — a cwd config's host with a home config's port — and `auto` would then
 * probe a port nothing is listening on and start a second orchestrator beside
 * the running daemon. A malformed selected file yields no fields, exactly as
 * it yields the daemon nothing.
 */
/**
 * The endpoint the daemon's OWN config selection resolves to.
 *
 * Mirrors `remnic-server`'s `resolveConfigPath`: the first EXISTING candidate
 * wins outright, and `parseServerConfig` then defaults its missing fields to
 * `127.0.0.1:4318`. A later file that declares an endpoint is not the daemon's
 * config, so skipping past a silent first one would dial a server nobody is
 * running. Host and port therefore always come from one file — never spliced.
 */
function readDaemonServerConfig(): { host?: string; port?: number } {
  for (const candidate of configPathCandidates()) {
    const server = readServerBlock(candidate);
    if (server !== undefined) return server;
  }
  return {};
}

/**
 * The `server` block of one config file, or `undefined` when that file is not
 * one the daemon could have booted from (missing, unparseable, or carrying a
 * `server` its own loader rejects).
 */
function readServerBlock(
  candidate: string,
): { host?: string; port?: number; authToken?: string } | undefined {
  if (!fileExists(candidate)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(candidate, "utf8"));
  } catch {
    // Unparseable: it names no endpoint at all.
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const server = (raw as { server?: unknown }).server;
  // Absent is fine — the daemon defaults every field. A `server` that is not a
  // plain object is a file the daemon's own loader REJECTS.
  if (server === undefined) return {};
  if (typeof server !== "object" || server === null || Array.isArray(server)) return undefined;
  const { host, port } = server as { host?: unknown; port?: unknown };
  const parsedPort = coerceDaemonPort(port);
  const { authToken } = server as { authToken?: unknown };
  return {
    ...(typeof host === "string" && host.trim() !== "" ? { host } : {}),
    ...(parsedPort === undefined ? {} : { port: parsedPort }),
    ...(typeof authToken === "string" && authToken.length > 0 ? { authToken } : {}),
  };
}

/**
 * Every endpoint a same-host daemon could be listening on, most-likely first.
 *
 * `auto` cannot know WHICH config the running daemon booted from: a unit file
 * can sit installed but inactive while the daemon was launched by hand from a
 * cwd config, and vice versa. Picking one file and probing it once would leave
 * `auto` embedded beside a daemon it simply did not dial. So auto probes the
 * distinct candidates in order and delegates to the first that is healthy AND
 * serves this corpus — both gates still apply per endpoint, so a stale entry
 * costs one failed probe rather than a second orchestrator.
 *
 * Explicit `delegate` still resolves exactly one endpoint: the operator named
 * a daemon, so guessing among candidates would be the wrong behavior.
 */
function daemonEndpointCandidates(
  unitExists?: (candidate: string) => boolean,
): DaemonEndpointCandidate[] {
  const envHost = readCompatEnv("REMNIC_HOST", "ENGRAM_HOST");
  const envPort = coerceDaemonPort(readCompatEnv("REMNIC_PORT", "ENGRAM_PORT"));
  const candidates: DaemonEndpointCandidate[] = [];
  const add = (
    host: string | undefined,
    port: number | undefined,
    configPath?: string,
    authTokenOverride?: string,
    authTokenUnit?: DaemonUnitSource,
  ): void => {
    const resolvedHost = normalizeDaemonHost(
      envHost !== undefined && envHost.trim() !== "" ? envHost : (host ?? DEFAULT_HOST),
    );
    const dialHost = loopbackForSameHost(resolvedHost) ?? resolvedHost;
    const dialFallback = sameHostDialFallback(resolvedHost);
    const dialPort = envPort ?? port ?? DEFAULT_PORT;
    // Dedupe on the endpoint AND its credential: an inactive service config
    // and a manually launched daemon can share host:port while carrying
    // different `server.authToken` values. Dropping the later one would send
    // the stale token, take a 401, and never retry with the live credential.
    const token = authTokenOverride ?? loadDaemonAuth(configPath).token;
    // The gateway-global token store outranks a config file inside
    // `loadDaemonAuth`, which is right for a co-installed daemon but wrong for
    // one running under another account with a static `server.authToken`: the
    // store's unrelated token 401s and the bound credential is never tried.
    // Keep it as an explicit alternative so the probe can fall back to it.
    const configToken = configPath === undefined ? undefined : readServerBlock(configPath)?.authToken;
    const fallbackToken =
      configToken !== undefined && configToken !== token ? configToken : undefined;
    for (const candidateHost of dialFallback === undefined ? [dialHost] : [dialHost, dialFallback]) {
      if (
        candidates.some(
          (c) =>
            c.host === candidateHost &&
            c.port === dialPort &&
            c.token === token &&
            // The BOUND credential is part of the identity too: when a gateway
            // token wins for both, two configs on one endpoint resolve the same
            // primary token but carry different fallbacks, and dropping the
            // second would leave the daemon's real credential untried.
            c.fallbackToken === fallbackToken &&
            // So is the UNIT the credential is re-read from per request: two
            // units can agree today and diverge on the next rotation.
            c.authTokenUnit?.unitPath === authTokenUnit?.unitPath &&
            // And so is the CONFIG, for the same reason: `daemonConfigPath` is
            // re-read per request, so collapsing two configs that agree today
            // would keep sending the retained one's token after the other
            // rotates.
            c.configPath === configPath,
        )
      ) {
        continue;
      }
      candidates.push({
        host: candidateHost,
        port: dialPort,
        configPath,
        token,
        aliasGroup: `${resolvedHost}\u0000${dialPort}\u0000${configPath ?? ""}\u0000${token}`,
        ...(authTokenOverride === undefined ? {} : { authTokenOverride }),
        ...(authTokenUnit === undefined ? {} : { authTokenUnit }),
        ...(fallbackToken === undefined ? {} : { fallbackToken }),
      });
    }
  };
  const configOrder = configPathCandidates();
  const envConfigPath = readCompatEnv("REMNIC_CONFIG_PATH", "ENGRAM_CONFIG_PATH")
    ? configOrder[0]
    : undefined;
  const addConfigCandidate = (candidate: string): void => {
    const server = readServerBlock(candidate);
    if (server !== undefined) add(server.host, server.port, candidate);
  };
  // THIS process's explicit REMNIC_CONFIG_PATH is a deliberate operator
  // instruction and outranks everything, including an installed unit.
  if (envConfigPath !== undefined) addConfigCandidate(envConfigPath);
  // Then installed units: each contributes its config's endpoint with the
  // unit's own REMNIC_HOST/REMNIC_PORT merged OVER it, exactly as the server
  // merges its environment over its config file. They rank ahead of cwd/home
  // because they name what the daemon was actually launched with - and every
  // candidate is probed, so a stale one costs one failed probe.
  for (const unit of readServiceEndpoints(unitExists)) {
    const server = unit.configPath === undefined ? {} : (readServerBlock(unit.configPath) ?? {});
    add(
      unit.host ?? server.host,
      unit.port ?? server.port,
      unit.configPath,
      unit.authToken,
      unit.authTokenUnit,
    );
  }
  for (const candidate of configOrder) {
    if (candidate === envConfigPath) continue;
    addConfigCandidate(candidate);
  }
  // The documented default, LAST. A daemon on 127.0.0.1:4318 with no config
  // file at all is the out-of-the-box shape, and explicit `delegate` dials it;
  // `auto` must not miss it and stay embedded on the same corpus. `add`
  // dedupes, so this is a no-op whenever a candidate already named it.
  add(undefined, undefined);
  return candidates;
}

function readConfiguredDaemonHost(): string {
  const envHost = readCompatEnv("REMNIC_HOST", "ENGRAM_HOST");
  if (envHost !== undefined && envHost.trim() !== "") return normalizeDaemonHost(envHost);
  const configHost = readDaemonServerConfig().host;
  return configHost === undefined ? DEFAULT_HOST : normalizeDaemonHost(configHost);
}

/**
 * Read daemon port from environment or remnic config.
 */
function readDaemonPort(): number {
  const envPort = coerceDaemonPort(readCompatEnv("REMNIC_PORT", "ENGRAM_PORT"));
  if (envPort !== undefined) return envPort;
  return readDaemonServerConfig().port ?? DEFAULT_PORT;
}

export type BridgeModeRequest = BridgeMode | "auto";

export function detectDaemonBridgeMode(options: {
  memoryDir: string;
  timeoutMs?: number;
  onSkip?: (reason: string) => void;
  unitExists?: (candidate: string) => boolean;
}): BridgeConfig {
  const endpoints = daemonEndpointCandidates(options.unitExists);
  // The first candidate is what an explicit `delegate` would dial, so it is
  // also what an embedded result reports.
  const primary =
    endpoints[0] ?? { host: readDaemonHost(), port: readDaemonPort(), token: "" };
  const embedded: BridgeConfig = {
    mode: "embedded",
    daemonHost: primary.host,
    daemonPort: primary.port,
    ...(primary.configPath === undefined ? {} : { daemonConfigPath: primary.configPath }),
    ...(primary.authTokenOverride === undefined
      ? {}
      : { daemonAuthTokenOverride: primary.authTokenOverride }),
    ...(primary.authTokenUnit === undefined ? {} : { daemonAuthUnit: primary.authTokenUnit }),
  };

  if (options.memoryDir.trim() === "") {
    throw new Error("detectDaemonBridgeMode requires a non-empty memoryDir to verify the daemon corpus");
  }
  const totalTimeoutMs = assertProbeBudget(options.timeoutMs);
  const deadline = Date.now() + totalTimeoutMs;
  // Partition BEFORE budgeting. A candidate rejected for being non-loopback,
  // or for having no liveness hint, costs no time at all — leaving it in the
  // divisor would shrink the share for the real probes behind it, and a
  // warming daemon could be misread as absent well inside the total budget.
  const probeable: DaemonEndpointCandidate[] = [];
  for (const candidate of endpoints) {
    // Auto is SAME-HOST detection. A matching absolute memoryDir string proves
    // nothing across machines — an unrelated remote daemon using the same
    // conventional path would silently capture every recall and write — and the
    // premise that the plugin may read the corpus locally only holds on one
    // host. Explicit `delegate` may still target a remote daemon; `auto` may not.
    if (!isLoopbackDaemonHost(candidate.host)) {
      options.onSkip?.(
        `daemon endpoint ${candidate.host}:${candidate.port} is not loopback; auto only delegates to a same-host daemon`,
      );
      continue;
    }
    if (!isDaemonRunning() && !shouldProbeDaemonHealth(candidate.host)) {
      options.onSkip?.("no daemon PID, service unit, or local endpoint to probe");
      continue;
    }
    probeable.push(candidate);
  }
  const groupDeadlines = new Map<string, number>();
  const totalGroups = new Set(probeable.map((candidate) => candidate.aliasGroup)).size;
  for (const {
    host: daemonHost,
    port: daemonPort,
    configPath,
    authTokenOverride,
    authTokenUnit,
    fallbackToken,
    aliasGroup,
  } of probeable) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      options.onSkip?.(
        `preflight budget of ${totalTimeoutMs}ms is spent; ${daemonHost}:${daemonPort} was not probed`,
      );
      break;
    }
    const started = groupDeadlines.get(aliasGroup);
    if (started === undefined) {
      const perGroupMs = Math.max(
        1,
        Math.ceil(remainingMs / Math.max(1, totalGroups - groupDeadlines.size)),
      );
      groupDeadlines.set(aliasGroup, Date.now() + Math.min(remainingMs, perGroupMs));
    }
    const candidateDeadline = groupDeadlines.get(aliasGroup) ?? Date.now();
    const firstAttemptMs = candidateDeadline - Date.now();
    if (firstAttemptMs <= 0) {
      options.onSkip?.(
        `preflight budget of ${totalTimeoutMs}ms is spent; ${daemonHost}:${daemonPort} was not probed`,
      );
      continue;
    }
    let usedToken = authTokenOverride;
    let health = readDaemonMemoryDirSync(
      daemonHost,
      daemonPort,
      firstAttemptMs,
      configPath,
      usedToken,
    );
    if (health.rejectedAuth === true && fallbackToken !== undefined) {
      const retryMs = candidateDeadline - Date.now();
      if (retryMs > 0) {
        usedToken = fallbackToken;
        health = readDaemonMemoryDirSync(daemonHost, daemonPort, retryMs, configPath, usedToken);
      }
    }
    if (!health.healthy) {
      const reason =
        health.failure === "auth"
          ? `daemon authentication failed at ${daemonHost}:${daemonPort} using ${health.authSource ?? "the configured credential"}`
          : health.failure === "http"
            ? `daemon health at ${daemonHost}:${daemonPort} returned an HTTP error; no healthy daemon`
            : `daemon network probe failed at ${daemonHost}:${daemonPort}; no healthy daemon`;
      options.onSkip?.(reason);
      continue;
    }
    if (health.memoryDir === undefined) {
      options.onSkip?.(
        `daemon at ${daemonHost}:${daemonPort} did not report a memoryDir, so its corpus cannot be confirmed`,
      );
      continue;
    }
    if (!daemonServesCorpus(options.memoryDir, health.memoryDir)) {
      options.onSkip?.(
        `daemon at ${daemonHost}:${daemonPort} serves a different memoryDir than this plugin`,
      );
      continue;
    }
    return {
      mode: "delegate",
      daemonHost,
      daemonPort,
      healthVerified: true,
      ...(configPath === undefined ? {} : { daemonConfigPath: configPath }),
      ...(usedToken !== undefined && usedToken === authTokenOverride
        ? {
            daemonAuthTokenOverride: usedToken,
            ...(authTokenUnit === undefined ? {} : { daemonAuthUnit: authTokenUnit }),
          }
        : {}),
      ...(usedToken !== undefined && usedToken === fallbackToken
        ? { daemonAuthPrefersConfig: true }
        : {}),
    };
  }
  return embedded;
}

export function resolveRequestedBridgeMode(configBridgeMode: string): BridgeModeRequest {
  const envMode = readCompatEnv("REMNIC_BRIDGE_MODE", "ENGRAM_BRIDGE_MODE")?.toLowerCase();
  const isRequest = (value: string): value is BridgeModeRequest =>
    value === "embedded" || value === "delegate" || value === "auto";
  if (envMode !== undefined && envMode !== "") {
    if (!isRequest(envMode)) {
      throw new Error(
        `Invalid REMNIC_BRIDGE_MODE env override: ${envMode} (expected "embedded", "delegate", or "auto")`,
      );
    }
    return envMode;
  }
  if (configBridgeMode === undefined || configBridgeMode === "") return "embedded";
  if (isRequest(configBridgeMode)) return configBridgeMode;
  throw new Error(
    `Invalid bridgeMode: ${String(configBridgeMode)} (expected "embedded", "delegate", or "auto")`,
  );
}

/**
 * @deprecated Use {@link resolveBridgeMode} (explicit config/env) or
 * {@link detectDaemonBridgeMode} (`auto` same-host detection). Kept so an
 * existing consumer keeps importing after upgrading (AGENTS.md §11).
 *
 * Maps onto the current resolution rather than re-implementing the old
 * heuristics, so a caller cannot get a different answer than the plugin does.
 * `auto` needs a corpus to verify against; without a `memoryDir` there is
 * nothing to compare and it stays embedded instead of guessing.
 */
export function detectBridgeMode(options: { memoryDir?: string } = {}): BridgeConfig {
  const requested = resolveRequestedBridgeMode("");
  if (requested === "auto" && !options.memoryDir?.trim()) {
    return { mode: "embedded", daemonHost: readDaemonHost(), daemonPort: readDaemonPort() };
  }
  return resolveBridgeMode("", options);
}

export function requestedDelegate(configBridgeMode: string): boolean {
  try {
    return resolveRequestedBridgeMode(configBridgeMode) !== "embedded";
  } catch {
    return true;
  }
}

export function resolveBridgeMode(
  configBridgeMode: string,
  options: { memoryDir?: string; timeoutMs?: number; onSkip?: (reason: string) => void } = {},
): BridgeConfig {
  const requested = resolveRequestedBridgeMode(configBridgeMode);
  assertProbeBudget(options.timeoutMs);
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
  const selectedConfig = selectedDaemonConfigPath();
  const configuredHost = readConfiguredDaemonHost();
  const fallbackHost = sameHostDialFallback(configuredHost);
  return {
    mode: requested,
    daemonHost: loopbackForSameHost(configuredHost) ?? configuredHost,
    daemonPort: readDaemonPort(),
    ...(fallbackHost === undefined ? {} : { daemonHostFallback: fallbackHost }),
    ...(selectedConfig === undefined ? {} : { daemonConfigPath: selectedConfig }),
  };
}

export function readDaemonConfigAuthToken(configPath: string): string | undefined {
  return readServerBlock(configPath)?.authToken;
}

function selectedDaemonConfigPath(): string | undefined {
  for (const candidate of configPathCandidates()) {
    if (readServerBlock(candidate) !== undefined) return candidate;
  }
  return undefined;
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

const daemonAuthKey = (source: DaemonAuthTokenSource, token: string): string =>
  `${source}\0${token}`;

export function loadDaemonAuth(
  configPath?: string,
  excludedSources?: ReadonlySet<string>,
): DaemonAuthToken {
  const excluded = (source: DaemonAuthTokenSource, token: string): boolean =>
    excludedSources?.has(source) === true || excludedSources?.has(daemonAuthKey(source, token)) === true;
  const environmentTokens = [
    ["OPENCLAW_REMNIC_ACCESS_TOKEN", readEnv("OPENCLAW_REMNIC_ACCESS_TOKEN")],
    ["REMNIC_AUTH_TOKEN", readEnv("REMNIC_AUTH_TOKEN")],
    ["OPENCLAW_ENGRAM_ACCESS_TOKEN", readEnv("OPENCLAW_ENGRAM_ACCESS_TOKEN")],
    ["ENGRAM_AUTH_TOKEN", readEnv("ENGRAM_AUTH_TOKEN")],
  ] as const;
  for (const [source, token] of environmentTokens) {
    if (token && !excluded(source, token)) return { token, source };
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
      if (
        typeof openClawToken === "string" &&
        openClawToken.length > 0 &&
        !excluded(tokenStore.source, openClawToken)
      ) {
        return { token: openClawToken, source: tokenStore.source };
      }
      if (
        typeof store === "object" &&
        store !== null &&
        "openclaw" in store &&
        typeof store.openclaw === "string" &&
        store.openclaw.length > 0 &&
        (store.openclaw.startsWith("remnic_") || store.openclaw.startsWith("engram_")) &&
        !excluded(tokenStore.source, store.openclaw)
      ) {
        return { token: store.openclaw, source: tokenStore.source };
      }
    } catch {
      continue;
    }
  }

  for (const candidate of configPath === undefined ? configPathCandidates() : [configPath]) {
    if (!fileExists(candidate)) continue;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(candidate, "utf8"));
      const server = (raw as { server?: { authToken?: unknown } } | null)?.server;
      const token = server?.authToken;
      if (
        typeof token === "string" &&
        token.length > 0 &&
        !excluded("daemon configuration", token)
      ) {
        return { token, source: "daemon configuration" };
      }
    } catch {
      continue;
    }
    // A readable config with no token IS the answer for a bound path: the
    // daemon it describes runs unauthenticated.
    if (configPath !== undefined) break;
  }
  return { token: "", source: "no configured token" };
}

function classifyDaemonHealthStatus(
  status: number | undefined,
  tokenSource: DaemonAuthTokenSource,
): DaemonHealthResult {
  if (status === 200) return { ok: true };
  if (status === 401 || status === 403) {
    return { ok: false, failure: "auth", status, tokenSource };
  }
  if (status === undefined) return { ok: false, failure: "network" };
  return { ok: false, failure: "http", status };
}

export async function checkDaemonHealthDetailed(
  host: string,
  port: number,
  timeoutMs = DEFAULT_DAEMON_HEALTH_TIMEOUT_MS,
): Promise<DaemonHealthResult> {
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, failure: "network" };
  }
  const deadline = Date.now() + timeoutMs;
  try {
    const { request } = await import("node:http");
    let auth = loadDaemonAuth();
    const fallbackAuth =
      auth.token === ""
        ? undefined
        : loadDaemonAuth(undefined, new Set<DaemonAuthTokenSource>([auth.source]));

    const probe = (requestPath: string, token: string): Promise<number | undefined> =>
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
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;
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

    const probeWithFallback = async (requestPath: string): Promise<number | undefined> => {
      let status = await probe(requestPath, auth.token);
      if ((status === 401 || status === 403) && fallbackAuth?.token && fallbackAuth.token !== auth.token) {
        auth = fallbackAuth;
        status = await probe(requestPath, auth.token);
      }
      return status;
    };
    const livenessStatus = await probeWithFallback(LIVENESS_PATH);
    if (livenessStatus === 200) return { ok: true };
    if (livenessStatus !== 404) return classifyDaemonHealthStatus(livenessStatus, auth.source);
    return classifyDaemonHealthStatus(
      await probeWithFallback(LEGACY_HEALTH_PATH),
      auth.source,
    );
  } catch {
    return { ok: false, failure: "network" };
  }
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
  return (await checkDaemonHealthDetailed(host, port, timeoutMs)).ok;
}
