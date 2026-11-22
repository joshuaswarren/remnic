/**
 * `remnic-capture-audio` CLI. Subcommands: init, start, stop, status,
 * devices, logs. `start --replay <dir>` feeds synthetic fixtures through
 * the spool + HTTP API (the CI-friendly, hardware-free path). Native
 * device enumeration and real capture arrive in later checklist items;
 * `devices` reports that honestly rather than faking a device list.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
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
import { ingestReplayDirResponsive } from "./replay.js";
import { downloadWhisperModel, type ModelDownloadInput, type ModelDownloadResult } from "./model.js";
import { pruneExpiredRawAudio } from "./janitor.js";
import { Spool } from "./spool.js";
import { loadOrCreateToken } from "./token.js";
import { formatHostForUrl, isLoopbackHost, stripIpv6Brackets } from "./util.js";
import { homedir } from "node:os";

import { createLiveCapture, type LiveCapture } from "./capture.js";
import { enrollSelf } from "./enroll.js";
import { enumerateDevices, resolveHelperBinary } from "./native.js";
import { installService, uninstallService } from "./service.js";

export interface CliIo {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  downloadModel?: (input: ModelDownloadInput) => Promise<ModelDownloadResult>;
  stderr?: (line: string) => void;
  /**
   * argv tokens (after the node executable) that re-launch THIS CLI, used
   * when the daemon backgrounds itself into `--foreground`. Defaults to
   * [process.argv[1]] (direct `remnic-capture-audio` invocation). The
   * `remnic capture audio` passthrough supplies [remnicBin, "capture",
   * "audio"] so the detached child is `remnic capture audio start
   * --foreground`, not `remnic start --foreground`.
   */
  spawnArgvPrefix?: string[];
}

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS: Record<string, true> = {
  replay: true,
  host: true,
  port: true,
  listen: true,
  "base-dir": true,
  model: true,
  lines: true,
  label: true,
};

const BOOLEAN_FLAGS: Record<string, true> = {
  foreground: true,
  force: true,
  help: true,
  capture: true,
  uninstall: true,
};

const COMMAND_FLAGS: Record<string, Record<string, true>> = {
  init: { force: true },
  start: { foreground: true, replay: true, host: true, port: true, listen: true, capture: true },
  stop: { force: true },
  status: {},
  devices: {},
  logs: { lines: true },
  "download-model": { model: true },
  janitor: {},
  "install-service": { force: true, uninstall: true, label: true },
  "enroll-self": { label: true },
  help: {},
};

const GLOBAL_FLAGS: Record<string, true> = { "base-dir": true, help: true };

const READINESS_TIMEOUT_MS = 10_000;

const STOP_TIMEOUT_MS = 10_000;

function parseArgs(argv: string[]): ParsedArgs {
  const tokens: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
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
      tokens.push(arg);
    }
  }
  const command = tokens.length > 0 ? tokens[0] : "help";
  return { command, positionals: tokens.slice(1), flags };
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

function tokenHeader(paths: CapturePaths): Record<string, string> {
  if (!existsSync(paths.tokenPath)) return {};
  return { authorization: `Bearer ${readFileSync(paths.tokenPath, "utf8").trim()}` };
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // filesystem without POSIX perms
  }
}

function describeError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (typeof code === "string" && code) return code;
  return err instanceof Error ? err.name : "unknown error";
}

interface DaemonIdentity {
  instanceId: string;
  pid: number;
}

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
  const existing = readPidRecord(paths.pidPath);
  if (existing !== null && existing.pid === pid && existing.instanceId !== null) {
    return true;
  }
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

export async function recordedDaemonIsRunning(
  record: PidRecord,
  paths: CapturePaths,
  stderr: (l: string) => void,
): Promise<boolean> {
  if (record.pid === process.pid) return false;
  if (!isProcessAlive(record.pid)) return false;
  return isOwnRunningDaemon(record, paths, stderr);
}

