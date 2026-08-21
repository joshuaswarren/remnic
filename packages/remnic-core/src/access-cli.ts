import fs from "node:fs";
import path from "node:path";
import { parseConfig } from "./config.js";
import type { PluginConfig } from "./types.js";
import { Orchestrator } from "./orchestrator.js";
import { EngramAccessService } from "./access-service.js";
import { readEnvVar, resolveHomeDir } from "./runtime/env.js";
import { resolvePluginEntry } from "./plugin-entry-resolver.js";
import { expandTildePath } from "./utils/path.js";
import { getOperation } from "./access-boundary.js";
// Importing access-operations registers the pilot boundary operations as a
// side effect; the store command dispatches through the registry (issue #1525).
import "./access-operations.js";
import { projectTagProjectId } from "./coding/coding-namespace.js";

const OPENCLAW_REMNIC_PLUGIN_IDS = ["openclaw-remnic", "openclaw-engram"] as const;

type CommandName =
  | "browse"
  | "store"
  | "extraction-flush"
  | "decision"
  | "architecture"
  | "delta"
  | "correct";

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
   * shim binary).  Forwarded to the plugin-entry resolver so shim CLI
   * users target their own `plugins.entries["openclaw-engram"]` block instead
   * of accidentally resolving to the canonical `"openclaw-remnic"` entry when
   * `plugins.slots.memory` is unset (#403).
   */
  preferredId?: string;
};

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

function resolveOpenClawRemnicPluginEntry(raw: unknown, preferredId?: string): Record<string, unknown> | undefined {
  return resolvePluginEntry(raw, {
    candidateIds: OPENCLAW_REMNIC_PLUGIN_IDS,
    preferredId,
    getEntries: getOpenClawPluginEntries,
    getSlotId: getOpenClawMemorySlotId,
  });
}

function hasAllowedOpenClawRemnicPluginId(value: string): boolean {
  return (OPENCLAW_REMNIC_PLUGIN_IDS as readonly string[]).includes(value);
}

type UsageErrorKind =
  | "unsupported-command"
  | "unexpected-positional"
  | "unknown-option"
  | "invalid-option"
  | "option-does-not-take-value"
  | "missing-option"
  | "missing-content"
  | "invalid-integer"
  | "invalid-number";

class UsageError extends Error {
  constructor(
    readonly kind: UsageErrorKind,
    readonly optionName?: string,
    readonly acceptedValues?: readonly string[],
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
    case "invalid-option": {
      const accepted = error.acceptedValues?.length ? `. Accepted: ${error.acceptedValues.join(", ")}.` : "";
      return `invalid value for --${error.optionName ?? "unknown"}${accepted}`;
    }
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
    "  engram-access browse [options]",
    "  engram-access store [options]",
    "  engram-access extraction-flush [options]",
    "  engram-access decision [options]",
    "  engram-access architecture [options]",
    "  engram-access delta [options]",
    "  engram-access correct [options]",
    "",
    "Browse options:",
    "  --namespace <name>",
    "  --principal <principal>",
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
    "",
    "Extraction flush options:",
    "  --session-key <key>",
    "  --namespace <name>",
    "  --principal <principal>",
    "  --cwd <path>",
    "  --project-tag <tag>",
    "  --deadline-ms <timestamp>",
    "",
    "Decision options:",
    "  --subcommand <list|get|record|supersede>",
    "  --namespace <name>",
    "  --session-key <key>",
    "  --principal <principal>",
    "  --id <id> (get/supersede)",
    "  --title <title> (record/supersede)",
    "  --status <proposed|accepted|superseded|rejected> (record)",
    "  --context <text> (record/supersede)",
    "  --decision <text> (record/supersede)",
    "  --consequences <text> (record/supersede)",
    "  --entity-ref <ref> (repeatable)",
    "  --project-tag <tag> (attach coding context for this invocation)",
    "  --supersedes-id <id> (alias for --id on supersede)",
    "",
    "Architecture options:",
    "  --subcommand <get|refresh>",
    "  --namespace <name>",
    "  --session-key <key>",
    "  --principal <principal>",
    "  --project-tag <tag> (attach coding context for this invocation)",
    "  --repo-root <path> (repo to scan for refresh; defaults to the current directory)",
    "",
    "Correct options (issue #1580 — one plan/apply pipeline for all corrections):",
    "  --text \"<correction>\"          plan a correction from natural language",
    "  --id <memoryId> (repeatable)   explicit target memory ids",
    "  --apply                        apply a pending plan (requires --plan-id + --confirm)",
    "  --plan-id <id>                 the plan to apply or discard",
    "  --confirm                      confirm the apply (safety guard, rule 48)",
    "  --list                         list pending plans",
    "  --discard                      discard a pending plan (requires --plan-id)",
    "  --namespace <name>             namespace (validated by policy)",
    "  --session-key <key>            session identifier for namespace resolution",
    "  --principal <principal>",
  ].join("\n");
}

