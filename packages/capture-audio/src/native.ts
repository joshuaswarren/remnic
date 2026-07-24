/**
 * Native capture helper resolver + supervised process runner (issue #1897,
 * "audio native macOS helper" slice — Node side only).
 *
 * The native recorder is the ONE shared macOS helper shipped by #2138
 * (`remnic-capture-helper`), driven here through its `audio-capture`
 * subcommand. It emits one JSONL `ChunkEvent` per recorded WAV chunk on
 * stdout. This module is deliberately à-la-carte, mirroring the VAD/STT
 * adapters and the screen daemon's helper seam:
 *
 *   - The helper ships as an OPTIONAL, per-platform package
 *     (`@remnic/capture-native-darwin-arm64` / `-x64`) that exports a
 *     `helperBinaryPath` and declares the same binary under `bin`. It is a
 *     peer dependency, never a runtime dependency, so `@remnic/capture-audio`
 *     installs and works on any platform without it.
 *   - The package specifier is COMPUTED from `process.platform`/`arch` so a
 *     static importer never bundles a foreign-arch binary, and resolution uses
 *     Node module resolution (`require.resolve`).
 *   - `REMNIC_CAPTURE_HELPER_BIN` overrides resolution with an explicit binary
 *     path (manual installs and the hardware-free test seam, which points it at
 *     a fake script emitting canned JSON).
 *   - A missing optional package reports the EXACT install command instead of a
 *     raw resolver error.
 *
 * The runner is the sole owner of the child process: it spawns the helper,
 * parses stdout strictly line-by-line, reports validated events to a callback,
 * reports stderr/errors separately, and restarts only UNEXPECTED exits with
 * bounded exponential backoff. It never writes the Spool and never invents a
 * conversation — the processing/assembly layer owns eventual Spool writes
 * downstream of the validated events this runner surfaces.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { CaptureConfigError, CaptureInputError } from "./errors.js";
import { expandTilde } from "./paths.js";

/** One recorded audio chunk, as emitted by the native helper on stdout (JSONL). */
export interface ChunkEvent {
  path: string;
  channel: "mic" | "system";
  startedAtUtc: string;
  endedAtUtc: string;
  device: string | null;
}

/** Which channels the `audio-capture` subcommand records. */
export type ChannelSelection = "mic" | "system" | "both";

/** A resolved native helper: its source specifier and the on-disk binary path. */
export interface HelperResolution {
  specifier: string;
  binaryPath: string;
}

