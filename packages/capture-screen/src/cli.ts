/**
 * `remnic-capture-screen` CLI. Subcommands:
 *   init | start | stop | status | install-service | logs | test-snapshot
 *
 * `start --replay <dir>` feeds synthetic fixtures through the full capture
 * pipeline + HTTP API (the CI-friendly, hardware-free path). Live capture needs
 * the native helper (@remnic/capture-native-*); where it is absent the daemon
 * still serves the spool and reports axAvailable/ocrAvailable = false.
 *
 * The bearer token comes from the environment (REMNIC_CAPTURE_TOKEN), never
 * argv: a long-lived daemon's argv is world-readable via `ps`/`/proc`, so a
 * token on the command line would let any local account read captured screen
 * text. `--auth-token` is rejected. When the env var is unset, the token file
 * created by `init` is used instead.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { dirname } from "node:path";

import { CaptureProcessor } from "./capture.js";
import { coerceNumber } from "./coerce.js";
import { CAPTURE_SCREEN_VERSION } from "./constants.js";
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
import { NativeHelper, resolveHelperBinaryPath } from "./helper.js";
import { captureViaHelper } from "./live.js";
import { capturePaths, captureBaseDir, expandTilde, type CapturePaths } from "./paths.js";
import { CaptureScheduler } from "./scheduler.js";
import { ingestReplayDirResponsive } from "./replay.js";
import { Spool } from "./spool.js";
import { loadOrCreateToken } from "./token.js";
import { formatHostForUrl, isLoopbackHost, sanitizeError, stripIpv6Brackets } from "./util.js";

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

const CAPTURE_TOKEN_ENV = "REMNIC_CAPTURE_TOKEN";
/** Legacy alias honored across Remnic (formerly Engram); see README auth note. */
const LEGACY_CAPTURE_TOKEN_ENV = "ENGRAM_CAPTURE_TOKEN";

/** Flags that consume the next argv token as their value. */
const VALUE_FLAGS: Record<string, true> = {
  replay: true,
  host: true,
  port: true,
  listen: true,
  "base-dir": true,
  spool: true,
  lines: true,
};

/** Standalone boolean flags. */
const BOOLEAN_FLAGS: Record<string, true> = {
  foreground: true,
  force: true,
  help: true,
};

/** Non-global flags each subcommand accepts; anything else is rejected. */
const COMMAND_FLAGS: Record<string, Record<string, true>> = {
  init: { force: true },
  start: { foreground: true, replay: true, host: true, port: true, listen: true, spool: true },
  stop: { force: true },
  status: {},
  "install-service": {},
  logs: { lines: true },
  "test-snapshot": {},
  help: {},
};

/** Flags accepted regardless of subcommand. */
const GLOBAL_FLAGS: Record<string, true> = { "base-dir": true, spool: true, help: true };

const READINESS_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 10_000;

function parseArgs(argv: string[]): ParsedArgs {
  const tokens: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (key === "auth-token") {
        throw new CaptureInputError(
          `--auth-token is not accepted; set the ${CAPTURE_TOKEN_ENV} environment variable instead`,
        );
      }
      if (Object.hasOwn(VALUE_FLAGS, key)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) throw new CaptureInputError(`flag --${key} requires a value`);
        flags[key] = next;
        i += 1;
      } else if (Object.hasOwn(BOOLEAN_FLAGS, key)) {
        flags[key] = true;
      } else {
        throw new CaptureInputError(`unknown flag --${key}`);
      }
    } else {
      tokens.push(arg);
    }
  }
  const command = tokens.length > 0 ? tokens[0] : "help";
  return { command, positionals: tokens.slice(1), flags };
}

function resolvePaths(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv): CapturePaths {
  const baseDir =
    typeof flags["base-dir"] === "string"
      ? captureBaseDir({ ...env, REMNIC_CAPTURE_SCREEN_DIR: flags["base-dir"] })
      : captureBaseDir(env);
  const paths = capturePaths(baseDir);
  if (typeof flags.spool === "string") return { ...paths, spoolPath: expandTilde(flags.spool) };
  return paths;
}

function loadConfigOrDefault(paths: CapturePaths, stderr: (line: string) => void): DaemonConfig {
  if (existsSync(paths.configPath)) return loadDaemonConfig(paths.configPath);
  stderr(`no config at ${paths.configPath}; using defaults (run \`init\` to customize)`);
  return defaultDaemonConfig();
}

