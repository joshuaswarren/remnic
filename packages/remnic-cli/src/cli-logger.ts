import { initLogger } from "@remnic/core";

/**
 * Logger backend that writes every level to stderr.
 * Use when the command's primary payload is machine-readable JSON on stdout
 * so progress lines cannot corrupt the JSON body (issue #3139).
 */
const STDERR_LOGGER = {
  info: (msg: string, ...args: unknown[]) => console.error(msg, ...args),
  warn: (msg: string, ...args: unknown[]) => console.error(msg, ...args),
  error: (msg: string, ...args: unknown[]) => console.error(msg, ...args),
  debug: (msg: string, ...args: unknown[]) => console.error(msg, ...args),
};

/**
 * Install the CLI logger. When `jsonMode` is true, all levels go to stderr
 * so stdout stays a clean JSON document for callers that parse it.
 */
export function initCliLogger(jsonMode = false): void {
  if (jsonMode) {
    initLogger(STDERR_LOGGER);
    return;
  }
  initLogger();
}