/** The narrow child-process surface the runner depends on (injectable for tests). */
export interface HelperChild {
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  once(event: "error", listener: (err: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  readonly killed?: boolean;
  readonly pid?: number;
}

/** Spawns the helper binary. Defaults to a `node:child_process` adapter. */
export type HelperSpawn = (binaryPath: string, args: string[]) => HelperChild;

/** An opaque restart-timer token returned by `scheduleRestart`. */
export type RestartTimer = unknown;

export interface ResolveHelperDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  /** `require.resolve`-style resolver; defaults to this module's require. */
  resolve?: (specifier: string) => string;
  readFile?: (file: string) => string;
  /** Environment source for the `REMNIC_CAPTURE_HELPER_BIN` override. */
  env?: NodeJS.ProcessEnv;
}

export interface NativeRunnerOptions {
  /** Directory the helper writes WAV chunks into (`audio-capture --out`). */
  outDir: string;
  chunkSeconds: number;
  /** Channels to record; defaults to "both". */
  channel?: ChannelSelection;
  /** Optional CoreAudio microphone device UID (`--device`). */
  device?: string | null;
  /** Called once per validated ChunkEvent. */
  onChunk: (event: ChunkEvent) => void;
  /** Called for a rejected stdout line or a spawn/child error. */
  onError?: (error: Error) => void;
  /** Called once per complete stderr line. */
  onStderr?: (line: string) => void;
  /** Pre-resolved helper; when absent the runner resolves it lazily on `start()`. */
  resolution?: HelperResolution;
  resolveBinary?: (deps: ResolveHelperDeps) => HelperResolution;
  spawn?: HelperSpawn;
  /** Max consecutive unexpected restarts before giving up (default 5). */
  maxRestarts?: number;
  /** First backoff delay in ms (default 500). */
  baseBackoffMs?: number;
  /** Backoff ceiling in ms (default 30000). */
  maxBackoffMs?: number;
  scheduleRestart?: (fn: () => void, delayMs: number) => RestartTimer;
  cancelRestart?: (timer: RestartTimer) => void;
}

/** A running native-capture supervisor. */
export interface NativeCaptureRunner {
  start(): void;
  stop(): void;
  /** True between a `start()` and its matching `stop()`. */
  readonly running: boolean;
}

/** The env var that overrides package resolution with an explicit binary path. */
export const HELPER_BIN_ENV = "REMNIC_CAPTURE_HELPER_BIN";
/** The `bin` key the #2138 platform package declares (same file as helperBinaryPath). */
const HELPER_BIN_NAME = "remnic-capture-helper";

/**
 * Compute the optional native-helper package specifier for a platform/arch.
 * The helper is macOS-only and hardware-gated; every other platform (and any
 * unsupported macOS architecture) throws loudly rather than resolving to a
 * package that cannot exist.
 */
export function helperPackageSpecifier(platform: NodeJS.Platform | string, arch: string): string {
  if (platform !== "darwin") {
    throw new CaptureConfigError(
      `Desktop audio capture native helper is only available on macOS; platform "${platform}" is unsupported`,
    );
  }
  if (arch === "arm64") return "@remnic/capture-native-darwin-arm64";
  if (arch === "x64") return "@remnic/capture-native-darwin-x64";
  throw new CaptureConfigError(
    `Desktop audio capture native helper is unavailable for macOS architecture "${arch}"`,
  );
}

const defaultRequire = createRequire(import.meta.url);

/**
 * Resolve the native helper binary. Order: explicit `REMNIC_CAPTURE_HELPER_BIN`
 * override, then the computed platform package's declared executable (resolved
 * via Node module resolution, identical to its `helperBinaryPath` export).
 * Throws a CaptureConfigError naming the exact install command when the
 * optional package is not installed.
 */
export function resolveHelperBinary(deps: ResolveHelperDeps = {}): HelperResolution {
  const env = deps.env ?? process.env;
  const override = env[HELPER_BIN_ENV]?.trim();
  if (override) return { specifier: `(${HELPER_BIN_ENV})`, binaryPath: expandTilde(override) };

  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const resolve = deps.resolve ?? ((specifier: string) => defaultRequire.resolve(specifier));
  const readFile = deps.readFile ?? ((file: string) => readFileSync(file, "utf8"));

  const specifier = helperPackageSpecifier(platform, arch);

  let pkgJsonPath: string;
  try {
    pkgJsonPath = resolve(`${specifier}/package.json`);
  } catch {
    throw new CaptureConfigError(
      `Desktop audio capture requires optional native helper ${specifier}, which is not installed. ` +
        `Install it with: npm install ${specifier} (or: pnpm add ${specifier}), ` +
        `or set ${HELPER_BIN_ENV} to a locally built remnic-capture-helper binary`,
    );
  }

  return { specifier, binaryPath: helperBinaryFromPackage(pkgJsonPath, readFile, specifier) };
}

function helperBinaryFromPackage(pkgJsonPath: string, readFile: (file: string) => string, specifier: string): string {
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFile(pkgJsonPath));
  } catch {
    throw new CaptureConfigError(`native helper ${specifier} has an unreadable package.json at ${pkgJsonPath}`);
  }

  let bin: unknown;
  if (pkg !== null && typeof pkg === "object" && "bin" in pkg) bin = pkg.bin;

  let rel: string | undefined;
  if (typeof bin === "string") {
    rel = bin;
  } else if (bin !== null && typeof bin === "object") {
    const map: Record<string, unknown> = bin as Record<string, unknown>;
    const named = map[HELPER_BIN_NAME];
    const first = Object.values(map).find((v) => typeof v === "string");
    if (typeof named === "string") rel = named;
    else if (typeof first === "string") rel = first;
  }
  if (rel === undefined || rel === "") {
    throw new CaptureConfigError(`native helper ${specifier} does not declare an executable in its package.json "bin"`);
  }
  return path.resolve(path.dirname(pkgJsonPath), rel);
}