function applyBindingOverrides(config: DaemonConfig, flags: Record<string, string | boolean>): DaemonConfig {
  const next = { ...config };
  if (typeof flags.listen === "string") {
    const idx = flags.listen.lastIndexOf(":");
    if (idx <= 0) throw new CaptureInputError(`--listen expects host:port, got '${flags.listen}'`);
    next.host = flags.listen.slice(0, idx);
    next.port = coerceNumber(flags.listen.slice(idx + 1), "--listen port", { integer: true, min: 1, max: 65535 });
  }
  if (typeof flags.host === "string") next.host = flags.host;
  if (typeof flags.port === "string") next.port = coerceNumber(flags.port, "--port", { integer: true, min: 1, max: 65535 });
  next.host = stripIpv6Brackets(next.host);
  return next;
}

function healthUrlFor(host: string, port: number): string {
  return `http://${formatHostForUrl(host)}:${port}/v1/health`;
}

function recordHealthUrl(record: PidRecord, paths: CapturePaths, stderr: (l: string) => void): string {
  if (record.host !== null && record.port !== null) return healthUrlFor(record.host, record.port);
  const config = loadConfigOrDefault(paths, stderr);
  return healthUrlFor(config.host, config.port);
}

/** Token for probes/serving: env override first, then the on-disk token file. */
export function resolveToken(paths: CapturePaths, env: NodeJS.ProcessEnv, create: boolean): string {
  const fromEnv = (env[CAPTURE_TOKEN_ENV] ?? env[LEGACY_CAPTURE_TOKEN_ENV])?.trim();
  if (fromEnv) return fromEnv;
  if (create) return loadOrCreateToken(paths.tokenPath);
  if (existsSync(paths.tokenPath)) return readFileSync(paths.tokenPath, "utf8").trim();
  return "";
}

function tokenHeader(paths: CapturePaths, env: NodeJS.ProcessEnv): Record<string, string> {
  const token = resolveToken(paths, env, false);
  return token ? { authorization: `Bearer ${token}` } : {};
}

