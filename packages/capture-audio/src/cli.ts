/**
 * `remnic-capture-audio` CLI. Subcommands: init, start, stop, status,
 * devices, logs. `start --replay <dir>` feeds synthetic fixtures through
 * the spool + HTTP API (the CI-friendly, hardware-free path). Native
 * device enumeration and real capture arrive in later checklist items;
 * `devices` reports that honestly rather than faking a device list.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { CAPTURE_AUDIO_VERSION } from "./constants.js";
import { coerceNumber } from "./coerce.js";
import {
  defaultDaemonConfig,
  loadDaemonConfig,
  serializeDaemonConfig,
  type DaemonConfig,
} from "./config.js";
import {
  isProcessAlive,
  readPidRecord,
  removePidFile,
  removePidFileIfOwner,
  writePidFile,
  type PidRecord,
} from "./control.js";
import { startDaemon, type DaemonHandle } from "./daemon.js";
import { CaptureConfigError, CaptureInputError } from "./errors.js";
import { capturePaths, captureBaseDir, expandTilde, type CapturePaths } from "./paths.js";
import { ingestReplayDir } from "./replay.js";
import { Spool } from "./spool.js";
import { loadOrCreateToken } from "./token.js";
import { formatHostForUrl, isLoopbackHost } from "./util.js";

export interface CliIo {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Flags that consume the next argv token as their value. */
const VALUE_FLAGS: Record<string, true> = {
  replay: true,
  host: true,
  port: true,
  listen: true,
  "base-dir": true,
  lines: true,
};

/** Standalone boolean flags. Any other `--flag` is rejected loudly. */
/** How long background start waits for the child daemon to bind before failing. */
const READINESS_TIMEOUT_MS = 10_000;

const BOOLEAN_FLAGS: Record<string, true> = {
  foreground: true,
  force: true,
  help: true,
};

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let i = 0;
  const command = argv[0] && !argv[0].startsWith("-") ? argv[(i = 1) - 1] : "help";
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (Object.hasOwn(VALUE_FLAGS, key)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new CaptureInputError(`flag --${key} requires a value`);
        }
        flags[key] = next;
        i += 1;
      } else if (Object.hasOwn(BOOLEAN_FLAGS, key)) {
        flags[key] = true;
      } else {
        throw new CaptureInputError(`unknown flag --${key}`);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command, positionals, flags };
}

function resolvePaths(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv): CapturePaths {
  const baseDir =
    typeof flags["base-dir"] === "string"
      ? captureBaseDir({ ...env, REMNIC_CAPTURE_DIR: flags["base-dir"] })
      : captureBaseDir(env);
  return capturePaths(baseDir);
}

function loadConfigOrDefault(paths: CapturePaths, stderr: (line: string) => void): DaemonConfig {
  if (existsSync(paths.configPath)) return loadDaemonConfig(paths.configPath);
  stderr(`no config at ${paths.configPath}; using defaults (run \`init\` to customize)`);
  return defaultDaemonConfig();
}

function applyBindingOverrides(
  config: DaemonConfig,
  flags: Record<string, string | boolean>,
): DaemonConfig {
  const next = { ...config };
  if (typeof flags.listen === "string") {
    const idx = flags.listen.lastIndexOf(":");
    if (idx <= 0) throw new CaptureInputError(`--listen expects host:port, got '${flags.listen}'`);
    next.host = flags.listen.slice(0, idx);
    next.port = coerceNumber(flags.listen.slice(idx + 1), "--listen port", { integer: true, min: 1, max: 65535 });
  }
  if (typeof flags.host === "string") next.host = flags.host;
  if (typeof flags.port === "string") {
    next.port = coerceNumber(flags.port, "--port", { integer: true, min: 1, max: 65535 });
  }
  return next;
}

function healthUrlFor(host: string, port: number): string {
  return `http://${formatHostForUrl(host)}:${port}/v1/health`;
}

