/**
 * `remnic-capture-audio` CLI. Subcommands: init, start, stop, status,
 * devices, logs. `start --replay <dir>` feeds synthetic fixtures through
 * the spool + HTTP API (the CI-friendly, hardware-free path). Native
 * device enumeration and real capture arrive in later checklist items;
 * `devices` reports that honestly rather than faking a device list.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

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
} from "./control.js";
import { startDaemon } from "./daemon.js";
import { CaptureConfigError, CaptureInputError } from "./errors.js";
import { capturePaths, captureBaseDir, type CapturePaths } from "./paths.js";
import { ingestReplayDir } from "./replay.js";
import { Spool } from "./spool.js";
import { loadOrCreateToken } from "./token.js";

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

const VALUE_FLAGS: Record<string, true> = {
  replay: true,
  host: true,
  port: true,
  listen: true,
  "base-dir": true,
  lines: true,
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
      } else {
        flags[key] = true;
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

function tokenHeader(paths: CapturePaths): Record<string, string> {
  if (!existsSync(paths.tokenPath)) return {};
  return { authorization: `Bearer ${readFileSync(paths.tokenPath, "utf8").trim()}` };
}

/** Authenticated health probe; returns the daemon's instanceId or null. */
async function probeInstanceId(paths: CapturePaths, config: DaemonConfig): Promise<string | null> {
  try {
    const res = await fetch(`http://${config.host}:${config.port}/v1/health`, {
      headers: tokenHeader(paths),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { instanceId?: unknown };
    return typeof body.instanceId === "string" ? body.instanceId : null;
  } catch {
    return null;
  }
}

function cmdInit(paths: CapturePaths, flags: Record<string, string | boolean>, stdout: (l: string) => void): number {
  mkdirSync(paths.baseDir, { recursive: true });
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
  const replayDir = typeof flags.replay === "string" ? flags.replay : null;
  const previousPid = readPidRecord(paths.pidPath)?.pid ?? null;
  if (previousPid !== null) {
    if (isProcessAlive(previousPid)) {
      stdout(`daemon already running (pid ${previousPid})`);
      return 0;
    }
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
    mkdirSync(paths.baseDir, { recursive: true });
    const logFd = openSync(paths.logPath, "a");
    const child = spawn(process.execPath, [entry, ...forwarded], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, ...env },
    });
    child.unref();
    if (typeof child.pid === "number") writePidFile(paths.pidPath, child.pid);
    stdout(`started daemon (pid ${child.pid}); logs at ${paths.logPath}`);
    return 0;
  }

  const token = loadOrCreateToken(paths.tokenPath);
  const spool = new Spool(paths.spoolPath);
  if (replayDir) {
    const summary = ingestReplayDir(spool, replayDir);
    stdout(
      `replay: ingested ${summary.conversationsIngested} conversation(s), ` +
        `${summary.segmentsIngested} segment(s) from ${summary.files} fixture file(s)`,
    );
  }
  const handle = await startDaemon({ spool, config, token, capturing: false });
  writePidFile(paths.pidPath, process.pid, { instanceId: spool.meta("instance_id") });
  stdout(`listening on ${handle.url}`);

  return await new Promise<number>((resolve) => {
    const shutdown = () => {
      spool.finalizeOpenConversations();
      void handle.close().finally(() => {
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
  stdout: (l: string) => void,
  stderr: (l: string) => void,
): Promise<number> {
  const record = readPidRecord(paths.pidPath);
  if (record === null || !isProcessAlive(record.pid)) {
    removePidFile(paths.pidPath);
    stdout("daemon not running");
    return 0;
  }
  // Identity guard: if we recorded which daemon instance owns this pid,
  // confirm the live process really is that daemon before signalling it —
  // a reused pid must not be killed by us.
  if (record.instanceId !== null) {
    const config = loadConfigOrDefault(paths, stderr);
    const liveInstance = await probeInstanceId(paths, config);
    if (liveInstance !== null && liveInstance !== record.instanceId) {
      removePidFile(paths.pidPath);
      stdout(`pid ${record.pid} is not our daemon (instance mismatch); cleared stale pid file`);
      return 0;
    }
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
  // finalized conversations and released the spool/socket — do not delete
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
  const config = loadConfigOrDefault(paths, stderr);
  try {
    const res = await fetch(`http://${config.host}:${config.port}/v1/health`, {
      headers: tokenHeader(paths),
      signal: AbortSignal.timeout(2000),
    });
    const body = await res.text();
    stdout(`status: running (pid ${record.pid}) — HTTP ${res.status} ${body}`);
  } catch (err) {
    stdout(`status: process alive (pid ${record.pid}) but health check failed: ${(err as Error).message}`);
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
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(io.argv);
  } catch (err) {
    stderr((err as Error).message);
    return 2;
  }
  const paths = resolvePaths(parsed.flags, env);
  try {
    switch (parsed.command) {
      case "init":
        return cmdInit(paths, parsed.flags, stdout);
      case "start":
        return await cmdStart(paths, parsed.flags, env, stdout, stderr);
      case "stop":
        return await cmdStop(paths, stdout, stderr);
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
      return 1;
    }
    stderr(`error: ${(err as Error).message}`);
    return 1;
  }
}