export function ensurePrivateDir(dir: string): void {
  let isLink = false;
  try {
    isLink = lstatSync(dir).isSymbolicLink();
  } catch {
    // not present yet — mkdir below creates it
  }
  if (isLink) {
    throw new CaptureInputError(`refusing to use symlinked private directory '${dir}'`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // filesystem without POSIX perms
  }
}

/**
 * Prepare a custom --spool parent WITHOUT clobbering an existing directory's
 * mode. Absent → create a dedicated 0700 dir. Present → refuse a symlink or a
 * non-owner-only dir, but never chmod it, so `--spool ./x.sqlite` can't tighten
 * the caller's cwd. The daemon's own base-dir is handled by ensurePrivateDir.
 */
export function ensureSpoolParentDir(spoolPath: string): void {
  const dir = dirname(spoolPath);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(dir);
  } catch {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new CaptureInputError(`refusing to open the capture spool under symlinked directory '${dir}'`);
  }
  if (!stat.isDirectory()) {
    throw new CaptureInputError(`capture spool parent '${dir}' exists but is not a directory`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new CaptureInputError(
      `capture spool directory '${dir}' is not owner-only (mode ${(stat.mode & 0o777).toString(8)}); ` +
        "point --spool at a private 0700 directory (the daemon creates one when absent)",
    );
  }
}

interface DaemonIdentity {
  instanceId: string;
  pid: number;
}

async function probeIdentity(paths: CapturePaths, env: NodeJS.ProcessEnv, url: string): Promise<DaemonIdentity | null> {
  try {
    const res = await fetch(url, { headers: tokenHeader(paths, env), signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (body !== null && typeof body === "object" && "instanceId" in body && "pid" in body) {
      const instanceId: unknown = body.instanceId;
      const pid: unknown = body.pid;
      if (typeof instanceId === "string" && typeof pid === "number") return { instanceId, pid };
    }
    return null;
  } catch {
    return null;
  }
}

export function recordChildPidOrTerminate(
  pid: number,
  paths: CapturePaths,
  binding: { host: string; port: number },
  stderr: (l: string) => void,
): boolean {
  const existing = readPidRecord(paths.pidPath);
  if (existing !== null && existing.pid === pid && existing.instanceId !== null) return true;
  try {
    writePidFile(paths.pidPath, pid, binding);
    return true;
  } catch (err) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
    stderr(`failed to record daemon pid: ${sanitizeError(err)}; terminated child pid ${pid}`);
    return false;
  }
}

async function isOwnRunningDaemon(record: PidRecord, paths: CapturePaths, env: NodeJS.ProcessEnv, stderr: (l: string) => void): Promise<boolean> {
  if (record.instanceId === null) return true;
  const live = await probeIdentity(paths, env, recordHealthUrl(record, paths, stderr));
  if (live === null) return true;
  return live.instanceId === record.instanceId && live.pid === record.pid;
}

export async function recordedDaemonIsRunning(record: PidRecord, paths: CapturePaths, env: NodeJS.ProcessEnv, stderr: (l: string) => void): Promise<boolean> {
  if (record.pid === process.pid) return false;
  if (!isProcessAlive(record.pid)) return false;
  return isOwnRunningDaemon(record, paths, env, stderr);
}

/**
 * Run replay ingestion as a supervised task AFTER the daemon is ready. Never
 * throws: success/failure is surfaced via the spool's `replay_status` meta
 * (also on /v1/health) and the daemon log, so a slow/failed replay never kills
 * the daemon or retracts its readiness.
 */
export async function superviseReplay(
  spool: Spool,
  replayDir: string,
  config: DaemonConfig,
  io: { stdout: (l: string) => void; stderr: (l: string) => void },
  signal?: AbortSignal,
): Promise<void> {
  await Promise.resolve();
  spool.setMeta("replay_status", "running");
  try {
    const summary = await ingestReplayDirResponsive(spool, replayDir, config, { signal });
    if (summary.aborted) {
      spool.setMeta("replay_status", "cancelled");
      io.stdout(`replay: cancelled after ${summary.stored} snapshot(s)`);
    } else {
      spool.setMeta("replay_status", "ok");
      io.stdout(
        `replay: stored ${summary.stored} of ${summary.candidates} candidate(s) ` +
          `(denied ${summary.denied}, deduped ${summary.deduped}, ocr-skipped ${summary.ocrSkipped}) ` +
          `from ${summary.files} fixture file(s)`,
      );
    }
  } catch (err) {
    const message = err instanceof CaptureConfigError || err instanceof CaptureInputError ? err.message : sanitizeError(err);
    const sanitized = message.replace(/\/\S+/g, "<path>");
    spool.setMeta("replay_status", `failed: ${sanitized}`);
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
  stdout(`set ${CAPTURE_TOKEN_ENV} to override the token file when starting the daemon`);
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
      `refusing to bind non-loopback host '${config.host}': capture-screen serves plain HTTP with no TLS contract; ` +
        "use a loopback address (127.0.0.1 or ::1)",
    );
    return 1;
  }
  const replayDir = typeof flags.replay === "string" ? expandTilde(flags.replay) : null;
  const previousRecord = readPidRecord(paths.pidPath);
  if (previousRecord !== null) {
    if (await recordedDaemonIsRunning(previousRecord, paths, env, stderr)) {
      stdout(`daemon already running (pid ${previousRecord.pid})`);
      return 0;
    }
    if (previousRecord.pid !== process.pid) removePidFile(paths.pidPath);
  }

  if (flags.foreground !== true) {
    const entry = process.argv[1];
    const forwarded = ["start", "--foreground"];
    if (replayDir) forwarded.push("--replay", replayDir);
    if (typeof flags["base-dir"] === "string") forwarded.push("--base-dir", flags["base-dir"]);
    if (typeof flags.spool === "string") forwarded.push("--spool", flags.spool);
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
    child.on("error", (err) => stderr(`daemon failed to launch: ${sanitizeError(err)}`));
    child.unref();
    if (typeof child.pid !== "number") {
      stderr("failed to spawn daemon process");
      return 1;
    }
    if (!recordChildPidOrTerminate(child.pid, paths, { host: config.host, port: config.port }, stderr)) return 1;
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
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      // already gone
    }
    removePidFileIfOwner(paths.pidPath, child.pid);
    stderr(`daemon did not become ready within ${READINESS_TIMEOUT_MS / 1000}s; terminated pid ${child.pid}. See ${paths.logPath}.`);
    return 1;
  }

  ensurePrivateDir(paths.baseDir);
  const token = resolveToken(paths, env, true);
  const helperRes = await resolveHelperBinaryPath(env);
  const axAvailable = helperRes.binaryPath !== null;
  // A custom --spool may live outside base-dir; prepare its parent (create 0700
  // if absent; refuse a symlinked or non-owner-only existing dir) without ever
  // chmod-ing an existing directory.
  ensureSpoolParentDir(paths.spoolPath);
  const spool = new Spool(paths.spoolPath);
  // Retention janitor: prune expired rows once on start so a long-idle spool is
  // trimmed even if the (native) capture loop never runs on this platform.
  spool.pruneOlderThan(config.spoolRetentionDays);
  let handle: DaemonHandle;
  try {
    handle = await startDaemon({
      spool,
      config,
      token,
      capturing: axAvailable,
      axAvailable,
      ocrAvailable: axAvailable,
      helperHint: helperRes.hint,
    });
  } catch (err) {
    spool.close();
    throw err;
  }
  try {
    writePidFile(paths.pidPath, process.pid, {
      instanceId: spool.meta("instance_id"),
      host: handle.host,
      port: handle.port,
    });
  } catch (err) {
    await handle.close();
    spool.close();
    throw err;
  }
  stdout(`listening on ${handle.url}`);
  if (helperRes.hint) stdout(`note: ${helperRes.hint}`);
  const replayAbort = new AbortController();
  const replayTask: Promise<void> = replayDir
    ? superviseReplay(spool, replayDir, config, { stdout, stderr }, replayAbort.signal)
    : Promise.resolve();

  // Live capture loop (#1899 Part 1): when the native helper is available, poll
  // the frontmost window and store on change/settle/idle through the same
  // pipeline as replay. On Linux (no helper) the daemon serves + replays only.
  let scheduler: CaptureScheduler | null = null;
  if (helperRes.binaryPath !== null) {
    const processor = new CaptureProcessor(config);
    for (const fp of spool.latestFingerprints()) {
      processor.seed(fp.app, fp.windowTitle, fp.simhash, fp.capturedAtUtc);
    }
    scheduler = new CaptureScheduler(new NativeHelper(helperRes.binaryPath), processor, spool, config, {
      onError: (err) => stderr(`capture loop error: ${sanitizeError(err)}`),
    });
    scheduler.start();
  }

  return await new Promise<number>((resolve) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      scheduler?.stop();
      // Cancel any in-flight replay and drain it before closing the spool so no
      // ingestion write can ever hit a closed database.
      replayAbort.abort();
      void replayTask
        .catch(() => undefined)
        .then(() => handle.close().catch(() => undefined))
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
  env: NodeJS.ProcessEnv,
  stdout: (l: string) => void,
  stderr: (l: string) => void,
): Promise<number> {
  const record = readPidRecord(paths.pidPath);
  if (record === null || !isProcessAlive(record.pid)) {
    removePidFile(paths.pidPath);
    stdout("daemon not running");
    return 0;
  }
  if (record.instanceId !== null) {
    const live = await probeIdentity(paths, env, recordHealthUrl(record, paths, stderr));
    if (live !== null && (live.instanceId !== record.instanceId || live.pid !== record.pid)) {
      stderr(
        `recorded pid ${record.pid} does not match the daemon serving this endpoint (identity/pid mismatch); ` +
          `not signalling and preserving ${paths.pidPath}.`,
      );
      return 1;
    }
    if (live === null && flags.force !== true) {
      stderr(
        `cannot confirm daemon identity for pid ${record.pid} (health unreachable); not signalling. ` +
          `Re-run \`stop --force\` to stop it anyway, or remove ${paths.pidPath}.`,
      );
      return 1;
    }
  } else if (flags.force !== true) {
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
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(record.pid) || readPidRecord(paths.pidPath) === null) {
      stdout(`daemon (pid ${record.pid}) stopped`);
      return 0;
    }
    await delay(100);
  }
  stdout(`sent SIGTERM to daemon (pid ${record.pid}); still shutting down after ${STOP_TIMEOUT_MS / 1000}s`);
  return 0;
}