/**
 * Health URL for the running daemon: prefer the effective binding persisted
 * in the pid record, falling back to on-disk config. This lets status/stop
 * reach a daemon started with --host/--port/--listen even when the config
 * file on disk says something else.
 */
function recordHealthUrl(record: PidRecord, paths: CapturePaths, stderr: (l: string) => void): string {
  if (record.host !== null && record.port !== null) return healthUrlFor(record.host, record.port);
  const config = loadConfigOrDefault(paths, stderr);
  return healthUrlFor(config.host, config.port);
}

function tokenHeader(paths: CapturePaths): Record<string, string> {
  if (!existsSync(paths.tokenPath)) return {};
  return { authorization: `Bearer ${readFileSync(paths.tokenPath, "utf8").trim()}` };
}

/** Create the capture dir owner-only (transcript spool + token live here). */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // filesystem without POSIX perms
  }
}

/** Operator-safe error description — never echoes foreign message text/paths. */
function describeError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (typeof code === "string" && code) return code;
  return err instanceof Error ? err.name : "unknown error";
}

interface DaemonIdentity {
  instanceId: string;
  pid: number;
}

/** Authenticated health probe; returns the serving daemon's identity or null. */
async function probeIdentity(paths: CapturePaths, url: string): Promise<DaemonIdentity | null> {
  try {
    const res = await fetch(url, { headers: tokenHeader(paths), signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { instanceId?: unknown; pid?: unknown };
    if (typeof body.instanceId === "string" && typeof body.pid === "number") {
      return { instanceId: body.instanceId, pid: body.pid };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist the background child's pid record; if that write fails, terminate the
 * child so a spawned-but-unrecorded daemon is never orphaned. Returns false
 * (child killed) on failure.
 */
export function recordChildPidOrTerminate(
  pid: number,
  paths: CapturePaths,
  binding: { host: string; port: number },
  stderr: (l: string) => void,
): boolean {
  try {
    writePidFile(paths.pidPath, pid, binding);
    return true;
  } catch (err) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
    stderr(`failed to record daemon pid: ${describeError(err)}; terminated child pid ${pid}`);
    return false;
  }
}

/**
 * True when the recorded pid is (as far as we can tell) our daemon.
 * Without a recorded instanceId we cannot verify, so we conservatively
 * assume yes and refuse to double-start. With an instanceId we treat the
 * pid as a reused stranger only on a CONFIRMED mismatch from its health
 * endpoint; an unreachable probe stays conservative so we never race a new
 * daemon onto a port a live one may still hold.
 */
async function isOwnRunningDaemon(
  record: PidRecord,
  paths: CapturePaths,
  stderr: (l: string) => void,
): Promise<boolean> {
  if (record.instanceId === null) return true;
  const live = await probeIdentity(paths, recordHealthUrl(record, paths, stderr));
  if (live === null) return true;
  return live.instanceId === record.instanceId && live.pid === record.pid;
}

/**
 * Run replay ingestion as a supervised task AFTER the daemon is ready. Never
 * throws: success/failure is surfaced via the spool's `replay_status` meta
 * (also exposed on /v1/health) and the daemon log, so a failed or slow replay
 * never kills the daemon or retracts its readiness.
 */
export async function superviseReplay(
  spool: Spool,
  replayDir: string,
  io: { stdout: (l: string) => void; stderr: (l: string) => void },
): Promise<void> {
  // Yield first so the caller returns to serving before the (synchronous)
  // ingest runs — readiness is already established.
  await Promise.resolve();
  spool.setMeta("replay_status", "running");
  try {
    const summary = ingestReplayDir(spool, replayDir);
    spool.setMeta("replay_status", "ok");
    io.stdout(
      `replay: ingested ${summary.conversationsIngested} conversation(s), ` +
        `${summary.segmentsIngested} segment(s) from ${summary.files} fixture file(s)`,
    );
  } catch (err) {
    const message =
      err instanceof CaptureConfigError || err instanceof CaptureInputError ? err.message : describeError(err);
    spool.setMeta("replay_status", `failed: ${message}`);
    io.stderr(`replay ingestion failed: ${message}`);
  }
}

function cmdInit(paths: CapturePaths, flags: Record<string, string | boolean>, stdout: (l: string) => void): number {
  ensurePrivateDir(paths.baseDir);
  if (existsSync(paths.configPath) && flags.force !== true) {
    stdout(`config already exists at ${paths.configPath} (use --force to overwrite)`);
  } else {
    writeFileSync(paths.configPath, serializeDaemonConfig(defaultDaemonConfig()), "utf8");
    stdout(`wrote default config to ${paths.configPath}`);
  }
  const token = loadOrCreateToken(paths.tokenPath);
  stdout(`token ready at ${paths.tokenPath} (${token.length} chars, mode 0600)`);
  stdout(`spool will be created at ${paths.spoolPath} on first start`);
  return 0;
}

async function cmdStart(
  paths: CapturePaths,
  flags: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv,
  stdout: (l: string) => void,
  stderr: (l: string) => void,
): Promise<number> {
  const config = applyBindingOverrides(loadConfigOrDefault(paths, stderr), flags);
  if (!isLoopbackHost(config.host)) {
    stderr(
      `refusing to bind non-loopback host '${config.host}': capture-audio serves plain HTTP with no TLS contract; ` +
        "use a loopback address (127.0.0.1 or ::1)",
    );
    return 1;
  }
  const replayDir = typeof flags.replay === "string" ? expandTilde(flags.replay) : null;
  const previousRecord = readPidRecord(paths.pidPath);
  if (previousRecord !== null) {
    if (isProcessAlive(previousRecord.pid) && (await isOwnRunningDaemon(previousRecord, paths, stderr))) {
      stdout(`daemon already running (pid ${previousRecord.pid})`);
      return 0;
    }
    // pid is gone, or a different process reused it -> reclaim the stale file.
    removePidFile(paths.pidPath);
  }

  if (flags.foreground !== true) {
    const entry = process.argv[1];
    const forwarded = ["start", "--foreground"];
    if (replayDir) forwarded.push("--replay", replayDir);
    if (typeof flags["base-dir"] === "string") forwarded.push("--base-dir", flags["base-dir"]);
    if (typeof flags.host === "string") forwarded.push("--host", flags.host);
    if (typeof flags.port === "string") forwarded.push("--port", flags.port);
    if (typeof flags.listen === "string") forwarded.push("--listen", flags.listen);
    ensurePrivateDir(paths.baseDir);
    const logFd = openSync(paths.logPath, "a");
    const child = spawn(process.execPath, [entry, ...forwarded], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, ...env },
    });
    child.on("error", (err) => stderr(`daemon failed to launch: ${describeError(err)}`));
    child.unref();
    if (typeof child.pid !== "number") {
      stderr("failed to spawn daemon process");
      return 1;
    }
    // Record pid + effective binding now; the child adds instanceId once bound.
    // If persistence fails, kill the child so it isn't orphaned unrecorded.
    if (!recordChildPidOrTerminate(child.pid, paths, { host: config.host, port: config.port }, stderr)) {
      return 1;
    }
    // Do not report success until the child actually binds: it writes an
    // instanceId into the pid record only after the HTTP server is listening.
    const deadline = Date.now() + READINESS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!isProcessAlive(child.pid)) {
        removePidFileIfOwner(paths.pidPath, child.pid);
        stderr(`daemon exited during startup; see ${paths.logPath}`);
        return 1;
      }
      if (readPidRecord(paths.pidPath)?.instanceId) {
        stdout(`started daemon (pid ${child.pid}); listening; logs at ${paths.logPath}`);
        return 0;
      }
      await delay(100);
    }
    // Readiness timed out: the child never bound. Terminate it and fail loudly
    // so automation never observes a false success.
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      // already gone
    }
    removePidFileIfOwner(paths.pidPath, child.pid);
    stderr(
      `daemon did not become ready within ${READINESS_TIMEOUT_MS / 1000}s; terminated pid ${child.pid}. See ${paths.logPath}.`,
    );
    return 1;
  }

  ensurePrivateDir(paths.baseDir);
  const token = loadOrCreateToken(paths.tokenPath);
  const spool = new Spool(paths.spoolPath);
  let handle: DaemonHandle;
  try {
    // Bind and report the HTTP service FIRST so daemon readiness is independent
    // of replay volume.
    handle = await startDaemon({ spool, config, token, capturing: false });
  } catch (err) {
    // Don't leak the spool handle if the bind fails.
    spool.close();
    throw err;
  }
  writePidFile(paths.pidPath, process.pid, {
    instanceId: spool.meta("instance_id"),
    host: handle.host,
    port: handle.port,
  });
  stdout(`listening on ${handle.url}`);
  if (replayDir) {
    // Supervised AFTER readiness: replay volume/failure never delays or fails
    // readiness, and never kills the daemon.
    void superviseReplay(spool, replayDir, { stdout, stderr });
  }

  return await new Promise<number>((resolve) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      spool.finalizeOpenConversations();
      // Cleanup must run whether close resolves or rejects — a rejected
      // close must not become an unhandled rejection.
      handle
        .close()
        .catch(() => undefined)
        .finally(() => {
          spool.close();
          removePidFileIfOwner(paths.pidPath, process.pid);
          resolve(0);
        });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function cmdStop(
  paths: CapturePaths,
  flags: Record<string, string | boolean>,
  stdout: (l: string) => void,
  stderr: (l: string) => void,
): Promise<number> {
  const record = readPidRecord(paths.pidPath);
  if (record === null || !isProcessAlive(record.pid)) {
    removePidFile(paths.pidPath);
    stdout("daemon not running");
    return 0;
  }
  // Identity guard: when we know which instance owns the pid, confirm the
  // live process really is that daemon before signalling.
  if (record.instanceId !== null) {
    const live = await probeIdentity(paths, recordHealthUrl(record, paths, stderr));
    if (live !== null && (live.instanceId !== record.instanceId || live.pid !== record.pid)) {
      // Verified NOT the recorded process: the daemon answering this endpoint
      // reports a different instance id or pid than the record. Never signal an
      // unverified pid, and never reclaim before a safe stop — either could kill
      // an unrelated process or orphan the serving daemon. --force does not
      // override a verified mismatch.
      stderr(
        `recorded pid ${record.pid} does not match the daemon serving this endpoint (identity/pid mismatch); ` +
          `not signalling and preserving ${paths.pidPath}. Stop the serving daemon via its own controls, ` +
          `or remove the pid file after verifying it is stale.`,
      );
      return 1;
    }
    if (live === null && flags.force !== true) {
      // Cannot confirm identity (health unreachable): refuse to signal a pid we
      // can't prove is ours, unless the operator forces it.
      stderr(
        `cannot confirm daemon identity for pid ${record.pid} (health unreachable); not signalling. ` +
          `Re-run \`stop --force\` to stop it anyway, or remove ${paths.pidPath}.`,
      );
      return 1;
    }
  } else if (flags.force !== true) {
    // No recorded instance id -> identity is unverifiable; refuse to signal a
    // pid we can't prove is ours (guards against PID reuse) unless forced.
    stderr(
      `cannot verify daemon identity for pid ${record.pid} (no recorded instance id); not signalling. ` +
        `Re-run \`stop --force\` to stop it anyway, or remove ${paths.pidPath}.`,
    );
    return 1;
  }
  try {
    process.kill(record.pid, "SIGTERM");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      removePidFile(paths.pidPath);
      stdout("daemon not running");
      return 0;
    }
    if (code === "EPERM") {
      stderr(`daemon (pid ${record.pid}) is running but not controllable from this user`);
      return 1;
    }
    throw err;
  }
  // The daemon's own shutdown handler removes the pid file once it has
  // finalized conversations and released the spool/socket — don't delete
  // it here (valid state must survive until replacement is confirmed).
  stdout(`sent SIGTERM to daemon (pid ${record.pid}); waiting for shutdown`);
  return 0;
}

