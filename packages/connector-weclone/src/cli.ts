#!/usr/bin/env node
/**
 * CLI entrypoint for @remnic/connector-weclone.
 *
 * Reads config from ~/.remnic/connectors/weclone.json (or --config path)
 * and starts the OpenAI-compatible memory proxy. `REMNIC_HOME` (or legacy
 * `ENGRAM_HOME`) can override the default home directory — this matches the
 * override honoured by `remnic connectors install weclone` in @remnic/core.
 */

import { createWeCloneProxy } from "./proxy.js";
import { parseConfig, type WeCloneConnectorConfig } from "./config.js";
import { createGracefulShutdownHandler, errorMessage } from "./shutdown.js";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve the default proxy config path. Kept in lockstep with
 * @remnic/core's `resolveWeCloneProxyConfigPath()` so install/run pair up
 * without additional wiring from the caller.
 *
 * Both sides use `path.resolve()` (absolute) — NOT `path.join()` — so a
 * relative override like `REMNIC_HOME=tmp/remnic` is normalized against the
 * current working directory. If core and CLI disagreed on this, a relative
 * override could write the config in one location and read it from another,
 * producing spurious "Config not found" errors right after a successful
 * install.
 *
 * `HOME=""` edge case: treat an empty-string HOME as absent and fall back
 * to `os.homedir()`. The core helper does the same; if they diverged here,
 * install and run would target different directories when `HOME` is
 * cleared (empty string is not nullish, so `?? os.homedir()` does NOT
 * substitute it).
 */
function homeDir(): string {
  const envHome = process.env.HOME;
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function expandTildePath(input: string): string {
  if (input === "~") return homeDir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(homeDir(), input.slice(2));
  }
  return input;
}

function defaultConfigPath(): string {
  const override =
    process.env.REMNIC_HOME && process.env.REMNIC_HOME.length > 0
      ? process.env.REMNIC_HOME
      : process.env.ENGRAM_HOME;
  if (override && override.length > 0) {
    return resolve(expandTildePath(override), "connectors", "weclone.json");
  }
  return resolve(homeDir(), ".remnic", "connectors", "weclone.json");
}

async function main(): Promise<void> {
  // Parse --config first so an explicit path takes precedence over env-var
  // resolution. Only fall back to defaultConfigPath() when the user has not
  // supplied an explicit --config flag. This lets `remnic-weclone-proxy
  // --config /abs/path` work even in environments where REMNIC_HOME is
  // misconfigured, without defaultConfigPath() (and any env-var validation
  // it contains) running unnecessarily.
  const args = process.argv.slice(2);
  let configPath: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config") {
      if (!args[i + 1] || args[i + 1].startsWith("-")) {
        console.error("Error: --config requires a path argument");
        process.exit(1);
      }
      configPath = resolve(expandTildePath(args[i + 1]));
      i++;
    }
  }

  if (configPath === null) {
    configPath = defaultConfigPath();
  }

  if (!existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    console.error("Run: remnic connectors install weclone");
    process.exit(1);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    console.error(`Failed to parse config at ${configPath}: ${errorMessage(err)}`);
    process.exit(1);
  }

  if (typeof raw !== "object" || raw === null) {
    console.error(`Config at ${configPath} must be a JSON object`);
    process.exit(1);
  }

  let config: WeCloneConnectorConfig;
  try {
    config = parseConfig(raw);
  } catch (err) {
    console.error(`Invalid config at ${configPath}: ${errorMessage(err)}`);
    process.exit(1);
  }

  const proxy = createWeCloneProxy(config);
  try {
    await proxy.start();
  } catch (err) {
    console.error(`Failed to start WeClone proxy: ${errorMessage(err)}`);
    process.exit(1);
  }

  console.log(`WeClone memory proxy listening on :${config.proxyPort}`);
  console.log(`  WeClone API: ${config.wecloneApiUrl}`);
  console.log(`  Remnic daemon: ${config.remnicDaemonUrl}`);

  const stopAndExit = createGracefulShutdownHandler(proxy);
  process.on("SIGINT", stopAndExit);
  process.on("SIGTERM", stopAndExit);
}

void main().catch((err) => {
  console.error(`Failed to start WeClone proxy: ${errorMessage(err)}`);
  process.exit(1);
});
