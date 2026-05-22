#!/usr/bin/env node
/**
 * @remnic/plugin-codex materialize binary.
 *
 * This is the packaged runtime entrypoint the session-end hook calls when a
 * user runs Remnic inside a published install. The hook used to shell out
 * to `scripts/codex-materialize.ts` via tsx, but that file is NOT shipped in
 * any published package payload — only developer source checkouts have it.
 * See PR #392 review thread PRRT_kwDORJXyws56TOVo.
 *
 * This wrapper:
 *  1. Loads the published `@remnic/core` ESM bundle via dynamic import.
 *  2. Re-parses argv in the same shape `scripts/codex-materialize.ts` uses
 *     (`--namespace`, `--codex-home`, `--memory-dir`, `--reason`, `--json`).
 *  3. Resolves the user's OpenClaw/Remnic config from the same search paths
 *     the dev script uses, so behavior is identical between dev and
 *     distributed installs.
 *  4. Delegates to `runCodexMaterialize` and surfaces the result.
 *
 * Exits 0 on success (including intentional skips), non-zero only on hard
 * failures callers actually need to notice.
 */

/* eslint-disable no-console */

"use strict";

const path = require("node:path");
const fs = require("node:fs");

function parseArgs(argv) {
  const args = {
    namespace: undefined,
    codexHome: undefined,
    memoryDir: undefined,
    reason: "cli",
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--namespace":
      case "-n":
        args.namespace = argv[++i];
        break;
      case "--codex-home":
        args.codexHome = argv[++i];
        break;
      case "--memory-dir":
        args.memoryDir = argv[++i];
        break;
      case "--reason":
        args.reason = argv[++i] || "cli";
        break;
      case "--json":
        args.json = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        // ignore unknown tokens — keeps the hook loosely coupled
        break;
    }
  }
  return args;
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const OPENCLAW_REMNIC_PLUGIN_IDS = ["openclaw-remnic", "openclaw-engram"];

function getOpenClawPluginEntries(raw) {
  const plugins = isPlainRecord(raw.plugins) ? raw.plugins : undefined;
  return plugins && isPlainRecord(plugins.entries) ? plugins.entries : undefined;
}

function getOpenClawMemorySlotId(raw) {
  const plugins = isPlainRecord(raw.plugins) ? raw.plugins : undefined;
  const slots = plugins && isPlainRecord(plugins.slots) ? plugins.slots : undefined;
  return typeof slots?.memory === "string" ? slots.memory : undefined;
}

function resolveOpenClawRemnicPluginEntry(raw, resolveEntry) {
  return resolveEntry(raw, {
    candidateIds: OPENCLAW_REMNIC_PLUGIN_IDS,
    getEntries: getOpenClawPluginEntries,
    getSlotId: getOpenClawMemorySlotId,
  });
}

class MaterializeConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "MaterializeConfigError";
  }
}