async function cmdStatus(
  paths: CapturePaths,
  stdout: (l: string) => void,
  stderr: (l: string) => void,
): Promise<number> {
  const record = readPidRecord(paths.pidPath);
  if (record === null || !isProcessAlive(record.pid)) {
    stdout("status: not running");
    return 0;
  }
  try {
    const res = await fetch(recordHealthUrl(record, paths, stderr), {
      headers: tokenHeader(paths),
      signal: AbortSignal.timeout(2000),
    });
    const body = await res.text();
    stdout(`status: running (pid ${record.pid}) — HTTP ${res.status} ${body}`);
  } catch (err) {
    stdout(`status: process alive (pid ${record.pid}) but health check failed (${describeError(err)})`);
  }
  return 0;
}

function cmdDevices(stdout: (l: string) => void): number {
  stdout(
    JSON.stringify(
      {
        devices: [],
        note: "device enumeration requires the native capture helper (@remnic/capture-native-*), added in a later phase",
      },
      null,
      2,
    ),
  );
  return 0;
}

function cmdLogs(paths: CapturePaths, flags: Record<string, string | boolean>, stdout: (l: string) => void): number {
  if (!existsSync(paths.logPath)) {
    stdout(`no log file at ${paths.logPath}`);
    return 0;
  }
  const lines = typeof flags.lines === "string" ? coerceNumber(flags.lines, "--lines", { integer: true, min: 1 }) : 200;
  const all = readFileSync(paths.logPath, "utf8").split("\n");
  stdout(all.slice(Math.max(0, all.length - lines)).join("\n"));
  return 0;
}

