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
import os from "node:os";
import { isIP, isIPv6 } from "node:net";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { configPathCandidates, readCompatEnv } from "@remnic/core";
import { isLoopbackHost } from "@remnic/core/runtime/http-transport.js";

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

/**
 * One endpoint `auto` may dial, plus the config file it came from — the
 * credential tier is bound to that file so a second daemon's token cannot be
 * sent to the first.
 */
interface DaemonEndpointCandidate {
  host: string;
  port: number;
  configPath?: string;
  /** Resolved once at discovery so dedupe can compare credentials. */
  token: string;
  /**
   * A credential the unit file supplies directly, which outranks anything the
   * config path resolves to. Carried onto `BridgeConfig` so delegate requests
   * keep using the token the probe authenticated with.
   */
  authTokenOverride?: string;
  /** The unit that supplied `authTokenOverride`, so it can be re-read. */
  authTokenUnit?: DaemonUnitSource;
  /**
   * The credential written in this candidate's own config file, retried when
   * the primary (gateway token store) one is rejected.
   */
  fallbackToken?: string;
}

export interface BridgeConfig {
  mode: BridgeMode;
  daemonHost: string;
  daemonPort: number;
  /**
   * The configured interface address behind a same-host loopback rewrite,
   * dialed only when the loopback probe fails: a daemon bound to exactly that
   * address answers no loopback dial.
   */
  daemonHostFallback?: string;
  /**
   * True when this resolution already proved the daemon healthy. `auto` does,
   * as part of its corpus-identity probe; explicit `delegate` does not. Lets
   * the caller skip a second liveness request that would otherwise let a
   * synchronous registration spend twice the configured preflight budget.
   */
  healthVerified?: boolean;
  /**
   * The config file the resolved endpoint came from, when discovery found one.
   * Delegate requests bind their credential tier to it, so a deployment with
   * two configs sends each daemon its OWN token.
   */
  daemonConfigPath?: string;
  /**
   * A credential taken from the installed unit's environment, which the
   * gateway does not inherit and no config file carries. Delegate requests
   * must use it or they authenticate as a different daemon would.
   *
   * Only for values with no other source. A credential that came from a CONFIG
   * FILE is signalled by {@link daemonAuthPrefersConfig} instead, so a rotated
   * token is re-read rather than frozen at detection time.
   */
  daemonAuthTokenOverride?: string;
  /**
   * The unit `daemonAuthTokenOverride` came from. Delegate requests re-read it
   * per request, so rotating the token in the unit (or its drop-in, or its
   * `EnvironmentFile=`) and restarting the daemon does not 401 every route
   * until the gateway restarts too.
   */
  daemonAuthUnit?: DaemonUnitSource;
  /**
   * The probe authenticated with `daemonConfigPath`'s own `server.authToken`
   * rather than the gateway token store. Delegate requests must make the same
   * choice — but by RE-READING that file each time, so rotating the token does
   * not 401 every route until the gateway restarts.
   */
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

/** Everything a delegate-mode request needs to reach the standalone daemon. */
export interface DelegateDaemonTarget {
  host: string;
  port: number;
  resolveAuthToken: () => DaemonAuthToken;
  /** Drop a credential after a 401 so the next resolver call can fall back. */
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

/**
 * Validate a caller-supplied probe budget, in the same range the config
 * parser enforces. Shared so the public detector cannot drift from it.
 */
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

/**
 * Whether a daemon endpoint names THIS host.
 *
 * Address classification is the shared core helper (`isLoopbackHost`), so
 * `0:0:0:0:0:0:0:1`, `::1`, `::ffff:127.0.0.1`, and `127.x` all resolve
 * alike here and everywhere else — comparing raw strings would leave `auto`
 * embedded beside a reachable same-host daemon just because its config
 * spelled the address differently.
 *
 * A wildcard bind or an address assigned to one of this host's interfaces
 * names every interface on this host, so it counts as local —
 * `server.host: "0.0.0.0"` is the documented daemon configuration.
 */
export function isLoopbackDaemonHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (loopbackForSameHost(normalized) !== undefined) return true;
  return isLoopbackHost(normalized);
}

/**
 * Collapse an IPv6 literal to its canonical form, or `undefined` when the
 * string is not one. Node's `net.isIPv6` validates; `URL` canonicalizes.
 */
function canonicalIPv6(value: string): string | undefined {
  if (!isIPv6(value)) return undefined;
  try {
    // The URL parser applies RFC 5952 compression and lowercasing.
    return new URL(`http://[${value}]`).hostname.replace(/^\[/, "").replace(/\]$/, "");
  } catch {
    return value;
  }
}

/**
 * The loopback address a same-host daemon is dialed on, or `undefined` for a
 * host that is not provably this machine.
 *
 * A wildcard bind names every interface on THIS host, not a remote one. The
 * documented `server.host: "0.0.0.0"` daemon config would otherwise be
 * classified as remote — leaving `auto` embedded beside a same-host daemon on
 * the same corpus — and is not a portable destination address either, so it is
 * dialed through the matching loopback.
 *
 * An address assigned to one of this host's own interfaces (a NIC or a VIP the
 * operator exported as `REMNIC_HOST`) is the same case: it names the daemon
 * loopback reaches, and a gateway fetch to such an address has been observed to
 * hang on the connect while loopback answers at once.
 */
export function loopbackForSameHost(host: string): string | undefined {
  const normalized = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (normalized === "0.0.0.0") return DEFAULT_HOST;
  const v6 = canonicalIPv6(normalized);
  if (v6 === "::") return "::1";
  if (isLocalInterfaceAddress(v6 ?? normalized)) return v6 === undefined ? DEFAULT_HOST : "::1";
  return undefined;
}

/**
 * The configured address to retry when a same-host loopback dial fails. Only
 * an interface address qualifies — a wildcard bind is not dialable, and a
 * daemon bound to exactly one interface address answers no loopback dial.
 */
export function sameHostDialFallback(host: string): string | undefined {
  const normalized = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return isLocalInterfaceAddress(canonicalIPv6(normalized) ?? normalized) ? normalized : undefined;
}

function isLocalInterfaceAddress(address: string): boolean {
  if (isIP(address) === 0) return false;
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const assigned =
        entry.family === "IPv6" ? canonicalIPv6(entry.address.replace(/%.*$/, "")) : entry.address;
      if (assigned === address) return true;
    }
  }
  return false;
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
  // Same hazard as the capture probe: a non-finite budget reaches
  // `Atomics.wait` as an unbounded wait on the caller's main thread.
  assertProbeBudget(timeoutMs);
  return probeDaemonSync({
    host,
    port,
    timeoutMs,
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
        ...(authTokenOverride === undefined ? {} : { authTokenOverride }),
        ...(authTokenUnit === undefined ? {} : { authTokenUnit }),
        ...(fallbackToken === undefined ? {} : { fallbackToken }),
      });
    }
  };
  // An env override alone, so a specified environment is dialed first even
  // when no config file exists. Without one this would inject a bare
  // default endpoint AHEAD of every config-derived candidate.
  if ((envHost !== undefined && envHost.trim() !== "") || envPort !== undefined) {
    add(undefined, undefined);
  }
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
  /**
   * Injectable unit-file probe. The SYSTEM unit directories are absolute, so a
   * caller that redirects `HOME` still discovers the real host's installed
   * daemon; tests for the lower-precedence config candidates pass a probe that
   * reports no installed unit.
   */
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

  // `bridgeHealthTimeoutMs` is documented as the TOTAL preflight budget, and
  // registration is synchronous — probing several stale endpoints for the full
  // budget each would hold gateway startup for a multiple of it. Every probe
  // shares one deadline.
  // A library consumer reaches this entry point directly, bypassing the config
  // parser. An invalid budget must be REJECTED, not reinterpreted: zero or a
  // negative silently skips every probe and selects embedded beside a running
  // same-corpus daemon, which is the exact failure this detector exists to
  // prevent (AGENTS.md §1).
  // Same reasoning as the budget: a library consumer reaches this entry point
  // directly. A blank corpus can never match, so the walk would return
  // `embedded` — an invalid required argument dressed up as a mode decision,
  // which binds an embedded runtime beside the daemon the caller meant to find.
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
  let probed = 0;
  for (const {
    host: daemonHost,
    port: daemonPort,
    configPath,
    authTokenOverride,
    authTokenUnit,
    fallbackToken,
  } of probeable) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      options.onSkip?.(
        `preflight budget of ${totalTimeoutMs}ms is spent; ${daemonHost}:${daemonPort} was not probed`,
      );
      break;
    }
    // Cap each probe at a SHARE of what is left rather than handing it the
    // whole budget. Installed-unit candidates deliberately precede cwd/home,
    // so one stale endpoint that accepts a connection and stalls would
    // otherwise eat the entire preflight and the live daemon behind it would
    // never be dialed. The share is over the endpoints still unprobed, so the
    // last candidate can still use everything that remains.
    const perCandidateMs = Math.max(
      1,
      Math.ceil(remainingMs / Math.max(1, probeable.length - probed)),
    );
    probed += 1;
    // BOTH attempts share this candidate's slice, so one stalling endpoint
    // with a fallback credential cannot burn two shares and starve the healthy
    // daemon behind it. The FIRST attempt gets the whole slice: reserving half
    // for a retry would cut short a daemon that is merely still warming up,
    // and a readiness stall is not something a different token fixes.
    const candidateDeadline = Date.now() + Math.min(remainingMs, perCandidateMs);
    // The clock can cross the deadline between deriving it and spending it —
    // trivially so at the supported minimum budget of 1ms. The public probe
    // REJECTS a non-positive budget, and rightly so, but reaching it with one
    // here would turn an exhausted budget into a thrown configuration error.
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
    // Retry ONLY on an actual authentication rejection, and only with a
    // different credential: the gateway's token store outranks a config file
    // inside `loadDaemonAuth`, which is wrong for a daemon running under
    // another account with a static `server.authToken`.
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
      // A unit-supplied credential has no other source, so it is carried by
      // value; a config-supplied one is re-read from its file per request.
      ...(usedToken !== undefined && usedToken === authTokenOverride
        ? {
            daemonAuthTokenOverride: usedToken,
            // The unit rides along so the credential can be re-read per
            // request; the frozen value stays as the fallback for a unit that
            // later becomes unreadable.
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

/**
 * The mode the deployment ASKED for, without probing anything.
 *
 * Split out so a caller can tell "delegate was attempted and failed" from
 * "this deployment is embedded and something unrelated is misconfigured" —
 * only the former is a fallback worth recording.
 */
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

/**
 * Whether this deployment was asking for delegate at all.
 *
 * An unparseable bridgeMode is itself the thing the operator got wrong, so it
 * counts as an attempt: only a deployment that clearly said `embedded` has
 * nothing to fall back FROM.
 */
export function requestedDelegate(configBridgeMode: string): boolean {
  try {
    return resolveRequestedBridgeMode(configBridgeMode) !== "embedded";
  } catch {
    return true;
  }
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
  const requested = resolveRequestedBridgeMode(configBridgeMode);
  // Validated for EVERY mode, not just the branch that spends it: an invalid
  // budget is a caller bug, and accepting it silently on an explicit mode
  // would make the same value an error only after someone flips to `auto`.
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
  // The config the endpoint came from rides along so delegate requests bind
  // their credential to the SAME file. Without it `loadDaemonAuth` rescans and
  // can pair this endpoint with another file's token, which the daemon answers
  // with a 401 and the plugin reads as "no daemon".
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

/**
 * The `server.authToken` a specific config file declares, read fresh.
 *
 * Delegate requests call this per request rather than reusing the value
 * detection succeeded with, so rotating the daemon's token does not 401 every
 * route until the gateway restarts.
 */
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

  // Bound to the caller's config when given, else the discovery order.
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
      // Unreadable or malformed: it names no credential. Keep looking when we
      // are scanning; a caller-bound path simply has none.
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