/** Build the `audio-capture` argv from runner options (#2138 helper contract). */
export function buildHelperArgs(
  opts: Pick<NativeRunnerOptions, "outDir" | "chunkSeconds" | "channel" | "device">,
): string[] {
  const channel = opts.channel ?? "both";
  const args = [
    "audio-capture",
    "--channel",
    channel,
    "--chunk-seconds",
    String(opts.chunkSeconds),
    "--out",
    opts.outDir,
  ];
  const device = opts.device;
  if (typeof device === "string" && device !== "") args.push("--device", device);
  return args;
}

const ISO_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T/;

function parseTimestamp(value: unknown, where: string): string {
  if (typeof value !== "string" || !ISO_PREFIX_RE.test(value)) {
    throw new CaptureInputError(`${where}: expected an ISO timestamp`);
  }
  if (!Number.isFinite(Date.parse(value))) {
    throw new CaptureInputError(`${where}: expected a valid ISO timestamp`);
  }
  return value;
}

/** Parse and validate one JSONL line into a ChunkEvent; throws on anything malformed. */
export function parseChunkEvent(line: string): ChunkEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    const trimmed = line.trim();
    const preview = trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
    throw new CaptureInputError(`native helper emitted a non-JSON line: ${preview}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CaptureInputError("native helper chunk: expected a JSON object");
  }
  const obj: Record<string, unknown> = raw as Record<string, unknown>;

  if (typeof obj.path !== "string" || obj.path.trim() === "") {
    throw new CaptureInputError("native helper chunk.path: expected a non-empty string");
  }
  if (obj.channel !== "mic" && obj.channel !== "system") {
    throw new CaptureInputError('native helper chunk.channel: expected "mic" or "system"');
  }
  const startedAtUtc = parseTimestamp(obj.startedAtUtc, "native helper chunk.startedAtUtc");
  const endedAtUtc = parseTimestamp(obj.endedAtUtc, "native helper chunk.endedAtUtc");
  if (Date.parse(endedAtUtc) < Date.parse(startedAtUtc)) {
    throw new CaptureInputError("native helper chunk.endedAtUtc: must not precede startedAtUtc");
  }
  let device: string | null = null;
  if (obj.device !== undefined && obj.device !== null) {
    if (typeof obj.device !== "string") {
      throw new CaptureInputError("native helper chunk.device: expected a string, null, or absent");
    }
    device = obj.device;
  }
  return { path: obj.path, channel: obj.channel, startedAtUtc, endedAtUtc, device };
}

interface LineReader {
  push(chunk: Buffer | string): void;
  flush(): void;
}

/** Incrementally split a byte/string stream into complete newline-terminated lines. */
function makeLineReader(onLine: (line: string) => void): LineReader {
  let buffer = "";
  return {
    push(chunk) {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        onLine(buffer.slice(0, idx).replace(/\r$/, ""));
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
      }
    },
    flush() {
      if (buffer.length > 0) {
        const line = buffer.replace(/\r$/, "");
        buffer = "";
        onLine(line);
      }
    },
  };
}

const defaultSpawn: HelperSpawn = (binaryPath, args) =>
  // node's typings make stdout/stderr nullable; our piped stdio guarantees them.
  nodeSpawn(binaryPath, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] }) as unknown as HelperChild;

/** Max device-enumerate stdout we will buffer (guards a runaway child). */
const MAX_ENUMERATE_BYTES = 1024 * 1024;

/**
 * Run the helper's one-shot `device-enumerate` subcommand and return the parsed
 * device list. Bounded, argv-only, and injectable for tests. Throws a
 * CaptureInputError on a nonzero exit, empty output, or invalid JSON.
 */
export function enumerateDevices(
  binaryPath: string,
  spawn: HelperSpawn = defaultSpawn,
): Promise<unknown[]> {
  // `new Promise` (not Promise.withResolvers) matches the sibling capture
  // packages; this package's tsconfig lib predates withResolvers.
  return new Promise<unknown[]>((resolve, reject) => {
    const child = spawn(binaryPath, ["device-enumerate"]);
    let out = "";
    let size = 0;
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    child.stdout.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      size += Buffer.byteLength(text);
      if (size > MAX_ENUMERATE_BYTES) {
        child.kill("SIGKILL");
        fail(new CaptureInputError("native helper device-enumerate produced too much output"));
        return;
      }
      out += text;
    });
    child.stderr.on("data", () => undefined);
    child.once("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
    child.once("exit", (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(new CaptureInputError(`native helper device-enumerate exited with status ${code ?? "unknown"}`));
        return;
      }
      if (out.trim() === "") {
        fail(new CaptureInputError("native helper device-enumerate produced no output"));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(out);
      } catch {
        fail(new CaptureInputError("native helper device-enumerate produced invalid JSON"));
        return;
      }
      let list: unknown[] | null = null;
      if (Array.isArray(parsed)) {
        list = parsed;
      } else if (parsed !== null && typeof parsed === "object" && "devices" in parsed) {
        const devices = parsed.devices;
        if (Array.isArray(devices)) list = devices;
      }
      if (list === null) {
        fail(new CaptureInputError("native helper device-enumerate did not return a device array"));
        return;
      }
      settled = true;
      resolve(list);
    });
  });
}

/**
 * Create a supervised native-capture runner. Dependency-injectable: pass
 * `spawn`, `resolution`/`resolveBinary`, and `scheduleRestart`/`cancelRestart`
 * to drive it deterministically in tests.
 */
export function createNativeCaptureRunner(options: NativeRunnerOptions): NativeCaptureRunner {
  if (typeof options.outDir !== "string" || options.outDir.trim() === "") {
    throw new CaptureConfigError("native runner outDir must be a non-empty string");
  }
  if (!Number.isFinite(options.chunkSeconds) || options.chunkSeconds <= 0) {
    throw new CaptureConfigError("native runner chunkSeconds must be a positive number");
  }

  const spawn: HelperSpawn = options.spawn ?? defaultSpawn;
  const scheduleRestart = options.scheduleRestart ?? ((fn, delayMs) => setTimeout(fn, delayMs).unref());
  const cancelRestart = options.cancelRestart ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  const resolveBinary = options.resolveBinary ?? resolveHelperBinary;
  const maxRestarts = options.maxRestarts ?? 5;
  const baseBackoffMs = options.baseBackoffMs ?? 500;
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  const args = buildHelperArgs(options);

  const onError = (error: Error): void => {
    options.onError?.(error);
  };

  let resolution: HelperResolution | undefined = options.resolution;
  let stopped = true;
  let child: HelperChild | undefined;
  let restartTimer: RestartTimer | undefined;
  let restarts = 0;

  function scheduleUnexpectedRestart(): void {
    if (stopped) return;
    if (restarts >= maxRestarts) {
      stopped = true;
      onError(new Error(`native capture helper failed ${restarts} times; giving up`));
      return;
    }
    const delayMs = Math.min(maxBackoffMs, baseBackoffMs * 2 ** restarts);
    restarts += 1;
    restartTimer = scheduleRestart(() => {
      restartTimer = undefined;
      if (!stopped) spawnChild();
    }, delayMs);
  }

  function spawnChild(): void {
    if (resolution === undefined) {
      resolution = resolveBinary({});
    }
    const current = spawn(resolution.binaryPath, args);
    child = current;
    let settled = false;

    const stdoutReader = makeLineReader((line) => {
      if (line.trim() === "") return;
      try {
        const event = parseChunkEvent(line);
        restarts = 0; // a valid chunk proves the helper is healthy — reset backoff
        options.onChunk(event);
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    });
    const stderrReader = makeLineReader((line) => {
      if (line.trim() !== "") options.onStderr?.(line);
    });

    current.stdout.on("data", (chunk) => stdoutReader.push(chunk));
    current.stderr.on("data", (chunk) => stderrReader.push(chunk));

    const settle = (): void => {
      settled = true;
      stdoutReader.flush();
      stderrReader.flush();
      if (child === current) child = undefined;
    };

    current.once("error", (err) => {
      if (settled) return;
      settle();
      onError(err instanceof Error ? err : new Error(String(err)));
      scheduleUnexpectedRestart();
    });
    current.once("exit", (code, signal) => {
      if (settled) return;
      settle();
      if (stopped) return; // explicit stop — never restart
      onError(
        new Error(`native capture helper exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`),
      );
      scheduleUnexpectedRestart();
    });
  }

  return {
    get running(): boolean {
      return !stopped;
    },
    start(): void {
      if (!stopped) return;
      stopped = false;
      restarts = 0;
      spawnChild();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (restartTimer !== undefined) {
        cancelRestart(restartTimer);
        restartTimer = undefined;
      }
      const current = child;
      child = undefined;
      if (current && current.killed !== true) current.kill("SIGTERM");
    },
  };
}
