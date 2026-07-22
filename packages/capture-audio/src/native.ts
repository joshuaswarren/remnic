/**
 * Native capture helper resolver + supervised process runner (issue #1897,
 * "Audio native macOS helper" slice — Node side only).
 *
 * The native helper is a hardware-gated macOS binary that emits JSONL
 * `ChunkEvent`s (one per recorded audio chunk) on stdout. This module is
 * deliberately à-la-carte, mirroring the VAD/STT adapters:
 *
 *   - The helper ships as an OPTIONAL, per-platform package
 *     (`@remnic/capture-native-darwin-arm64` / `-darwin-x64`). It is a peer
 *     dependency, never a runtime dependency, so `@remnic/capture-audio`
 *     installs and works on any platform without it.
 *   - The package specifier is COMPUTED from `process.platform`/`arch` so a
 *     static importer never bundles a foreign-arch binary, and resolution
 *     uses Node module resolution (`require.resolve`).
 *   - A missing optional package reports the EXACT install command instead of
 *     a raw resolver error.
 *
 * The runner is the sole owner of the child process: it spawns the helper,
 * parses stdout strictly line-by-line, reports validated events to a
 * callback, reports stderr/errors separately, and restarts only UNEXPECTED
 * exits with bounded exponential backoff. It never writes the Spool and never
 * invents a conversation — the processing/assembly layer owns eventual Spool
 * writes downstream of the validated events this runner surfaces.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { CaptureConfigError, CaptureInputError } from "./errors.js";

/** One recorded audio chunk, as emitted by the native helper on stdout (JSONL). */
export interface ChunkEvent {
  path: string;
  channel: "mic" | "system";
  startedAtUtc: string;
  endedAtUtc: string;
  device: string | null;
}

/** A resolved native helper: its computed package specifier and the on-disk binary path. */
export interface HelperResolution {
  specifier: string;
  binaryPath: string;
}

/** Optional per-channel input device identifiers passed to the helper. */
export interface DeviceFlags {
  mic?: string | null;
  system?: string | null;
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
}

export interface NativeRunnerOptions {
  spoolDir: string;
  chunkSeconds: number;
  devices?: DeviceFlags;
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

const HELPER_BIN_NAME = "remnic-capture-native";

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
 * Resolve the native helper binary via Node module resolution over the
 * computed package specifier. Throws a CaptureConfigError naming the exact
 * install command when the optional package is not installed.
 */
export function resolveHelperBinary(deps: ResolveHelperDeps = {}): HelperResolution {
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
        `Install it with: npm install ${specifier} (or: pnpm add ${specifier})`,
    );
  }

  return { specifier, binaryPath: helperBinaryFromPackage(pkgJsonPath, readFile, specifier) };
}

function helperBinaryFromPackage(
  pkgJsonPath: string,
  readFile: (file: string) => string,
  specifier: string,
): string {
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFile(pkgJsonPath));
  } catch {
    throw new CaptureConfigError(`native helper ${specifier} has an unreadable package.json at ${pkgJsonPath}`);
  }

  let bin: unknown;
  if (pkg !== null && typeof pkg === "object" && "bin" in pkg) {
    bin = pkg.bin;
  }

  let rel: string | undefined;
  if (typeof bin === "string") {
    rel = bin;
  } else if (bin !== null && typeof bin === "object") {
    // Guarded, then read as a string→unknown map (npm `bin` object form).
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

/** Build the helper argv from runner options. */
export function buildHelperArgs(opts: Pick<NativeRunnerOptions, "spoolDir" | "chunkSeconds" | "devices">): string[] {
  const args = ["--spool-dir", opts.spoolDir, "--chunk-seconds", String(opts.chunkSeconds)];
  const mic = opts.devices?.mic;
  const system = opts.devices?.system;
  if (typeof mic === "string" && mic !== "") args.push("--mic-device", mic);
  if (typeof system === "string" && system !== "") args.push("--system-device", system);
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
  // Guarded above (object, non-null, non-array): read as a string→unknown map.
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

/**
 * Create a supervised native-capture runner. Dependency-injectable: pass
 * `spawn`, `resolution`/`resolveBinary`, and `scheduleRestart`/`cancelRestart`
 * to drive it deterministically in tests.
 */
export function createNativeCaptureRunner(options: NativeRunnerOptions): NativeCaptureRunner {
  if (typeof options.spoolDir !== "string" || options.spoolDir.trim() === "") {
    throw new CaptureConfigError("native runner spoolDir must be a non-empty string");
  }
  if (!Number.isFinite(options.chunkSeconds) || options.chunkSeconds <= 0) {
    throw new CaptureConfigError("native runner chunkSeconds must be a positive number");
  }

  const spawn: HelperSpawn =
    options.spawn ??
    ((binaryPath, args) =>
      // node's typings make stdout/stderr nullable; our piped stdio guarantees them.
      nodeSpawn(binaryPath, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] }) as unknown as HelperChild);
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
