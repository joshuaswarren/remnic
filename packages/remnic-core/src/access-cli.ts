import fs from "node:fs";
import path from "node:path";
import { parseConfig } from "./config.js";
import type { PluginConfig } from "./types.js";
import { Orchestrator } from "./orchestrator.js";
import { EngramAccessService } from "./access-service.js";
import { readEnvVar, resolveHomeDir } from "./runtime/env.js";
import { resolveRemnicPluginEntry } from "./plugin-id.js";

type CommandName = "browse" | "store";

type ParsedArgs = {
  command: CommandName;
  options: Record<string, string[]>;
  flags: Set<string>;
};

type CommandSpec = {
  valueOptions: ReadonlySet<string>;
  flagOptions: ReadonlySet<string>;
};

type Runtime = {
  config: PluginConfig;
  service: EngramAccessService;
};

export type AccessCliOptions = {
  /**
   * The calling plugin's own id (e.g. `"openclaw-engram"` when invoked by the
   * shim binary).  Forwarded to {@link resolveRemnicPluginEntry} so shim CLI
   * users target their own `plugins.entries["openclaw-engram"]` block instead
   * of accidentally resolving to the canonical `"openclaw-remnic"` entry when
   * `plugins.slots.memory` is unset (#403).
   */
  preferredId?: string;
};

type UsageErrorKind =
  | "unsupported-command"
  | "unexpected-positional"
  | "unknown-option"
  | "option-does-not-take-value"
  | "missing-option"
  | "missing-content"
  | "invalid-integer"
  | "invalid-number";

class UsageError extends Error {
  constructor(
    readonly kind: UsageErrorKind,
    readonly optionName?: string,
  ) {
    super("invalid access-cli arguments");
  }
}

function formatUsageError(error: UsageError): string {
  switch (error.kind) {
    case "unsupported-command":
      return "unsupported command";
    case "unexpected-positional":
      return "unexpected positional argument";
    case "unknown-option":
      return `unknown option: --${error.optionName ?? "unknown"}`;
    case "option-does-not-take-value":
      return `option does not accept a value: --${error.optionName ?? "unknown"}`;
    case "missing-option":
      return `missing required option: --${error.optionName ?? "unknown"}`;
    case "missing-content":
      return "missing required option: --content or --content-file";
    case "invalid-integer":
      return `invalid integer for --${error.optionName ?? "unknown"}`;
    case "invalid-number":
      return `invalid number for --${error.optionName ?? "unknown"}`;
  }
}

function writeCliOutput(text: string = ""): void {
  process.stdout.write(`${text}\n`);
}

function usage(): string {
  return [
    "Usage:",
    "  engram-access browse [options]",
    "  engram-access store [options]",
    "",
    "Browse options:",
    "  --namespace <name>",
    "  --query <text>",
    "  --category <name>",
    "  --status <name>",
    "  --sort <updated_desc|updated_asc|created_desc|created_asc>",
    "  --limit <n>",
    "  --offset <n>",
    "",
    "Store options:",
    "  --namespace <name>",
    "  --session-key <key>",
    "  --principal <principal>",
    "  --content <text> | --content-file <path>",
    "  --category <name>",
    "  --confidence <0-1>",
    "  --tag <tag> (repeatable)",
    "  --entity-ref <ref>",
    "  --ttl <duration>",
    "  --source-reason <text>",
    "  --idempotency-key <key>",
    "  --dry-run",
  ].join("\n");
}

const COMMAND_SPECS: Record<CommandName, CommandSpec> = {
  browse: {
    valueOptions: new Set([
      "namespace",
      "query",
      "category",
      "status",
      "sort",
      "limit",
      "offset",
    ]),
    flagOptions: new Set(),
  },
  store: {
    valueOptions: new Set([
      "namespace",
      "session-key",
      "principal",
      "content",
      "content-file",
      "category",
      "confidence",
      "tag",
      "entity-ref",
      "ttl",
      "source-reason",
      "idempotency-key",
    ]),
    flagOptions: new Set(["dry-run"]),
  },
};

function parseArgs(argv: string[]): ParsedArgs {
  const [commandRaw, ...rest] = argv;
  if (commandRaw !== "browse" && commandRaw !== "store") {
    throw new UsageError("unsupported-command");
  }
  const spec = COMMAND_SPECS[commandRaw];

  const options: Record<string, string[]> = {};
  const flags = new Set<string>();

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      throw new UsageError("unexpected-positional");
    }
    const rawKey = token.slice(2);
    if (!rawKey) {
      throw new UsageError("unknown-option", rawKey);
    }
    const equalsIndex = rawKey.indexOf("=");
    const key = equalsIndex === -1 ? rawKey : rawKey.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : rawKey.slice(equalsIndex + 1);

    if (!spec.valueOptions.has(key) && !spec.flagOptions.has(key)) {
      throw new UsageError("unknown-option", key);
    }

    if (spec.flagOptions.has(key)) {
      if (inlineValue !== undefined) {
        throw new UsageError("option-does-not-take-value", key);
      }
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        throw new UsageError("option-does-not-take-value", key);
      }
      flags.add(key);
      continue;
    }

    if (inlineValue !== undefined) {
      if (inlineValue.length === 0) {
        throw new UsageError("missing-option", key);
      }
      if (!options[key]) {
        options[key] = [];
      }
      options[key].push(inlineValue);
      continue;
    }

    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      throw new UsageError("missing-option", key);
    }
    if (!options[key]) {
      options[key] = [];
    }
    options[key].push(next);
    i += 1;
  }

  return {
    command: commandRaw,
    options,
    flags,
  };
}