export async function superviseReplay(
  spool: Spool,
  replayDir: string,
  io: { stdout: (l: string) => void; stderr: (l: string) => void },
  signal?: AbortSignal,
): Promise<void> {
  await Promise.resolve();
  spool.setMeta("replay_status", "running");
  try {
    const summary = await ingestReplayDirResponsive(spool, replayDir, { signal });
    if (summary.aborted) {
      spool.setMeta("replay_status", "cancelled");
      io.stdout(`replay: cancelled after ${summary.conversationsIngested} conversation(s)`);
    } else {
      spool.setMeta("replay_status", "ok");
      io.stdout(
        `replay: ingested ${summary.conversationsIngested} conversation(s), ` +
          `${summary.segmentsIngested} segment(s) from ${summary.files} fixture file(s)`,
      );
    }
  } catch (err) {
    const message =
      err instanceof CaptureConfigError || err instanceof CaptureInputError ? err.message : describeError(err);
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
  stdout(`spool will be created at ${paths.spoolPath} on first start`);
  return 0;
}

async function cmdDownloadModel(
  paths: CapturePaths,
  flags: Record<string, string | boolean>,
  stdout: (line: string) => void,
  downloadModel: (input: ModelDownloadInput) => Promise<ModelDownloadResult>,
): Promise<number> {
  if (typeof flags.model !== "string") throw new CaptureInputError("flag --model requires a value");
  const result = await downloadModel({ model: flags.model, directory: path.join(paths.baseDir, "models") });
  stdout(`${result.downloaded ? "downloaded" : "model already present"} ${flags.model} to ${result.path}`);
  return 0;
}

async function cmdJanitor(
  paths: CapturePaths,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): Promise<number> {
  const config = loadConfigOrDefault(paths, stderr);
  const removed = await pruneExpiredRawAudio(path.join(paths.baseDir, "raw"), config.rawRetentionHours * 60 * 60 * 1000);
  stdout(`janitor: removed ${removed.length} expired raw audio file(s)`);
  return 0;
}

async function cmdStart(
  paths: CapturePaths,
  flags: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv,
  stdout: (l: string) => void,
  stderr: (l: string) => void,
  spawnArgvPrefix: readonly string[],
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
    if (await recordedDaemonIsRunning(previousRecord, paths, stderr)) {
      stdout(`daemon already running (pid ${previousRecord.pid})`);
      return 0;
    }
    if (previousRecord.pid !== process.pid) {
      removePidFile(paths.pidPath);
    }
  }

  if (flags.foreground !== true) {
    const relaunch = spawnArgvPrefix.length > 0 ? [...spawnArgvPrefix] : [process.argv[1]];
    const forwarded = ["start", "--foreground"];
    if (replayDir) forwarded.push("--replay", replayDir);
    if (typeof flags["base-dir"] === "string") forwarded.push("--base-dir", flags["base-dir"]);
    if (typeof flags.host === "string") forwarded.push("--host", flags.host);
    if (typeof flags.port === "string") forwarded.push("--port", flags.port);
    if (typeof flags.listen === "string") forwarded.push("--listen", flags.listen);
    if (flags.capture === true) forwarded.push("--capture");
    ensurePrivateDir(paths.baseDir);
    const logFd = openSync(paths.logPath, "a");
    const child = spawn(process.execPath, [...relaunch, ...forwarded], {
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
    if (!recordChildPidOrTerminate(child.pid, paths, { host: config.host, port: config.port }, stderr)) {
      return 1;
    }
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
    stderr(
      `daemon did not become ready within ${READINESS_TIMEOUT_MS / 1000}s; terminated pid ${child.pid}. See ${paths.logPath}.`,
    );
    return 1;
  }

  ensurePrivateDir(paths.baseDir);
  const token = loadOrCreateToken(paths.tokenPath);
  const spool = new Spool(paths.spoolPath);

  let live: LiveCapture | null = null;
  if (flags.capture === true) {
    try {
      const rawDir = path.join(paths.baseDir, "raw");
      mkdirSync(rawDir, { recursive: true });
      live = createLiveCapture({
        spool,
        config,
        outDir: rawDir,
        defaultModelPath: path.join(paths.baseDir, "models", "ggml-base.bin"),
        onError: (e) => stderr(`capture: ${describeError(e)}`),
        onStderr: (l) => stderr(`helper: ${l}`),
      });
      live.start();
    } catch (err) {
      const detail = err instanceof CaptureConfigError || err instanceof CaptureInputError ? err.message : describeError(err);
      stderr(`live capture unavailable: ${detail}; serving without capture`);
      live = null;
    }
  }

  let handle: DaemonHandle;
  try {
    handle = await startDaemon({ spool, config, token, capturing: () => live !== null && live.running });
  } catch (err) {
    if (live) await live.stop().catch(() => undefined);
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
    if (live) await live.stop().catch(() => undefined);
    await handle.close();
    spool.close();
    throw err;
  }
  stdout(`listening on ${handle.url}`);
  if (live) stdout("live capture started");
  const replayAbort = new AbortController();
  const replayTask: Promise<void> = replayDir
    ? superviseReplay(spool, replayDir, { stdout, stderr }, replayAbort.signal)
    : Promise.resolve();

  return await new Promise<number>((resolve) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      replayAbort.abort();
      void replayTask
        .catch(() => undefined)
        .then(() => (live ? live.stop().then(() => undefined) : undefined))
        .catch((error: unknown) => {
          process.stderr.write(
            `[capture-audio] shutdown flush failed; retained raw audio was NOT ingested: ${describeError(error)}\n`,
          );
        })
        .then(() => {
          spool.finalizeOpenConversations();
          return handle.close().catch(() => undefined);
        })
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
  if (record.instanceId !== null) {
    const live = await probeIdentity(paths, recordHealthUrl(record, paths, stderr));
    if (live !== null && (live.instanceId !== record.instanceId || live.pid !== record.pid)) {
      stderr(
        `recorded pid ${record.pid} does not match the daemon serving this endpoint (identity/pid mismatch); ` +
          `not signalling and preserving ${paths.pidPath}. Stop the serving daemon via its own controls, ` +
          `or remove the pid file after verifying it is stale.`,
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
  stdout(
    `sent SIGTERM to daemon (pid ${record.pid}); still shutting down after ${STOP_TIMEOUT_MS / 1000}s`,
  );
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

async function cmdDevices(env: NodeJS.ProcessEnv, stdout: (l: string) => void): Promise<number> {
  const { binaryPath } = resolveHelperBinary({ env });
  const devices = await enumerateDevices(binaryPath);
  stdout(JSON.stringify({ devices }, null, 2));
  return 0;
}

function cmdInstallService(
  paths: CapturePaths,
  flags: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv,
  stdout: (l: string) => void,
  spawnArgvPrefix: readonly string[],
): number {
  const platform = process.platform;
  const home = homedir();
  const label = typeof flags.label === "string" ? flags.label : undefined;
  const environment: Record<string, string> = {};
  if (typeof env.PATH === "string" && env.PATH !== "") environment.PATH = env.PATH;
  const helperBin = env.REMNIC_CAPTURE_HELPER_BIN;
  if (typeof helperBin === "string" && helperBin !== "") environment.REMNIC_CAPTURE_HELPER_BIN = helperBin;
  const spec = {
    programArguments: [
      process.execPath,
      ...(spawnArgvPrefix.length > 0 ? [...spawnArgvPrefix] : [process.argv[1]]),
      "start",
      "--foreground",
      "--capture",
      "--base-dir",
      paths.baseDir,
    ],
    logPath: paths.logPath,
    ...(label ? { label } : {}),
    ...(Object.keys(environment).length > 0 ? { environment } : {}),
  };
  if (flags.uninstall === true) {
    const { plan, removed } = uninstallService({
      platform,
      home,
      spec,
      exists: existsSync,
      remove: (f) => rmSync(f, { force: true }),
    });
    stdout(removed ? `removed ${plan.path}` : `no capture-audio service installed at ${plan.path}`);
    return 0;
  }
  ensurePrivateDir(paths.baseDir);
  const plan = installService({
    platform,
    home,
    spec,
    force: flags.force === true,
    exists: existsSync,
    mkdir: (dir) => mkdirSync(dir, { recursive: true }),
    writeFile: (file, contents) => writeFileSync(file, contents, { mode: 0o644 }),
  });
  stdout(`installed ${plan.platform} service at ${plan.path}`);
  stdout(`enable it with: ${plan.loadHint}`);
  return 0;
}

function cmdEnrollSelf(
  paths: CapturePaths,
  flags: Record<string, string | boolean>,
  stdout: (l: string) => void,
): number {
  ensurePrivateDir(paths.baseDir);
  const spool = new Spool(paths.spoolPath);
  try {
    const label = typeof flags.label === "string" ? flags.label : undefined;
    const result = enrollSelf({ spool, label });
    stdout(`enrolled self speaker '${result.speakerId}' (${result.label})`);
    if (!result.hasEmbedding) {
      stdout("no voice embedding stored yet; voice-based diarization refinement lands with the diarization slice");
    }
    return 0;
  } finally {
    spool.close();
  }
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
      "commands: init | start | stop | status | devices | logs | download-model | janitor | install-service | enroll-self",
      "start flags: --foreground --capture --replay <dir> --host <h> --port <n> --listen <host:port> --base-dir <dir>",
      "download-model flags: --model <base|small|large-v3-turbo-q5_0> --base-dir <dir>",
      "install-service flags: --force --uninstall --label <id>; enroll-self flags: --label <name>",
      "janitor uses rawRetentionHours from audio.json to remove expired files under raw/",
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
        return await cmdStart(paths, parsed.flags, env, stdout, stderr, io.spawnArgvPrefix ?? [process.argv[1]]);
      case "stop":
        return await cmdStop(paths, parsed.flags, stdout, stderr);
      case "status":
        return await cmdStatus(paths, stdout, stderr);
      case "devices":
        return await cmdDevices(env, stdout);
      case "logs":
        return cmdLogs(paths, parsed.flags, stdout);
      case "download-model":
        return await cmdDownloadModel(paths, parsed.flags, stdout, io.downloadModel ?? downloadWhisperModel);
      case "janitor":
        return await cmdJanitor(paths, stdout, stderr);
      case "install-service":
        return cmdInstallService(paths, parsed.flags, env, stdout, io.spawnArgvPrefix ?? [process.argv[1]]);
      case "enroll-self":
        return cmdEnrollSelf(paths, parsed.flags, stdout);
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