async function cmdStatus(paths: CapturePaths, env: NodeJS.ProcessEnv, stdout: (l: string) => void, stderr: (l: string) => void): Promise<number> {
  const record = readPidRecord(paths.pidPath);
  if (record === null || !isProcessAlive(record.pid)) {
    stdout("status: not running");
    return 0;
  }
  try {
    const res = await fetch(recordHealthUrl(record, paths, stderr), {
      headers: tokenHeader(paths, env),
      signal: AbortSignal.timeout(2000),
    });
    const body = await res.text();
    stdout(`status: running (pid ${record.pid}) — HTTP ${res.status} ${body}`);
  } catch (err) {
    stdout(`status: process alive (pid ${record.pid}) but health check failed (${sanitizeError(err)})`);
  }
  return 0;
}

function cmdInstallService(stdout: (l: string) => void): number {
  stdout(
    `install-service is not yet implemented for platform '${process.platform}'. ` +
      "No service was installed. Run `remnic-capture-screen start` under your process manager " +
      "(launchd on macOS, systemd --user on Linux) once the native capture helper is installed.",
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

/**
 * `test-snapshot`: report what WOULD be captured now and which deny rule (if
 * any) fired — WITHOUT storing. Honest about degradation: with no native helper
 * it reports the unavailable capabilities + install hint and captures nothing.
 */
async function cmdTestSnapshot(
  paths: CapturePaths,
  env: NodeJS.ProcessEnv,
  stdout: (l: string) => void,
  stderr: (l: string) => void,
): Promise<number> {
  const config = loadConfigOrDefault(paths, stderr);
  const helperRes = await resolveHelperBinaryPath(env);
  if (helperRes.binaryPath === null) {
    stdout(
      JSON.stringify(
        {
          capturing: false,
          axAvailable: false,
          ocrAvailable: false,
          helperHint: helperRes.hint,
          note: "no live snapshot: native capture helper unavailable",
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const helper = new NativeHelper(helperRes.binaryPath);
  const processor = new CaptureProcessor(config);
  const decision = await captureViaHelper(helper, processor, config, new Date().toISOString());
  if (decision.action === "denied") {
    stdout(JSON.stringify({ action: "denied", rule: decision.rule }, null, 2));
  } else if (decision.action === "skipped") {
    stdout(JSON.stringify({ action: "skipped", reason: decision.reason }, null, 2));
  } else {
    const snap = decision.snapshot;
    stdout(
      JSON.stringify(
        {
          action: "would-store",
          app: snap.app,
          windowTitle: snap.windowTitle,
          textSource: snap.textSource,
          textPreview: snap.text.slice(0, 200),
          contentHash: snap.contentHash,
          simhash: snap.simhash,
          denyRule: null,
        },
        null,
        2,
      ),
    );
  }
  return 0;
}

function usage(stdout: (l: string) => void): number {
  stdout(
    [
      `remnic-capture-screen v${CAPTURE_SCREEN_VERSION}`,
      "usage: remnic-capture-screen <command> [flags]",
      "commands: init | start | stop | status | install-service | logs | test-snapshot",
      "start flags: --foreground --replay <dir> --host <h> --port <n> --listen <host:port> --spool <path> --base-dir <dir>",
      `token: set ${CAPTURE_TOKEN_ENV} (never --auth-token)`,
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
    const allowedFlags = COMMAND_FLAGS[parsed.command];
    if (allowedFlags !== undefined) {
      for (const key of Object.keys(parsed.flags)) {
        if (!Object.hasOwn(GLOBAL_FLAGS, key) && !Object.hasOwn(allowedFlags, key)) {
          stderr(`flag --${key} is not valid for command '${parsed.command}'`);
          usage(stderr);
          return 2;
        }
      }
    }
    switch (parsed.command) {
      case "init":
        return cmdInit(paths, parsed.flags, stdout);
      case "start":
        return await cmdStart(paths, parsed.flags, env, stdout, stderr);
      case "stop":
        return await cmdStop(paths, parsed.flags, env, stdout, stderr);
      case "status":
        return await cmdStatus(paths, env, stdout, stderr);
      case "install-service":
        return cmdInstallService(stdout);
      case "logs":
        return cmdLogs(paths, parsed.flags, stdout);
      case "test-snapshot":
        return await cmdTestSnapshot(paths, env, stdout, stderr);
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
    stderr(`error: ${sanitizeError(err)}`);
    return 1;
  }
}