function getLastOption(args: ParsedArgs, name: string): string | undefined {
  const values = args.options[name];
  if (!values || values.length === 0) return undefined;
  return values[values.length - 1];
}

function getAllOptions(args: ParsedArgs, name: string): string[] {
  return args.options[name] ?? [];
}

function requireOption(args: ParsedArgs, name: string): string {
  const value = getLastOption(args, name);
  if (!value || value.trim().length === 0) {
    throw new UsageError("missing-option", name);
  }
  return value;
}

function parseIntegerOption(args: ParsedArgs, name: string): number | undefined {
  const raw = getLastOption(args, name);
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new UsageError("invalid-integer", name);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    throw new UsageError("invalid-integer", name);
  }
  return value;
}

function parseFloatOption(
  args: ParsedArgs,
  name: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  const raw = getLastOption(args, name);
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!/^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:e[+-]?\d+)?$/i.test(trimmed)) {
    throw new UsageError("invalid-number", name);
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    throw new UsageError("invalid-number", name);
  }
  if (options.min !== undefined && value < options.min) {
    throw new UsageError("invalid-number", name);
  }
  if (options.max !== undefined && value > options.max) {
    throw new UsageError("invalid-number", name);
  }
  return value;
}

function loadPluginConfig(preferredId?: string): Record<string, unknown> {
  const configPath =
    readEnvVar("OPENCLAW_ENGRAM_CONFIG_PATH") ||
    readEnvVar("OPENCLAW_CONFIG_PATH") ||
    path.join(resolveHomeDir(), ".openclaw", "openclaw.json");
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  // Delegate slot → preferredId → PLUGIN_ID → LEGACY_PLUGIN_ID resolution to
  // the shared helper so all config loaders stay in sync (#403).  Shim CLI
  // callers pass `preferredId: "openclaw-engram"` so legacy shim installs
  // target their own config block instead of falling through to the canonical
  // "openclaw-remnic" entry.
  const entry = resolveRemnicPluginEntry(raw, preferredId);
  return (entry?.["config"] as Record<string, unknown> | undefined) ?? {};
}

function buildRuntime(preferredId?: string): Runtime {
  const config = parseConfig(loadPluginConfig(preferredId));
  return {
    config,
    service: new EngramAccessService(new Orchestrator(config)),
  };
}

async function runBrowse(args: ParsedArgs, preferredId?: string): Promise<void> {
  const request = {
    namespace: getLastOption(args, "namespace"),
    query: getLastOption(args, "query"),
    category: getLastOption(args, "category"),
    status: getLastOption(args, "status"),
    sort: getLastOption(args, "sort") as "updated_desc" | "updated_asc" | "created_desc" | "created_asc" | undefined,
    limit: parseIntegerOption(args, "limit"),
    offset: parseIntegerOption(args, "offset"),
  };
  const { service } = buildRuntime(preferredId);
  const result = await service.memoryBrowse(request);
  console.log(JSON.stringify(result, null, 2));
}

async function runStore(args: ParsedArgs, preferredId?: string): Promise<void> {
  const contentFile = getLastOption(args, "content-file");
  const inlineContent = getLastOption(args, "content");
  const content = contentFile ? fs.readFileSync(contentFile, "utf8") : inlineContent;
  if (!content || content.trim().length === 0) {
    throw new UsageError("missing-content");
  }
  const storeArgs = {
    namespace: getLastOption(args, "namespace"),
    sessionKey: getLastOption(args, "session-key"),
    content,
    category: requireOption(args, "category"),
    confidence: parseFloatOption(args, "confidence", { min: 0, max: 1 }),
    tags: getAllOptions(args, "tag"),
    entityRef: getLastOption(args, "entity-ref"),
    ttl: getLastOption(args, "ttl"),
    sourceReason: getLastOption(args, "source-reason"),
    idempotencyKey: getLastOption(args, "idempotency-key"),
    dryRun: args.flags.has("dry-run"),
  };

  const { config, service } = buildRuntime(preferredId);
  const result = await service.memoryStore({
    namespace: storeArgs.namespace,
    sessionKey: storeArgs.sessionKey,
    authenticatedPrincipal: getLastOption(args, "principal") ?? config.agentAccessHttp.principal,
    content: storeArgs.content,
    category: storeArgs.category,
    confidence: storeArgs.confidence,
    tags: storeArgs.tags,
    entityRef: storeArgs.entityRef,
    ttl: storeArgs.ttl,
    sourceReason: storeArgs.sourceReason,
    idempotencyKey: storeArgs.idempotencyKey,
    dryRun: storeArgs.dryRun,
  });
  console.log(JSON.stringify(result, null, 2));
}

export async function main(
  argv: string[] = process.argv.slice(2),
  options: AccessCliOptions = {},
): Promise<void> {
  const args = parseArgs(argv);
  if (args.command === "browse") {
    await runBrowse(args, options.preferredId);
    return;
  }
  await runStore(args, options.preferredId);
}

export function printUsage(): void {
  writeCliOutput(usage());
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  options: AccessCliOptions = {},
): Promise<void> {
  try {
    await main(argv, options);
  } catch (error) {
    if (error instanceof UsageError) {
      writeCliOutput(formatUsageError(error));
      writeCliOutput();
      printUsage();
      process.exit(1);
    }

    console.error("access-cli failed");
    process.exit(1);
  }
}
