import type { initLogger } from "@remnic/core";

type LoggerBackend = NonNullable<Parameters<typeof initLogger>[0]>;

/**
 * Every level on stderr. Core's default backend keeps `info` and `debug` on
 * stdout, so a `--json` command interleaves log lines with its payload and the
 * consumer's `JSON.parse` fails on anything but log output (issue #3139).
 */
export const STDERR_ONLY_LOGGER: LoggerBackend = {
  info: (msg, ...args) => console.error(msg, ...args),
  warn: (msg, ...args) => console.error(msg, ...args),
  error: (msg, ...args) => console.error(msg, ...args),
  debug: (msg, ...args) => console.error(msg, ...args),
};