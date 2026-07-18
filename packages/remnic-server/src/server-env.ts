/**
 * @remnic/server — environment-sourced server config.
 *
 * Extracted from index.ts (issue #2029): keeps the env → server-config surface
 * in one place and keeps index.ts under its structural size ceiling. Values are
 * returned as raw strings; `parseServerConfig` coerces/validates them.
 */

import type { ServerConfig } from "./index.js";

/**
 * Read an env var by its current `REMNIC_` name, falling back to the legacy
 * `ENGRAM_` name.
 */
export function readCompatEnv(primary: string, legacy: string): string | undefined {
  return process.env[primary] ?? process.env[legacy];
}

/**
 * Collect server-config overrides sourced from environment variables. Merged
 * over file config (file < env < cli) by the server startup path.
 */
export function envOverrides(): Partial<ServerConfig["server"]> & { remnic?: Record<string, unknown> } {
  const overrides: Record<string, unknown> = {};
  const remnic: Record<string, unknown> = {};

  const port = readCompatEnv("REMNIC_PORT", "ENGRAM_PORT");
  const host = readCompatEnv("REMNIC_HOST", "ENGRAM_HOST");
  const authToken = readCompatEnv("REMNIC_AUTH_TOKEN", "ENGRAM_AUTH_TOKEN");
  const adminConsoleEnabled = readCompatEnv("REMNIC_ADMIN_CONSOLE_ENABLED", "ENGRAM_ADMIN_CONSOLE_ENABLED");
  const adminConsolePublicDir = readCompatEnv("REMNIC_ADMIN_CONSOLE_PUBLIC_DIR", "ENGRAM_ADMIN_CONSOLE_PUBLIC_DIR");
  const adminConsolePrefillToken = readCompatEnv("REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN", "ENGRAM_ADMIN_CONSOLE_PREFILL_TOKEN");
  const readinessOverride = process.env.REMNIC_READY_OVERRIDE;
  // issue #2029: size the global write rate limit from env. The standalone
  // server already honors `server.writeRateLimit*` in config; this makes it
  // settable via the launchd/systemd environment without editing config.json.
  const writeRateLimitMaxRequests = readCompatEnv(
    "REMNIC_WRITE_RATE_LIMIT_MAX_REQUESTS",
    "ENGRAM_WRITE_RATE_LIMIT_MAX_REQUESTS",
  );
  const writeRateLimitWindowMs = readCompatEnv(
    "REMNIC_WRITE_RATE_LIMIT_WINDOW_MS",
    "ENGRAM_WRITE_RATE_LIMIT_WINDOW_MS",
  );
  if (port) overrides.port = port;
  if (host) overrides.host = host;
  if (authToken) overrides.authToken = authToken;
  if (adminConsoleEnabled) overrides.adminConsoleEnabled = adminConsoleEnabled;
  if (adminConsolePublicDir) overrides.adminConsolePublicDir = adminConsolePublicDir;
  if (adminConsolePrefillToken) overrides.adminConsolePrefillToken = adminConsolePrefillToken;
  if (readinessOverride !== undefined) overrides.readinessOverride = readinessOverride;
  if (writeRateLimitMaxRequests) overrides.writeRateLimitMaxRequests = writeRateLimitMaxRequests;
  if (writeRateLimitWindowMs) overrides.writeRateLimitWindowMs = writeRateLimitWindowMs;

  if (process.env.OPENAI_API_KEY) remnic.openaiApiKey = process.env.OPENAI_API_KEY;
  const memoryDir = readCompatEnv("REMNIC_MEMORY_DIR", "ENGRAM_MEMORY_DIR");
  if (memoryDir) remnic.memoryDir = memoryDir;

  return { ...overrides, ...(Object.keys(remnic).length > 0 ? { remnic } : {}) };
}
