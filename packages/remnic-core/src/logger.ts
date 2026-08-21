export interface LoggerBackend {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug?(msg: string, ...args: unknown[]): void;
}

const NOOP_LOGGER: LoggerBackend = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

export interface LoggerOptions {
  /** Prefix each emitted line with an ISO 8601 timestamp. Defaults to true. */
  timestamps?: boolean;
  /** Clock source for the timestamp prefix; injectable for tests. */
  clock?: () => string;
}

let _backend: LoggerBackend = NOOP_LOGGER;
let _debug = false;
let _timestamps = true;
let _clock: () => string = () => new Date().toISOString();

// Coerce a boolean-like env string. Empty/whitespace-only and unrecognized
// values return undefined so callers fall through to the default (timestamps
// on) rather than silently disabling — an empty env var reads as "unset".
function coerceBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const s = value.trim().toLowerCase();
  if (s === "") return undefined;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  return undefined;
}

// Late-bind console.* rather than capturing references at module import
// time. In production this is behaviour-identical to the pre-bound
// `.bind(console)` form — `console.info(msg, ...)` resolves `this` to
// `console` whether called directly or via an arrow wrapper — but it lets
// harnesses that swap console methods (e.g. runCli in @remnic/cli) route
// logger output through their capture sinks. With the old pre-bound form,
// any command that called initLogger() pinned the logger to the original
// console methods before the harness could swap them, so log.warn /
// log.info output escaped the capture buffer.
const CONSOLE_LOGGER: LoggerBackend = {
  info: (msg, ...args) => console.info(msg, ...args),
  warn: (msg, ...args) => console.warn(msg, ...args),
  error: (msg, ...args) => console.error(msg, ...args),
  debug: (msg, ...args) => console.debug(msg, ...args),
};

export function initLogger(backend?: LoggerBackend, debug?: boolean, options?: LoggerOptions): void {
  _backend = backend ?? CONSOLE_LOGGER;
  _debug = debug ?? false;
  // Precedence: explicit option > REMNIC_LOG_TIMESTAMPS env > default (on).
  _timestamps = options?.timestamps ?? coerceBool(process.env.REMNIC_LOG_TIMESTAMPS) ?? true;
  _clock = options?.clock ?? (() => new Date().toISOString());
}

// Whether a real backend has been installed via initLogger. Lets diagnostics
// that must not be swallowed (config misconfiguration warnings) fall back to
// console when a host-agnostic consumer uses core without calling initLogger.
export function isLoggerInitialized(): boolean {
  return _backend !== NOOP_LOGGER;
}

// Restore the pristine no-op backend (as at module load, before initLogger).
// Primarily a test seam for exercising the standalone/no-host path.
export function resetLogger(): void {
  _backend = NOOP_LOGGER;
  _debug = false;
  _timestamps = true;
  _clock = () => new Date().toISOString();
}

// Format one log line: "<iso> remnic: <msg>" when timestamps are enabled,
// otherwise the legacy "remnic: <msg>". Timestamp is per-call.
function fmt(msg: string, label = "remnic"): string {
  const ts = _timestamps ? `${_clock()} ` : "";
  return `${ts}${label}: ${msg}`;
}

export const log = {
  info(msg: string, ...args: unknown[]): void {
    _backend.info(fmt(msg), ...args);
  },
  warn(msg: string, ...args: unknown[]): void {
    _backend.warn(fmt(msg), ...args);
  },
  error(msg: string, err?: unknown): void {
    const detail = err instanceof Error ? err.message : err ? String(err) : "";
    _backend.error(fmt(`${msg}${detail ? ` — ${detail}` : ""}`));
  },
  debug(msg: string, ...args: unknown[]): void {
    if (!_debug) return;
    const fn = _backend.debug ?? _backend.info;
    fn(fmt(msg, "remnic [debug]"), ...args);
  },
};
