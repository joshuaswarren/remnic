/**
 * Shared Remnic config-file discovery (issue #2796).
 *
 * One implementation of the candidate order every surface uses: explicit
 * `--config` path, then `REMNIC_CONFIG_PATH`/`ENGRAM_CONFIG_PATH`, then the
 * first existing candidate under cwd, then the home default. The standalone
 * server boots from this order and the CLI resolves `--config`-less commands
 * through it, so the two can never drift onto different files.
 */

import fs from "node:fs";
import path from "node:path";

import { readCompatEnv, resolveHomeDir } from "./runtime/env.js";

export interface DiscoveredConfigPath {
  path: string;
  explicit: boolean;
  source: string;
}

/**
 * Expand a leading home reference — `~`, `~\`, `$HOME`, or `${HOME}` — to the
 * resolved home directory. Union of the historical server (tilde only) and
 * CLI (tilde plus `$HOME` forms) behaviors; every other path passes through
 * unchanged.
 */
function expandHomeReference(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return resolveHomeDir() + p.slice(1);
  }
  const home = resolveHomeDir();
  if (p === "$HOME" || p.startsWith("$HOME/") || p.startsWith("$HOME\\")) {
    return home + p.slice(5);
  }
  if (p === "${HOME}" || p.startsWith("${HOME}/") || p.startsWith("${HOME}\\")) {
    return home + p.slice(7);
  }
  return p;
}

/**
 * Discover the Remnic config file path.
 *
 * A truthy `cliPath` wins, then the `REMNIC_CONFIG_PATH`/`ENGRAM_CONFIG_PATH`
 * env pair, then the first existing file among the cwd and home candidates,
 * then the home default. `explicit` marks operator-supplied paths whose
 * absence must fail loudly instead of falling through to auto-discovery.
 */
export function discoverConfigPath(cliPath?: string): DiscoveredConfigPath {
  if (cliPath) {
    return { path: path.resolve(expandHomeReference(cliPath)), explicit: true, source: "--config" };
  }

  const envPath = readCompatEnv("REMNIC_CONFIG_PATH", "ENGRAM_CONFIG_PATH");
  if (envPath) {
    return {
      path: path.resolve(expandHomeReference(envPath)),
      explicit: true,
      source: "REMNIC_CONFIG_PATH/ENGRAM_CONFIG_PATH",
    };
  }

  const homeDir = resolveHomeDir();
  const candidates = [
    path.join(process.cwd(), "remnic.config.json"),
    path.join(process.cwd(), "engram.config.json"),
    path.join(homeDir, ".config", "remnic", "config.json"),
    path.join(homeDir, ".config", "engram", "config.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return { path: candidate, explicit: false, source: "auto-discovery" };
    }
  }

  return { path: path.join(homeDir, ".config", "remnic", "config.json"), explicit: false, source: "auto-discovery" };
}
