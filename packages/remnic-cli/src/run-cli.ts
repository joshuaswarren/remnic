/**
 * In-process entry point for the `remnic` CLI (issue #1532 Phase A).
 *
 * `main()` (in `./index.ts`) is the real dispatcher but it writes directly
 * to `process.stdout` / `process.stderr` and calls `process.exit`, which
 * makes contract testing impossible without spawning a child process per
 * case. `runCli` is the thin wrapper that lets tests (and any future
 * embedded consumer) invoke the CLI in-process and observe the captured
 * stdout / stderr / exitCode.
 *
 * The wrapper is intentionally minimal: it does NOT re-implement parsing,
 * dispatch, or validation — those still live behind `main()` so behaviour
 * stays identical between the `remnic` binary and the test harness. It only
 * redirects the IO channels and intercepts `process.exit` so the test
 * process survives. Every override is restored in `finally`, even if the
 * dispatcher throws or calls `process.exit(N)`.
 *
 * Phase B of #1532 will move handlers behind a registrar table; until then
 * this harness is what gives the contract suite a stable surface to assert
 * against without booting the whole CLI as a subprocess.
 */

import { main } from "./index.js";

/**
 * Optional IO overrides for `runCli`. All fields optional; sensible defaults
 * capture into in-memory buffers that the harness returns.
 */
export interface RunCliOptions {
  /**
   * Override `process.cwd()` for the duration of the run. Useful for
   * commands like `remnic init` that write into the current directory.
   * Restored to the real cwd in `finally`.
   */
  cwd?: string;
  /**
   * Set these env vars for the duration of the run. Keys mapped to
   * `undefined` are deleted (mimicking `delete process.env[key]`). The
   * previous values are restored in `finally`.
   */
  env?: Record<string, string | undefined>;
  /**
   * Custom stdout sink. Defaults to an in-memory buffer. Useful when a
   * caller wants to stream output directly instead of buffering.
   */
  stdout?: { write: (chunk: string) => void };
  /**
   * Custom stderr sink. Defaults to an in-memory buffer.
   */
  stderr?: { write: (chunk: string) => void };
}

export interface RunCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Sentinel thrown by the intercepted `process.exit` so the dispatcher's
 * synchronous and async exit calls unwind back to `runCli` instead of
 * terminating the test process. The `code` field carries the requested
 * exit code. A unique subclass lets us distinguish a real exit signal from
 * an unrelated error that happens to share its message.
 */
class CliExitSignal extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`remnic: process.exit(${code}) intercepted by runCli`);
    this.name = "CliExitSignal";
    this.code = code;
  }
}

/**
 * Format a `console.*` argument list the way Node's default console does:
 * coerce each argument to a string (objects via `String()`, errors via
 * `.message`, everything else via `String(x)`), join with spaces, and add
 * the trailing newline that console methods insert. Buffering the raw
 * chunks (without the newline) would under-test the formatting that real
 * CLI output relies on.
 */
function formatConsoleArgs(args: unknown[]): string {
  const parts = args.map((arg) => {
    if (arg instanceof Error) return arg.message;
    if (typeof arg === "string") return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  });
  return `${parts.join(" ")}\n`;
}

/**
 * Run the CLI dispatcher in-process and capture its IO + exit code without
 * spawning a child process or terminating the host. See `RunCliOptions`
 * for the overrides.
 *
 * Behaviour contract (matches the `remnic` binary as closely as possible
 * without actually running the auto-run guard at the bottom of index.ts):
 *   - stdout/stderr writes (whether via `process.stdout.write`, `console.log`,
 *     `console.error`, `console.warn`, or `console.info`) are captured.
 *   - `process.exit(N)` is captured as `exitCode: N` and unwinds cleanly.
 *   - If `main()` throws (e.g. input validators that throw before any
 *     `process.exit`), the message is captured to stderr and `exitCode` is 1,
 *     mirroring the `.catch` in the binary's auto-runner.
 *   - If `main()` returns normally, `exitCode` is whatever `process.exitCode`
 *     was left at (defaulting to 0).
 *   - All overridden globals are restored in `finally`, so a test failure
 *     cannot leak into the next test.
 */