function envValue(env, key) {
  const value = env[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function expandConfigPathForEnv(filePath, home) {
  if (filePath === undefined) return undefined;
  if (filePath === "~") return home.length > 0 ? home : filePath;
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return home.length > 0 ? path.join(home, filePath.slice(2)) : filePath;
  }
  return filePath;
}

function safeErrorDetail(error) {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\w .,:;()[\]{}'"!?/@+-]/g, "?")
    .trim();
  return cleaned.length > 240 ? `${cleaned.slice(0, 237)}...` : cleaned;
}

/**
 * Return candidate config file paths to search, in priority order.
 * The caller is responsible for parsing and entry-resolution.
 */
function configCandidates(env = process.env) {
  const home = envValue(env, "HOME") || "";
  const openclawConfigPath =
    envValue(env, "OPENCLAW_CONFIG_PATH") ||
    envValue(env, "OPENCLAW_ENGRAM_CONFIG_PATH") ||
    path.join(home, ".openclaw", "openclaw.json");
  return [
    {
      path: expandConfigPathForEnv(envValue(env, "REMNIC_CONFIG"), home),
      label: "REMNIC_CONFIG",
    },
    {
      path: expandConfigPathForEnv(openclawConfigPath, home),
      label:
        envValue(env, "OPENCLAW_CONFIG_PATH") !== undefined
          ? "OPENCLAW_CONFIG_PATH"
          : envValue(env, "OPENCLAW_ENGRAM_CONFIG_PATH") !== undefined
            ? "OPENCLAW_ENGRAM_CONFIG_PATH"
            : "default OpenClaw config",
    },
    path.join(home, ".config", "remnic", "config.json"),
    path.join(home, ".config", "engram", "config.json"),
    path.join(home, ".remnic", "config.json"),
  ]
    .map((candidate) => {
      return typeof candidate === "string"
        ? { path: candidate, label: candidate }
        : candidate;
    })
    .filter(
      (candidate) =>
        typeof candidate.path === "string" && candidate.path.length > 0,
    );
}

function extractRemnicConfigFromRaw(raw, resolveEntry) {
  const entry = resolveOpenClawRemnicPluginEntry(raw, resolveEntry);
  if (isPlainRecord(entry)) {
    return isPlainRecord(entry.config) ? entry.config : entry;
  }
  // Legacy / developer config layout: the top-level object IS the config.
  // Honour it only when the file is not an OpenClaw-shaped config.
  if (!Object.prototype.hasOwnProperty.call(raw, "plugins")) {
    return raw;
  }
  return undefined;
}

/**
 * Load the Remnic plugin config block from the first matching config file.
 *
 * Entry resolution is delegated to the generic plugin-entry resolver from
 * `@remnic/core` with OpenClaw ids supplied by this adapter wrapper.
 *
 * @param {Function} resolveEntry - resolvePluginEntry from @remnic/core
 * @param {NodeJS.ProcessEnv} env - environment override for tests
 */
function loadRawConfig(resolveEntry, env = process.env) {
  for (const candidate of configCandidates(env)) {
    if (!fs.existsSync(candidate.path)) continue;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(candidate.path, "utf-8"));
    } catch (err) {
      throw new MaterializeConfigError(
        `codex-materialize config error: invalid JSON in ${candidate.label} (${candidate.path}): ${safeErrorDetail(err)}`,
      );
    }
    if (!isPlainRecord(raw)) {
      throw new MaterializeConfigError(
        `codex-materialize config error: invalid config in ${candidate.label} (${candidate.path}): expected a JSON object`,
      );
    }
    const resolved = extractRemnicConfigFromRaw(raw, resolveEntry);
    if (resolved) {
      return resolved;
    }
  }
  return {};
}

function printHelp() {
  console.log(
    [
      "codex-materialize — render Remnic memories into ~/.codex/memories/",
      "",
      "Usage: node bin/materialize.cjs [options]",
      "",
      "Options:",
      "  --namespace <name>    Namespace to materialize (default: config / 'default')",
      "  --memory-dir <path>   Override memory directory",
      "  --codex-home <path>   Override <codex_home>",
      "  --reason <string>     Logged reason tag (cli | session_end | consolidation | manual)",
      "  --json                Emit the result as JSON",
      "  -h, --help            Show this help",
    ].join("\n"),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  // Dynamic import because @remnic/core is ESM-only.
  const core = await import("@remnic/core");
  const { parseConfig, runCodexMaterialize, resolvePluginEntry } = core;
  if (
    typeof parseConfig !== "function" ||
    typeof runCodexMaterialize !== "function" ||
    typeof resolvePluginEntry !== "function"
  ) {
    throw new Error(
      "codex-materialize: @remnic/core is missing expected exports (parseConfig, runCodexMaterialize, resolvePluginEntry)",
    );
  }

  // Pass the generic resolver so loadRawConfig uses the same slot → id lookup
  // semantics as the other OpenClaw config-loader sites (#403).
  const rawConfig = loadRawConfig(resolvePluginEntry);
  let config;
  try {
    config = parseConfig(rawConfig);
  } catch (err) {
    throw new MaterializeConfigError(
      `codex-materialize config error: parseConfig rejected the resolved config: ${safeErrorDetail(err)}`,
    );
  }
  if (args.memoryDir) {
    // parseConfig already locked in a memoryDir, but the CLI override wins.
    config.memoryDir = args.memoryDir;
  }

  const result = await runCodexMaterialize({
    config,
    namespace: args.namespace,
    memoryDir: args.memoryDir,
    codexHome: args.codexHome,
    reason: args.reason,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result === null) {
    console.log("codex-materialize: skipped (disabled or guarded)");
  } else if (result.skippedNoSentinel) {
    console.log(
      `codex-materialize: sentinel missing in ${result.memoriesDir}; skipped to honor hand-edits`,
    );
  } else if (result.skippedIdempotent) {
    console.log(
      `codex-materialize: no changes for namespace=${result.namespace} (hash unchanged)`,
    );
  } else {
    console.log(
      `codex-materialize: wrote ${result.filesWritten.length} file(s) for namespace=${result.namespace}`,
    );
  }

  return 0;
}

module.exports = {
  configCandidates,
  extractRemnicConfigFromRaw,
  loadRawConfig,
};

function formatFatalError(error) {
  if (error instanceof MaterializeConfigError) {
    return error.message;
  }
  return "codex-materialize failed; see logs for details";
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(formatFatalError(error));
      process.exit(1);
    },
  );
}
