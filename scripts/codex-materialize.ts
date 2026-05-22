#!/usr/bin/env tsx
/**
 * codex-materialize.ts — thin CLI entrypoint for Codex memory materialization.
 *
 * Intended caller: `packages/plugin-codex/hooks/bin/session-end.sh` (via tsx)
 * and operators debugging materialization. Keeps the hook edit minimal — the
 * shell hook just shells out to this script with a namespace.
 *
 * Usage:
 *   tsx scripts/codex-materialize.ts [--namespace <name>] [--codex-home <path>] \
 *     [--memory-dir <path>] [--reason <string>] [--json]
 *
 * Exits 0 on success (including intentional no-op skips), non-zero only on
 * hard failures the caller needs to notice.
 */

import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { parseConfig } from "../packages/remnic-core/src/config.js";
import { runCodexMaterialize } from "../packages/remnic-core/src/connectors/codex-materialize-runner.js";
import { resolvePluginEntry } from "../packages/remnic-core/src/plugin-entry-resolver.js";

const OPENCLAW_REMNIC_PLUGIN_IDS = ["openclaw-remnic", "openclaw-engram"] as const;

interface Args {
  namespace?: string;
  codexHome?: string;
  memoryDir?: string;
  reason: "session_end" | "manual" | "cli" | "consolidation";
  json: boolean;
  help: boolean;
}

function getOpenClawPluginEntries(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const plugins =
    raw["plugins"] && typeof raw["plugins"] === "object" && !Array.isArray(raw["plugins"])
      ? (raw["plugins"] as Record<string, unknown>)
      : undefined;
  const entries =
    plugins && plugins["entries"] && typeof plugins["entries"] === "object" && !Array.isArray(plugins["entries"])
      ? (plugins["entries"] as Record<string, unknown>)
      : undefined;
  return entries;
}

function getOpenClawMemorySlotId(raw: Record<string, unknown>): string | undefined {
  const plugins =
    raw["plugins"] && typeof raw["plugins"] === "object" && !Array.isArray(raw["plugins"])
      ? (raw["plugins"] as Record<string, unknown>)
      : undefined;
  const slots =
    plugins && plugins["slots"] && typeof plugins["slots"] === "object" && !Array.isArray(plugins["slots"])
      ? (plugins["slots"] as Record<string, unknown>)
      : undefined;
  const slotId = slots?.["memory"];
  return typeof slotId === "string" ? slotId : undefined;
}

