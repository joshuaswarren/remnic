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

let _backend: LoggerBackend = NOOP_LOGGER;
let _debug = false;

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

export function initLogger(backend?: LoggerBackend, debug?: boolean): void {
  _backend = backend ?? CONSOLE_LOGGER;
  _debug = debug ?? false;
}

export const log = {
  info(msg: string, ...args: unknown[]): void {
    _backend.info(`remnic: ${msg}`, ...args);
  },
  warn(msg: string, ...args: unknown[]): void {
    _backend.warn(`remnic: ${msg}`, ...args);
  },
  error(msg: string, err?: unknown): void {
    const detail =
      err instanceof Error ? err.message : err ? String(err) : "";
    _backend.error(
      `remnic: ${msg}${detail ? ` — ${detail}` : ""}`,
    );
  },
  debug(msg: string, ...args: unknown[]): void {
    if (!_debug) return;
    const fn = _backend.debug ?? _backend.info;
    fn(`remnic [debug]: ${msg}`, ...args);
  },
};
