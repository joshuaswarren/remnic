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
import { parseConfig, isOpenaiApiKeyDisabled, Orchestrator, EngramAccessService, EngramAccessHttpServer, initLogger, log, getAllValidTokens, getAllValidTokensCached, expandTildePath, type PluginConfig } from "@remnic/core";

// ── Config loading ──────────────────────────────────────────────────────────

export interface ServerConfig {
  remnic: Record<string, unknown>;
  server: {
    host?: string;
    port?: unknown;
    authToken?: string;
    principal?: string;
    maxBodyBytes?: number;
    adminConsoleEnabled?: boolean;
    adminConsolePublicDir?: string;
  };
}

function readCompatEnv(primary: string, legacy: string): string | undefined {
  return process.env[primary] ?? process.env[legacy];
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

export interface ParsedServerConfig {
  host: string;
  port: number;
  authToken?: string;
  principal?: string;
  maxBodyBytes?: number;
  adminConsoleEnabled: boolean;
  adminConsolePublicDir?: string;
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
    adminConsoleEnabled: parseOptionalBoolean(raw.adminConsoleEnabled, "server.adminConsoleEnabled") ?? false,
    adminConsolePublicDir: parseOptionalString(raw.adminConsolePublicDir, "server.adminConsolePublicDir"),
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
  const remnic = requirePlainConfigBlock(raw, "remnic", configPath);
  const engram = requirePlainConfigBlock(raw, "engram", configPath);
  const server = requirePlainConfigBlock(raw, "server", configPath);
  return {
    remnic: remnic ?? engram ?? raw,
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

function envOverrides(): Partial<ServerConfig["server"]> & { remnic?: Record<string, unknown> } {
  const overrides: Record<string, unknown> = {};
  const remnic: Record<string, unknown> = {};

  const port = readCompatEnv("REMNIC_PORT", "ENGRAM_PORT");
  const host = readCompatEnv("REMNIC_HOST", "ENGRAM_HOST");
  const authToken = readCompatEnv("REMNIC_AUTH_TOKEN", "ENGRAM_AUTH_TOKEN");
  if (port) overrides.port = port;
  if (host) overrides.host = host;
  if (authToken) overrides.authToken = authToken;

  if (process.env.OPENAI_API_KEY) remnic.openaiApiKey = process.env.OPENAI_API_KEY;
  const memoryDir = readCompatEnv("REMNIC_MEMORY_DIR", "ENGRAM_MEMORY_DIR");
  if (memoryDir) remnic.memoryDir = memoryDir;

  return { ...overrides, ...(Object.keys(remnic).length > 0 ? { remnic } : {}) };
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

/**
 * Like `setTimeout` wrapped in a Promise, but respects an `AbortSignal`.
 * Resolves immediately (without throwing) when the signal fires so the
 * caller can check `signal.aborted` and exit cleanly.
 */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
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

export async function startServer(options?: {
  configPath?: string;
  host?: string;
  port?: number;
  authToken?: string;
}): Promise<ServerResult> {
  initLogger();

  const resolvedConfigPath = resolveConfigPath(options?.configPath);
  const fileConfig = loadResolvedConfig(resolvedConfigPath);

  const env = envOverrides();
  const { remnic: envRemnic, ...envServer } = env;

  // Merge: file < env < cli flags
  const remnicConfig = mergeRemnicConfigForServer(fileConfig.remnic, envRemnic);
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
  const parsedServerConfig = parseServerConfig(serverConfig, { portSource });

  const config = parseConfig(remnicConfig);
  const orchestrator = new Orchestrator(config);
  await orchestrator.initialize();

  // Start the HTTP server immediately so health checks, MCP handshakes,
  // and liveness probes can connect while deferred init is still running.
  const service = new EngramAccessService(orchestrator);

  const authToken = parsedServerConfig.authToken ?? readCompatEnv("REMNIC_AUTH_TOKEN", "ENGRAM_AUTH_TOKEN") ?? "";

  // Connector tokens are loaded dynamically per request via authTokensGetter
  // so that token generate/revoke takes effect without server restart
  if (!authToken && getAllValidTokens().length === 0) {
    log.warn("No auth token set — server will reject all requests. Set REMNIC_AUTH_TOKEN, server.authToken in config, or generate tokens with 'remnic token generate'.");
  }

  const httpServer = new EngramAccessHttpServer({
    service,
    host: parsedServerConfig.host,
    port: parsedServerConfig.port,
    authToken: authToken || undefined,
    authTokensGetter: () => getAllValidTokensCached(),
    principal: parsedServerConfig.principal,
    maxBodyBytes: parsedServerConfig.maxBodyBytes,
    adminConsoleEnabled: parsedServerConfig.adminConsoleEnabled,
    adminConsolePublicDir: parsedServerConfig.adminConsolePublicDir
      ? path.resolve(expandTildePath(parsedServerConfig.adminConsolePublicDir))
      : undefined,
    citationsEnabled: config.citationsEnabled,
    citationsAutoDetect: config.citationsAutoDetect,
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

  // Wrap httpServer.stop() so that existing callers also get full lifecycle
  // cleanup: retry timers, deferred init, HTTP listener, and orchestrator.
  const originalStop = httpServer.stop.bind(httpServer);
  let stopPromise: Promise<void> | undefined;
  const stop = async (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      startupSyncAbort.abort();
      orchestrator.abortDeferredInit();
      try {
        await originalStop();
      } finally {
        await orchestrator.destroy();
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

        const synced = await orchestrator.startupSearchSync(startupSyncAbort.signal);
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

// ── CLI entry point ──────────────────────────────────────────────────────────

const BOOLEAN_CLI_OPTIONS = new Set(["help"]);
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
  --help              Show this help

Environment:
  REMNIC_CONFIG_PATH   Config file path (ENGRAM_CONFIG_PATH also supported)
  REMNIC_PORT          Server port (ENGRAM_PORT also supported)
  REMNIC_HOST          Bind address (ENGRAM_HOST also supported)
  REMNIC_AUTH_TOKEN    Auth bearer token (ENGRAM_AUTH_TOKEN also supported)
  REMNIC_MEMORY_DIR    Override memory directory (ENGRAM_MEMORY_DIR also supported)
  OPENAI_API_KEY       OpenAI API key for extraction; ignored when config sets openaiApiKey=false
`);
    process.exit(0);
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