function resolveOpenClawRemnicPluginEntry(raw: unknown): Record<string, unknown> | undefined {
  return resolvePluginEntry(raw, {
    candidateIds: OPENCLAW_REMNIC_PLUGIN_IDS,
    getEntries: getOpenClawPluginEntries,
    getSlotId: getOpenClawMemorySlotId,
  });
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    reason: "cli",
    json: false,
    help: false,
  };
  const readRequiredValue = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) {
      throw new CliUsageError(`${flag} requires a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--namespace":
      case "-n":
        args.namespace = readRequiredValue(i, a);
        i += 1;
        break;
      case "--codex-home":
        args.codexHome = readRequiredValue(i, a);
        i += 1;
        break;
      case "--memory-dir":
        args.memoryDir = readRequiredValue(i, a);
        i += 1;
        break;
      case "--reason":
        args.reason = readRequiredValue(i, a) as Args["reason"];
        i += 1;
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

interface ConfigCandidate {
  path: string;
  label: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class MaterializeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterializeConfigError";
  }
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function expandConfigPathForEnv(filePath: string | undefined, home: string): string | undefined {
  if (filePath === undefined) return undefined;
  if (filePath === "~") return home.length > 0 ? home : filePath;
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return home.length > 0 ? path.join(home, filePath.slice(2)) : filePath;
  }
  return filePath;
}

function safeErrorDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\w .,:;()[\]{}'"!?/@+-]/g, "?")
    .trim();
  return cleaned.length > 240 ? `${cleaned.slice(0, 237)}...` : cleaned;
}

export function configCandidates(
  env: NodeJS.ProcessEnv = process.env,
): ConfigCandidate[] {
  const home = envValue(env, "HOME") ?? "";
  const openclawConfigPath =
    envValue(env, "OPENCLAW_CONFIG_PATH") ??
    envValue(env, "OPENCLAW_ENGRAM_CONFIG_PATH") ??
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
    {
      path: path.join(home, ".config", "remnic", "config.json"),
      label: "default Remnic config",
    },
    {
      path: path.join(home, ".config", "engram", "config.json"),
      label: "legacy Engram config",
    },
    {
      path: path.join(home, ".remnic", "config.json"),
      label: "legacy Remnic config",
    },
  ].filter((candidate): candidate is ConfigCandidate => {
    return typeof candidate.path === "string" && candidate.path.length > 0;
  });
}

export function extractRemnicConfigFromRaw(
  raw: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const entry = resolveOpenClawRemnicPluginEntry(raw);
  if (isPlainRecord(entry)) {
    const config = entry["config"];
    return isPlainRecord(config) ? config : entry;
  }
  // Legacy / developer config layout: the top-level object IS the plugin
  // config. Only accept it when this is not an OpenClaw-shaped config.
  if (!Object.prototype.hasOwnProperty.call(raw, "plugins")) {
    return raw;
  }
  return undefined;
}

export function loadRawConfig(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  // Try the common config locations without importing bootstrap.ts (which
  // pulls in the full orchestrator). A missing config is fine — parseConfig
  // produces sane defaults.
  //
  // Order of precedence:
  //   1. `REMNIC_CONFIG` env var (developer escape hatch)
  //   2. `OPENCLAW_CONFIG_PATH` / `OPENCLAW_ENGRAM_CONFIG_PATH` — the same
  //      env vars the Remnic plugin reads at runtime
  //   3. `~/.openclaw/openclaw.json` — standard OpenClaw install location
  //   4. Legacy `~/.config/remnic/config.json`, `~/.config/engram/config.json`,
  //      `~/.remnic/config.json`
  //
  // OpenClaw-shaped configs are resolved through the shared slot-aware helper.
  for (const candidate of configCandidates(env)) {
    if (!fs.existsSync(candidate.path)) continue;
    let raw: unknown;
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
    const resolved = extractRemnicConfigFromRaw(raw);
    if (resolved) {
      return resolved;
    }
  }
  return {};
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    // eslint-disable-next-line no-console
    console.log(
      [
        "codex-materialize — render Remnic memories into ~/.codex/memories/",
        "",
        "Usage: tsx scripts/codex-materialize.ts [options]",
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
    return 0;
  }

  const rawConfig = loadRawConfig();
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
    (config as unknown as Record<string, unknown>).memoryDir = args.memoryDir;
  }

  const result = await runCodexMaterialize({
    config,
    namespace: args.namespace,
    memoryDir: args.memoryDir,
    codexHome: args.codexHome,
    reason: args.reason,
  });

  if (args.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
  } else if (result === null) {
    // eslint-disable-next-line no-console
    console.log("codex-materialize: skipped (disabled or guarded)");
  } else if (result.skippedNoSentinel) {
    // eslint-disable-next-line no-console
    console.log(
      `codex-materialize: sentinel missing in ${result.memoriesDir}; skipped to honor hand-edits`,
    );
  } else if (result.skippedIdempotent) {
    // eslint-disable-next-line no-console
    console.log(
      `codex-materialize: no changes for namespace=${result.namespace} (hash unchanged)`,
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `codex-materialize: wrote ${result.filesWritten.length} file(s) for namespace=${result.namespace}`,
    );
  }

  return 0;
}

function isCliEntrypoint(): boolean {
  return process.argv[1] !== undefined
    ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
    : false;
}

function formatFatalError(error?: unknown): string {
  if (error instanceof CliUsageError) {
    return `codex-materialize usage error: ${error.message}`;
  }
  if (error instanceof MaterializeConfigError) {
    return error.message;
  }
  return "codex-materialize failed; see logs for details";
}

if (isCliEntrypoint()) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      // eslint-disable-next-line no-console
      console.error(formatFatalError(error));
      process.exit(1);
    },
  );
}
