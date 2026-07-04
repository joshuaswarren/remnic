/**
 * In-process entry point for the `remnic` CLI (issue #1532 Phase A).
 *
 * `main()` (in `./index.ts`) is the real dispatcher but it writes directly
 * to `process.stdout` / `process.stderr` and calls `process.exit`, which
 * makes contract testing impossible without spawning a child process per
 * case. `runCli` is the thin wrapper that lets tests invoke the CLI
 * in-process and observe the captured stdout / stderr / exitCode.
 *
 * Build surface: this module is NOT included in the published package
 * (tsup builds only src/index.ts). It is a test-local helper consumed via
 * tsx from source. Phase B may promote it to a public entry point when
 * the registrar table needs an embeddable surface.
 *
 * The wrapper is intentionally minimal: it does NOT re-implement parsing,
 * dispatch, or validation — those still live behind `main()` so behaviour
 * stays identical between the `remnic` binary and the test harness. It only
 * redirects the IO channels and intercepts `process.exit` so the test
 * process survives. Every override is restored in `finally`, even if the
 * dispatcher throws or calls `process.exit(N)`.
 *
 * Limitation: `main()` is imported statically (per project rule
 * ts-no-dynamic-import), so module-scope constants in `index.ts` that read
 * env vars at load time (e.g. PID_FILE, LOG_FILE via resolveHomeDir) are
 * frozen with the host environment before `runCli` can apply `options.env`.
 * The env override IS visible to runtime `process.env` reads inside the
 * dispatcher, but NOT to module-scope initialisers. Tests that need to
 * isolate module-scope env derivatives (HOME-dependent paths, etc.) should
 * use `spawnSync(process.execPath, ...)` instead.
 *
 * Limitation: the intercepted `process.exit` throws a `CliExitSignal` to
 * unwind the stack. Commands with broad try/catch around their exit calls
 * catch this signal before `runCli` does. The signal's message is empty to
 * minimise stderr pollution, but a catch that calls `console.error(err.message)`
 * still emits a blank line. Tests needing byte-exact stderr on such error
 * paths should use subprocess invocation.
 *
 * Limitation: child-process stdio is an OS-level fd redirection, not a
 * JavaScript-stream operation. When a handler passes `process.stderr` (or
 * `process.stdout`) into `child_process` stdio — e.g. `bench datasets
 * download --json` uses `["inherit", process.stderr, "inherit"]` to keep
 * the dataset script's progress off the JSON-bearing stdout — Node resolves
 * the stream to its `.fd` and dup2's the child's output directly to that
 * fd. The fake stream's `.write` is never called for that output, so it
 * is NOT captured in `RunCliResult.stderr`/`stdout`; it lands on the test
 * runner's real fd 2 / fd 1 instead. This matches the real binary (where
 * the same output lands on the terminal's stderr) and is correct for
 * contract testing: the capture buffer records everything the CLI itself
 * emits via `console.*` / `process.stdout.write` / `process.stderr.write`
 * (including CLI-authored error lines like "dataset download script not
 * found"), and only the EXTERNAL child's progress — which is script- and
 * environment-dependent and must not be byte-asserted — bypasses the
 * buffer. TAP protocol travels on stdout; the production path only
 * redirects to stderr, so TAP output is unaffected. Tests that need to
 * assert on a child-process-emitted payload should stub the spawn or use
 * subprocess invocation.
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
    // Empty message: command-level catches that log e.message produce no
    // stderr pollution, matching the binary's immediate-exit behaviour.
    // runCli identifies the signal via instanceof, not message content.
    super();
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
  const originalCwd = process.cwd();
  const originalStdoutDescriptor = Object.getOwnPropertyDescriptor(process, "stdout");
  const originalStderrDescriptor = Object.getOwnPropertyDescriptor(process, "stderr");
  const originalArgv = process.argv;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  const originalConsoleInfo = console.info;
  // Snapshot env values we will touch (only the keys the caller asked us to
  // touch). Anything else stays untouched.
  const envBackups: Array<[string, string | undefined, boolean]> = options.env
    ? Object.entries(options.env).map(([key, value]) => [key, process.env[key], key in process.env])
    : [];

  // Build minimal Writable replacements. We need `.write()` for the CLI's
  // output paths (Node's Console checks for `.write` on its bound streams)
  // AND `.fd` so commands that hand process.stdout / process.stderr to
  // child_process stdio are accepted (see the note on fakeStdout below).
  // Expose the real process fd (1 for stdout, 2 for stderr) on the fake
  // stream so commands that pass process.stdout / process.stderr into
  // child_process stdio (e.g. `bench datasets download --json` redirects
  // the dataset script's stdout to parent stderr) are accepted by Node.
  // Node's child_process only honours a stream-typed stdio entry when it
  // carries a numeric .fd; without one it throws "The argument 'stdio' is
  // invalid". The fd routes the child's output to the real underlying fd
  // (the test runner's stdout/stderr), matching the real binary's
  // behaviour — the captured buffer still records everything the CLI
  // itself writes via console.* / process.stdout.write, just not the
  // child's direct fd writes, which is exactly what contract tests need.
  const fakeStdout = {
    fd: 1,
    write: (chunk: unknown) => {
      stdout.write(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    },
  };
  const fakeStderr = {
    fd: 2,
    write: (chunk: unknown) => {
      stderr.write(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    },
  };

  let exitSignal: CliExitSignal | null = null;

  // All overrides are inside the try so that a setup failure (e.g.
  // process.chdir to a non-existent directory) still triggers finally
  // and restores whatever was already patched. Restoring an un-patched
  // global is a harmless no-op (re-sets the same value).
  try {
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
      // Use process.chdir (not process.cwd = () => ...) so that filesystem
      // APIs receiving relative paths resolve against the override directory,
      // not the test runner's real cwd. Restored in finally via chdir back.
      process.chdir(options.cwd);
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
    // Override argv so commands that read process.argv directly (e.g.
    // writeBenchReproManifestForPackageRun) see the invoked CLI args, not
    // the test runner's parent argv.
    process.argv = [originalArgv[0], originalArgv[1], ...argv];

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
    process.chdir(originalCwd);
    if (originalStdoutDescriptor) {
      Object.defineProperty(process, "stdout", originalStdoutDescriptor);
    }
    if (originalStderrDescriptor) {
      Object.defineProperty(process, "stderr", originalStderrDescriptor);
    }
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    console.info = originalConsoleInfo;
    process.argv = originalArgv;
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