export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<RunCliResult> {
  if (!Array.isArray(argv)) {
    throw new TypeError("runCli: argv must be an array of strings");
  }

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdout = options.stdout ?? {
    write: (chunk: string) => {
      stdoutChunks.push(chunk);
    },
  };
  const stderr = options.stderr ?? {
    write: (chunk: string) => {
      stderrChunks.push(chunk);
    },
  };

  // ── Snapshot everything we override so `finally` can restore it. ──
  // We swap `process.stdout` / `process.stderr` themselves (not just their
  // `.write` methods) because the test runner's TAP reporter caches a
  // reference to `process.stdout.write` at startup; replacing only the
  // method would silently swallow the reporter's per-test markers and make
  // tests "disappear" from TAP output. The whole-stream swap keeps the
  // runner's reporter intact while still capturing everything the CLI
  // writes through the global `console` (which delegates to
  // `process.stdout` / `process.stderr` at call time).
  const originalProcessExit = process.exit;
  const originalProcessExitCode = process.exitCode;
  const originalProcessCwd = process.cwd;
  const originalStdout = process.stdout;
  const originalStderr = process.stderr;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  const originalConsoleInfo = console.info;
  // Snapshot env values we will touch (only the keys the caller asked us to
  // touch). Anything else stays untouched.
  const envBackups: Array<[string, string | undefined, boolean]> = options.env
    ? Object.entries(options.env).map(([key, value]) => [key, process.env[key], key in process.env])
    : [];

  // Build minimal Writable replacements. We only need `.write()` for the
  // CLI's output paths; Node's Console checks for `.write` on its bound
  // streams, so a callable object is enough.
  const fakeStdout = {
    write: (chunk: unknown) => {
      stdout.write(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    },
  };
  const fakeStderr = {
    write: (chunk: unknown) => {
      stderr.write(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    },
  };

  let exitSignal: CliExitSignal | null = null;

  process.exit = ((code?: number) => {
    // Mirrors Node's process.exit: an explicit numeric code wins, otherwise
    // fall back to whatever exitCode was set, then 0. We throw so that both
    // sync and async handlers unwind uniformly back to runCli.
    const rawCode = typeof code === "number" ? code : (process.exitCode ?? 0);
    // Node accepts `process.exitCode = "1"` and coerces to 1; do the same so
    // the captured exitCode is always a finite non-negative integer.
    const resolved = typeof rawCode === "number" ? rawCode : Number(rawCode) || 0;
    const signal = new CliExitSignal(resolved);
    exitSignal = signal;
    throw signal;
  }) as typeof process.exit;

  if (options.cwd !== undefined) {
    process.cwd = () => options.cwd as string;
  }

  for (const [key, value] of options.env ? Object.entries(options.env) : []) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  // Swap the stream objects, not the methods. `defineProperty` is used
  // because `process.stdout` / `process.stderr` are read-only getters on
  // the process object in modern Node; a plain assignment throws.
  Object.defineProperty(process, "stdout", { value: fakeStdout, configurable: true });
  Object.defineProperty(process, "stderr", { value: fakeStderr, configurable: true });
  console.log = (...args: unknown[]) => {
    stdout.write(formatConsoleArgs(args));
  };
  console.error = (...args: unknown[]) => {
    stderr.write(formatConsoleArgs(args));
  };
  console.warn = (...args: unknown[]) => {
    stderr.write(formatConsoleArgs(args));
  };
  console.info = (...args: unknown[]) => {
    stdout.write(formatConsoleArgs(args));
  };

  // Reset exitCode at entry — the binary starts each invocation at 0 and
  // lets handlers raise it. Snapshotting/restoring the original above keeps
  // the host test process safe; resetting at entry keeps each runCli call
  // independent of the previous one.
  process.exitCode = 0;

  try {
    await main(argv);
    return {
      exitCode: process.exitCode ?? 0,
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
    };
  } catch (error) {
    if (error instanceof CliExitSignal) {
      // The dispatcher (or a transitive call) asked to exit. The buffered
      // output is what the user would have seen — including any error
      // message it wrote before the exit call.
      return {
        exitCode: error.code,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
      };
    }
    // Mirrors the binary's `.catch` handler: an uncaught throw becomes a
    // `Fatal: <message>` line on stderr + exit 1.
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`Fatal: ${message}\n`);
    return {
      exitCode: 1,
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
    };
  } finally {
    process.exit = originalProcessExit;
    process.cwd = originalProcessCwd;
    Object.defineProperty(process, "stdout", { value: originalStdout, configurable: true });
    Object.defineProperty(process, "stderr", { value: originalStderr, configurable: true });
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    console.info = originalConsoleInfo;
    for (const [key, prevValue, hadKey] of envBackups) {
      if (hadKey && typeof prevValue === "string") {
        process.env[key] = prevValue;
      } else {
        delete process.env[key];
      }
    }
    // Restore exitCode last so finally itself doesn't accidentally propagate
    // the run's exitCode back to the host test runner.
    process.exitCode = originalProcessExitCode;
    exitSignal = null;
  }
}