const COMMAND_SPECS: Record<CommandName, CommandSpec> = {
  browse: {
    valueOptions: new Set([
      "namespace",
      "principal",
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
  "extraction-flush": {
    valueOptions: new Set(["session-key", "namespace", "principal", "cwd", "project-tag", "deadline-ms"]),
    flagOptions: new Set(),
  },
  decision: {
    valueOptions: new Set([
      "subcommand",
      "namespace",
      "session-key",
      "principal",
      "id",
      "title",
      "status",
      "context",
      "decision",
      "consequences",
      "entity-ref",
      "project-tag",
      "supersedes-id",
    ]),
    flagOptions: new Set(),
  },
  architecture: {
    valueOptions: new Set([
      "subcommand",
      "namespace",
      "session-key",
      "principal",
      "project-tag",
      "repo-root",
    ]),
    flagOptions: new Set(),
  },
  delta: {
    valueOptions: new Set([
      "subcommand",
      "namespace",
      "session-key",
      "principal",
      "project-tag",
      "repo-root",
    ]),
    flagOptions: new Set(),
  },
  correct: {
    valueOptions: new Set([
      "text",
      "id",
      "plan-id",
      "namespace",
      "session-key",
      "principal",
    ]),
    flagOptions: new Set(["apply", "list", "discard", "confirm", "yes"]),
  },
};
const BROWSE_SORT_VALUES = Object.freeze([
  "updated_desc",
  "updated_asc",
  "created_desc",
  "created_asc",
] as const);

type BrowseSort = (typeof BROWSE_SORT_VALUES)[number];

/**
 * Type guard for {@link CommandName}. Enumerating the union (rather than a
 * bare `value in COMMAND_SPECS`) is what lets TypeScript NARROW the string
 * to `CommandName` — the `in` operator alone yields TS2322 on the
 * `command: commandRaw` assignment below (codex review P2).
 */
function isCommandName(value: string): value is CommandName {
  return (
    value === "browse" ||
    value === "store" ||
    value === "extraction-flush" ||
    value === "decision" ||
    value === "architecture" ||
    value === "delta" ||
    value === "correct"
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  const [commandRaw, ...rest] = argv;
  if (!isCommandName(commandRaw)) {
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
    if (next === undefined || next.length === 0 || next.startsWith("--")) {
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

function parseIntegerOption(
  args: ParsedArgs,
  name: string,
  options: { min?: number } = {},
): number | undefined {
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
  if (options.min !== undefined && value < options.min) {
    throw new UsageError("invalid-option", name, [`integer >= ${options.min}`]);
  }
  return value;
}

function parseBrowseSortOption(args: ParsedArgs, name: string): BrowseSort | undefined {
  const raw = getLastOption(args, name);
  if (!raw) return undefined;
  if ((BROWSE_SORT_VALUES as readonly string[]).includes(raw)) {
    return raw as BrowseSort;
  }
  throw new UsageError("invalid-option", name, BROWSE_SORT_VALUES);
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
    expandOptionalPath(readEnvVar("OPENCLAW_CONFIG_PATH")) ||
    expandOptionalPath(readEnvVar("OPENCLAW_ENGRAM_CONFIG_PATH")) ||
    path.join(resolveHomeDir(), ".openclaw", "openclaw.json");
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const slotId =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? getOpenClawMemorySlotId(raw as Record<string, unknown>)
      : undefined;
  if (typeof slotId === "string" && !hasAllowedOpenClawRemnicPluginId(slotId)) {
    throw new Error(
      `OpenClaw memory slot points to non-Remnic plugin "${slotId}"; refusing to use default Remnic access config.`,
    );
  }
  // Delegate slot → preferredId → canonical → legacy resolution to the
  // generic helper so all config loaders stay in sync (#403).  Shim CLI
  // callers pass `preferredId: "openclaw-engram"` so legacy shim installs
  // target their own config block instead of falling through to the canonical
  // "openclaw-remnic" entry.
  const entry = resolveOpenClawRemnicPluginEntry(raw, preferredId);
  if (!entry) {
    throw new Error(
      "OpenClaw config does not contain an allowed Remnic plugin entry; refusing to use default Remnic access config.",
    );
  }
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
  const browseArgs = {
    namespace: getLastOption(args, "namespace"),
    principal: getLastOption(args, "principal"),
    query: getLastOption(args, "query"),
    category: getLastOption(args, "category"),
    status: getLastOption(args, "status"),
    sort: parseBrowseSortOption(args, "sort"),
    limit: parseIntegerOption(args, "limit", { min: 1 }),
    offset: parseIntegerOption(args, "offset", { min: 0 }),
  };
  const { config, service } = buildRuntime(preferredId);
  const request = {
    namespace: browseArgs.namespace,
    authenticatedPrincipal: browseArgs.principal ?? config.agentAccessHttp.principal,
    query: browseArgs.query,
    category: browseArgs.category,
    status: browseArgs.status,
    sort: browseArgs.sort,
    limit: browseArgs.limit,
    offset: browseArgs.offset,
  };
  const result = await service.memoryBrowse(request);
  console.log(JSON.stringify(result, null, 2));
}

async function runStore(args: ParsedArgs, preferredId?: string): Promise<void> {
  const contentFile = getLastOption(args, "content-file");
  const inlineContent = getLastOption(args, "content");
  const content = contentFile
    ? fs.readFileSync(expandTildePath(contentFile), "utf8")
    : inlineContent;
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
  // Migrated through the access boundary (issue #1525): the store command
  // dispatches through the same registry entry as the MCP tool and HTTP
  // route, so validation/normalization is owned in ONE place. The CLI has no
  // write-quota hook (it is a one-shot process), so no hooks are forwarded.
  const op = getOperation("memory_store");
  if (!op) {
    throw new Error("access-boundary: operation not registered: memory_store");
  }
  const output = (await op.run(
    {
      namespace: storeArgs.namespace,
      sessionKey: storeArgs.sessionKey,
      content: storeArgs.content,
      category: storeArgs.category,
      confidence: storeArgs.confidence,
      tags: storeArgs.tags,
      entityRef: storeArgs.entityRef,
      ttl: storeArgs.ttl,
      sourceReason: storeArgs.sourceReason,
      idempotencyKey: storeArgs.idempotencyKey,
      dryRun: storeArgs.dryRun,
    },
    {
      service,
      authenticatedPrincipal: getLastOption(args, "principal") ?? config.agentAccessHttp.principal,
    },
  )) as { result: unknown };
  console.log(JSON.stringify(output.result, null, 2));
}

async function runExtractionFlush(args: ParsedArgs, preferredId?: string): Promise<void> {
  const { config, service } = buildRuntime(preferredId);
  const op = getOperation("extraction_force_flush");
  if (!op) {
    throw new Error("access-boundary: operation not registered: extraction_force_flush");
  }
  const output = (await op.run(
    {
      sessionKey: requireOption(args, "session-key"),
      namespace: getLastOption(args, "namespace"),
      cwd: expandOptionalPath(getLastOption(args, "cwd")),
      projectTag: getLastOption(args, "project-tag"),
      deadlineMs: parseIntegerOption(args, "deadline-ms", { min: 0 }),
    },
    {
      service,
      authenticatedPrincipal: getLastOption(args, "principal") ?? config.agentAccessHttp.principal,
    },
  )) as { result: unknown };
  console.log(JSON.stringify(output.result, null, 2));
}

function expandOptionalPath(value: string | undefined): string | undefined {
  return value === undefined ? undefined : expandTildePath(value);
}

/**
 * Decision-record surface (issue #1548 Track A PR 2). Dispatches through the
 * same `coding_decision` operation as the MCP tool and HTTP route — one
 * validation boundary, three transports.
 */
async function runDecision(args: ParsedArgs, preferredId?: string): Promise<void> {
  const subcommand = requireOption(args, "subcommand");
  const { config, service } = buildRuntime(preferredId);
  // The CLI creates a fresh Orchestrator per invocation, so the session
  // coding-context map is empty. If --project-tag + --session-key are
  // provided, attach a coding context BEFORE dispatching so the gate
  // passes and project-scoped writes resolve to the right namespace
  // (review P2).
  const projectTag = getLastOption(args, "project-tag");
  const sessionKey = getLastOption(args, "session-key");
  if (projectTag && projectTag.trim().length > 0 && sessionKey && sessionKey.trim().length > 0) {
    const projectId = projectTagProjectId(projectTag.trim());
    service.setCodingContext({
      sessionKey,
      codingContext: {
        projectId,
        branch: null,
        rootPath: projectId,
        defaultBranch: null,
      },
    });
  }
  const op = getOperation("coding_decision");
  if (!op) {
    throw new Error("access-boundary: operation not registered: coding_decision");
  }
  const output = (await op.run(
    {
      subcommand,
      namespace: getLastOption(args, "namespace"),
      sessionKey,
      id: getLastOption(args, "id"),
      supersedesId: getLastOption(args, "supersedes-id"),
      title: getLastOption(args, "title"),
      status: getLastOption(args, "status"),
      context: getLastOption(args, "context"),
      decision: getLastOption(args, "decision"),
      consequences: getLastOption(args, "consequences"),
      entityRefs: getAllOptions(args, "entity-ref"),
    },
    {
      service,
      authenticatedPrincipal: getLastOption(args, "principal") ?? config.agentAccessHttp.principal,
    },
  )) as { result: unknown };
  console.log(JSON.stringify(output.result, null, 2));
}

/**
 * Architecture-card surface (issue #1548 Track A PR 3). Dispatches through
 * the same `coding_architecture` operation as the MCP tool and HTTP route —
 * one validation boundary, three transports.
 */
async function runArchitecture(args: ParsedArgs, preferredId?: string): Promise<void> {
  const subcommand = requireOption(args, "subcommand");
  const { config, service } = buildRuntime(preferredId);
  // Same coding-context attachment as runDecision (review P2): the CLI's
  // fresh Orchestrator has an empty session coding-context map, so attach
  // a context BEFORE dispatching when --project-tag + --session-key are
  // given, so the gate passes and writes resolve to the right namespace.
  const projectTag = getLastOption(args, "project-tag");
  const sessionKey = getLastOption(args, "session-key");
  if (sessionKey && sessionKey.trim().length > 0) {
    // refresh scans codingContext.rootPath, so it must be a REAL checkout
    // path. Default to the CWD (or an explicit --repo-root) so a one-shot
    // CLI refresh scans the caller's repo, not a non-existent tag path.
    const repoRoot = expandOptionalPath(getLastOption(args, "repo-root")) ?? process.cwd();
    // --project-tag supplies the context id (namespace); when absent, derive
    // a default from the repo-root basename so refresh works with just
    // --session-key + --repo-root (codex review).
    const projectId =
      projectTag && projectTag.trim().length > 0
        ? projectTagProjectId(projectTag.trim())
        : projectTagProjectId(path.basename(repoRoot));
    service.setCodingContext({
      sessionKey,
      codingContext: {
        projectId,
        branch: null,
        rootPath: repoRoot,
        defaultBranch: null,
      },
    });
  }
  const op = getOperation("coding_architecture");
  if (!op) {
    throw new Error("access-boundary: operation not registered: coding_architecture");
  }
  const output = (await op.run(
    {
      subcommand,
      namespace: getLastOption(args, "namespace"),
      sessionKey,
    },
    {
      service,
      authenticatedPrincipal: getLastOption(args, "principal") ?? config.agentAccessHttp.principal,
    },
  )) as { result: unknown };
  console.log(JSON.stringify(output.result, null, 2));
}

/**
 * Session-delta surface (issue #1548 Track A PR 4). Dispatches through the
 * same `coding_delta` operation as the MCP tool and HTTP route — one
 * validation boundary, three transports.
 */
async function runDelta(args: ParsedArgs, preferredId?: string): Promise<void> {
  const subcommand = requireOption(args, "subcommand");
  const { config, service } = buildRuntime(preferredId);
  // Same coding-context attachment as runArchitecture/runDecision: the CLI's
  // fresh Orchestrator has an empty session coding-context map, so attach a
  // context BEFORE dispatching so the gate passes.
  const projectTag = getLastOption(args, "project-tag");
  const sessionKey = getLastOption(args, "session-key");
  if (sessionKey && sessionKey.trim().length > 0) {
    const repoRoot = expandOptionalPath(getLastOption(args, "repo-root")) ?? process.cwd();
    const projectId =
      projectTag && projectTag.trim().length > 0
        ? projectTagProjectId(projectTag.trim())
        : projectTagProjectId(path.basename(repoRoot));
    service.setCodingContext({
      sessionKey,
      codingContext: {
        projectId,
        branch: null,
        rootPath: repoRoot,
        defaultBranch: null,
      },
    });
  }
  const op = getOperation("coding_delta");
  if (!op) {
    throw new Error("access-boundary: operation not registered: coding_delta");
  }
  const output = (await op.run(
    {
      subcommand,
      namespace: getLastOption(args, "namespace"),
      sessionKey,
    },
    {
      service,
      authenticatedPrincipal: getLastOption(args, "principal") ?? config.agentAccessHttp.principal,
    },
  )) as { result: unknown };
  console.log(JSON.stringify(output.result, null, 2));
}

/**
 * Correction Contract surface (issue #1580). Dispatches through the same
 * `memory_correct_plan` / `memory_correct_apply` operations as the MCP tool
 * and HTTP route — one validation boundary, three transports.
 *
 * Modes:
 *   remnic correct "<text>" [--id <id>...]   → plan + print diff
 *   remnic correct --apply <planId> [--confirm] → apply a pending plan
 *   remnic correct --list                      → list pending plans
 *   remnic correct --discard <planId>          → discard a pending plan
 */
async function runCorrect(args: ParsedArgs, preferredId?: string): Promise<void> {
  const { config, service } = buildRuntime(preferredId);
  const principal = getLastOption(args, "principal") ?? config.agentAccessHttp.principal;
  const namespace = getLastOption(args, "namespace");
  const sessionKey = getLastOption(args, "session-key");

  if (args.flags.has("list")) {
    const plans = await service.correctionListPending({
      ...(namespace ? { namespace } : {}),
      ...(sessionKey ? { sessionKey } : {}),
      principal,
    });
    console.log(JSON.stringify(plans, null, 2));
    return;
  }

  if (args.flags.has("discard")) {
    const planId = requireOption(args, "plan-id");
    await service.correctionDiscard(planId, {
      ...(namespace ? { namespace } : {}),
      ...(sessionKey ? { sessionKey } : {}),
      principal,
    });
    console.log(JSON.stringify({ discarded: planId }));
    return;
  }

  if (args.flags.has("apply")) {
    const planId = requireOption(args, "plan-id");
    const op = getOperation("memory_correct_apply");
    if (!op) {
      throw new Error("access-boundary: operation not registered: memory_correct_apply");
    }
    const output = (await op.run(
      {
        planId,
        confirm: args.flags.has("confirm") || args.flags.has("yes"),
        ...(sessionKey ? { sessionKey } : {}),
        ...(namespace ? { namespace } : {}),
      },
      { service, authenticatedPrincipal: principal },
    )) as { result: unknown };
    console.log(JSON.stringify(output.result, null, 2));
    return;
  }

  // Default mode: plan from text — dispatch through the boundary operation
  // so schema validation + namespace policy reach this path (same as MCP/HTTP).
  const text = requireOption(args, "text");
  const targetIds = getAllOptions(args, "id");
  const planOp = getOperation("memory_correct_plan");
  if (!planOp) {
    throw new Error("access-boundary: operation not registered: memory_correct_plan");
  }
  const planOutput = (await planOp.run(
    {
      text,
      ...(targetIds.length > 0 ? { targetIds } : {}),
      ...(sessionKey ? { sessionKey } : {}),
      ...(namespace ? { namespace } : {}),
    },
    { service, authenticatedPrincipal: principal },
  )) as { result: unknown };
  console.log(JSON.stringify(planOutput.result, null, 2));
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
  if (args.command === "extraction-flush") {
    await runExtractionFlush(args, options.preferredId);
    return;
  }
  if (args.command === "decision") {
    await runDecision(args, options.preferredId);
    return;
  }
  if (args.command === "architecture") {
    await runArchitecture(args, options.preferredId);
    return;
  }
  if (args.command === "delta") {
    await runDelta(args, options.preferredId);
    return;
  }
  if (args.command === "correct") {
    await runCorrect(args, options.preferredId);
    return;
  }
  await runStore(args, options.preferredId);
}

export function sanitizeAccessCliErrorMessage(message: string): string {
  return message.replace(
    /\b(openaiApiKey|localLlmApiKey)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/gi,
    (_match, name: string, separator: string) => `${name}${separator}[redacted]`,
  );
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

    console.error("access-cli failed: runtime error");
    process.exit(1);
  }
}