function usage(stdout: (l: string) => void): number {
  stdout(
    [
      `remnic-capture-audio v${CAPTURE_AUDIO_VERSION}`,
      "usage: remnic-capture-audio <command> [flags]",
      "commands: init | start | stop | status | devices | logs",
      "start flags: --foreground --replay <dir> --host <h> --port <n> --listen <host:port> --base-dir <dir>",
    ].join("\n"),
  );
  return 0;
}

export async function runCapture(io: CliIo): Promise<number> {
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? ((line: string) => console.log(line));
  const stderr = io.stderr ?? ((line: string) => console.error(line));
  try {
    const parsed = parseArgs(io.argv);
    const paths = resolvePaths(parsed.flags, env);
    if (parsed.flags.help === true || parsed.positionals.includes("-h") || parsed.positionals.includes("--help")) {
      return usage(stdout);
    }
    if (parsed.positionals.length > 0) {
      stderr(`unexpected argument(s): ${parsed.positionals.join(" ")}`);
      usage(stderr);
      return 2;
    }
    switch (parsed.command) {
      case "init":
        return cmdInit(paths, parsed.flags, stdout);
      case "start":
        return await cmdStart(paths, parsed.flags, env, stdout, stderr);
      case "stop":
        return await cmdStop(paths, parsed.flags, stdout, stderr);
      case "status":
        return await cmdStatus(paths, stdout, stderr);
      case "devices":
        return cmdDevices(stdout);
      case "logs":
        return cmdLogs(paths, parsed.flags, stdout);
      case "help":
      case "--help":
      case "-h":
        return usage(stdout);
      default:
        stderr(`unknown command '${parsed.command}'`);
        usage(stderr);
        return 2;
    }
  } catch (err) {
    if (err instanceof CaptureConfigError || err instanceof CaptureInputError) {
      stderr(`error: ${err.message}`);
      return err instanceof CaptureInputError ? 2 : 1;
    }
    stderr(`error: ${describeError(err)}`);
    return 1;
  }
}
