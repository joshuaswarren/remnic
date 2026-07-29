import { randomUUID } from "node:crypto";
import {
  MCP_ADMIN_OPS_TOOLS,
  MCP_GIT_CONTEXT_SCHEMA_PROPS_IGNORED,
} from "./access-mcp-admin-tools.js";
import { readFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
// Importing access-operations registers the pilot boundary operations
// (memory_get / memory_search / memory_store) as a side effect; callTool
// dispatches migrated tools through the registry (issue #1525).
import { type OperationName, getOperation } from "./access-boundary.js";
import { assertOperationAllowed, capabilityAllowsOp, enforceNamespaceAllowList, tokenCapabilityStore } from "./access-token-capabilities.js";
import {
  type ActionConfidenceRequest,
  type CapsuleExportRequest,
  type CapsuleImportRequest,
  type CapsuleListRequest,
  type DaySummaryRequest,
  type SchemaName,
  type SchemaTypeFor,
  type SuggestionSubmitRequest,
  validateRequest,
} from "./access-schema.js";
import { EngramAccessInputError, type EngramAccessRecallResponse, type EngramAccessService } from "./access-service.js";
import "./access-operations.js";
import { validateBriefingFormat } from "./briefing.js";
import { processChatMessage } from "./chat/chat-factory.js";
import { enforceChatSessionNamespace } from "./chat/chat-session.js";
import { type CitationMetadata, buildCitationGuidance } from "./citations.js";
import { projectTagProjectId } from "./coding/coding-namespace.js";
import {
  REMNIC_CHATGPT_MEMORY_INSPECTOR_MIME_TYPE,
  REMNIC_CHATGPT_MEMORY_INSPECTOR_TOOL,
  REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_HTML,
  REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_URI,
  type RemnicChatGptMemoryInspectorInput,
  buildChatGptMemoryInspectorActionRequest,
  buildChatGptMemoryInspectorResult,
} from "./mcp-memory-inspector-app.js";
import { resolvePrincipal } from "./namespaces/principal.js";
import { readEnvVar } from "./runtime/env.js";
import type { RecallDisclosure, RecallPlanMode } from "./types.js";
import { expandTildePath } from "./utils/path.js";

import { applyToolOutputSchemas } from "./access-mcp-output-schemas.js";
import { MCP_READ_ONLY_TOOL_SUFFIXES } from "./mcp-read-only-tools.js";import { MEETINGS_MCP_TOOLS } from "./meetings/mcp-tools.js";import { WEARABLES_MCP_TOOLS } from "./wearables/mcp-tools.js";
import { abortError, isAbortError } from "./abort-error.js";
type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

function throwMcpAbort(signal: AbortSignal | undefined, message: string): void {
  if (!signal?.aborted) return;
  if (isAbortError(signal.reason)) throw signal.reason;
  throw abortError(message);
}

type McpRequestOptions = {
  principalOverride?: string;
  namespaceOverride?: string;
  sessionKeyOverride?: string;
  sessionId?: string;
  correlationId?: string;
  /**
   * Write-quota enforcer forwarded into observe's idempotency lock
   * (issue #1649). Only the MCP-over-HTTP transport supplies this (it owns
   * the write-rate-limit window); the standalone MCP server has no quota.
   */
  enforceWriteQuota?: () => void | Promise<void>;
  /**
   * Called once when a lifecycle write reaches its durable commit boundary.
   * HTTP transports use this to account writes even when post-commit work
   * fails or the client disconnects before a response is available.
   */
  recordWriteCommit?: () => void;
  /**
   * Server-resolved connector identity (Phase 1 provenance). Set by the HTTP
   * auth boundary from the matched token entry's connector; threaded into
   * the operation context so write handlers stamp it onto frontmatter.
   */
  sourceConnector?: string;
  /** HTTP request lifetime; absent for the standalone stdio transport. */
  abortSignal?: AbortSignal;
};

export type McpTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

type McpResource = {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType: string;
  _meta?: Record<string, unknown>;
};

/**
 * MCP protocol versions this server understands, ordered newest → oldest.
 * Exported so the HTTP transport can validate the `MCP-Protocol-Version`
 * header and reject requests advertising an unknown version.
 */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MCP_DEFAULT_PROTOCOL_VERSION: string = MCP_SUPPORTED_PROTOCOL_VERSIONS[0] ?? "2025-06-18";
const LEGACY_MCP_PREFIX = "engram.";
const CANONICAL_MCP_PREFIX = "remnic.";

function toCanonicalToolName(name: string): string {
  return name.startsWith(LEGACY_MCP_PREFIX) ? `${CANONICAL_MCP_PREFIX}${name.slice(LEGACY_MCP_PREFIX.length)}` : name;
}
function toLegacyToolName(name: string): string {
  return name.startsWith(CANONICAL_MCP_PREFIX)
    ? `${LEGACY_MCP_PREFIX}${name.slice(CANONICAL_MCP_PREFIX.length)}`
    : name;
}

/**
 * Suffix-based allowlist matcher. Returns true for tools whose canonical
 * suffix (after stripping `remnic.` or `engram.`) is in
 * {@link MCP_READ_ONLY_TOOL_SUFFIXES}. Unprefixed names are treated as
 * unannotated.
 */
function isReadOnlyToolName(name: string): boolean {
  for (const prefix of [CANONICAL_MCP_PREFIX, LEGACY_MCP_PREFIX]) {
    if (name.startsWith(prefix)) {
      return MCP_READ_ONLY_TOOL_SUFFIXES[name.slice(prefix.length)] === true;
    }
  }
  return false;
}

function withToolAliases(tool: McpTool, emitLegacyTools = true): McpTool[] {
  const canonicalName = toCanonicalToolName(tool.name);
  const canonicalTool = canonicalName === tool.name ? tool : { ...tool, name: canonicalName };
  if (canonicalName === tool.name) return [canonicalTool];
  // Issue #1427: when legacy aliases are opted out, advertise only the
  // canonical `remnic.*` name and drop the `engram.*` duplicate. Tool *calls*
  // still accept both names (the dispatch canonicalizes), so suppressing the
  // alias only trims `tools/list`, not callability.
  return emitLegacyTools ? [canonicalTool, tool] : [canonicalTool];
}

/**
 * MCP tool name (legacy `engram.*` form, since {@link toLegacyToolName}
 * canonicalizes incoming calls) → boundary operation it dispatches through.
 * A tool appears here once its `access-operations.ts` registration lands and
 * its surface-local validation is deleted. The fitness test
 * (`access-surface-catalog.test.ts`) asserts this map and the catalog agree.
 */
const MCP_MIGRATED_OPERATIONS: Readonly<Record<string, OperationName>> = {
  "engram.memory_get": "memory_get",
  "engram.memory_search": "memory_search",
  "engram.memory_store": "memory_store",
  "engram.coding_decision": "coding_decision",
  "engram.coding_architecture": "coding_architecture",
  // codegraph parity tools (issue #1554) — each maps to its boundary op.
  "engram.codegraph_index": "codegraph_index",
  "engram.codegraph_list_projects": "codegraph_list_projects",
  "engram.codegraph_delete_project": "codegraph_delete_project",
  "engram.codegraph_index_status": "codegraph_index_status",
  "engram.codegraph_search_graph": "codegraph_search_graph",
  "engram.codegraph_trace_path": "codegraph_trace_path",
  "engram.codegraph_detect_changes": "codegraph_detect_changes",
  "engram.codegraph_query_graph": "codegraph_query_graph",
  "engram.codegraph_get_schema": "codegraph_get_schema",
  "engram.codegraph_get_snippet": "codegraph_get_snippet",
  "engram.codegraph_get_architecture": "codegraph_get_architecture",
  "engram.codegraph_search_code": "codegraph_search_code",
  "engram.codegraph_manage_adr": "codegraph_manage_adr",
  "engram.codegraph_ingest_traces": "codegraph_ingest_traces",
  "engram.coding_delta": "coding_delta",
  // Correction Contract (issue #1580) — one plan/apply pipeline.
  "engram.memory_correct_plan": "memory_correct_plan",
  "engram.memory_correct_apply": "memory_correct_apply",
  // Fully migrated through the strict-schema boundary (#1668).
  "engram.recall": "recall",
  "engram.recall_explain": "recall_explain",
  "engram.set_coding_context": "set_coding_context",
  "engram.recall_tier_explain": "recall_tier_explain",
  "engram.recall_xray": "recall_xray",
  "engram.wearables_status": "wearables_status",
  "engram.wearables_sync": "wearables_sync",
  "engram.transcript_day": "transcript_day",
  "engram.transcript_search": "transcript_search",
  "engram.transcript_memories": "transcript_memories", "engram.meetings_list": "meetings_list", "engram.meetings_get": "meetings_get", "engram.meetings_build": "meetings_build",
  "engram.action_confidence": "action_confidence",
  "engram.chatgpt_memory_inspector": "chatgpt_memory_inspector",
  "engram.day_summary": "day_summary",
  "engram.capsule_export": "capsule_export",
  "engram.capsule_import": "capsule_import",
  "engram.capsule_list": "capsule_list",
  "engram.memory_governance_run": "memory_governance_run",
  "engram.entity_synthesis_run": "entity_synthesis_run",
  "engram.procedure_mining_run": "procedure_mining_run",
  "engram.pattern_reinforcement_run": "pattern_reinforcement_run",
  "engram.procedural_stats": "procedural_stats",
  "engram.memory_timeline": "memory_timeline",
  "engram.suggestion_submit": "suggestion_submit",
  "engram.entity_get": "entity_get",
  "engram.review_queue_list": "review_queue_list",
  "engram.observe": "observe",
  "engram.lcm_search": "lcm_search",
  "engram.lcm_compaction_flush": "lcm_compaction_flush",
  "engram.extraction_force_flush": "extraction_force_flush",
  "engram.lcm_compaction_record": "lcm_compaction_record",
  "engram.continuity_audit_generate": "continuity_audit_generate",
  "engram.continuity_incident_open": "continuity_incident_open",
  "engram.continuity_incident_close": "continuity_incident_close",
  "engram.continuity_incident_list": "continuity_incident_list",
  "engram.continuity_loop_add_or_update": "continuity_loop_add_or_update",
  "engram.continuity_loop_review": "continuity_loop_review",
  "engram.identity_anchor_get": "identity_anchor_get",
  "engram.identity_anchor_update": "identity_anchor_update",
  "engram.memory_identity": "memory_identity",
  "engram.work_task": "work_task",
  "engram.work_project": "work_project",
  "engram.work_board": "work_board",
  "engram.shared_context_write_output": "shared_context_write_output",
  "engram.shared_feedback_record": "shared_feedback_record",
  "engram.shared_priorities_append": "shared_priorities_append",
  "engram.shared_context_cross_signals_run": "shared_context_cross_signals_run",
  "engram.shared_context_curate_daily": "shared_context_curate_daily",
  "engram.compounding_weekly_synthesize": "compounding_weekly_synthesize",
  "engram.compounding_promote_candidate": "compounding_promote_candidate",
  "engram.compression_guidelines_optimize": "compression_guidelines_optimize",
  "engram.compression_guidelines_activate": "compression_guidelines_activate",
  "engram.memory_profile": "memory_profile",
  "engram.memory_entities_list": "memory_entities_list",
  "engram.memory_questions": "memory_questions",
  "engram.memory_last_recall": "memory_last_recall",
  "engram.memory_intent_debug": "memory_intent_debug",
  "engram.memory_qmd_debug": "memory_qmd_debug",
  "engram.memory_graph_explain": "memory_graph_explain",
  "engram.graph_snapshot": "graph_snapshot",
  "engram.memory_feedback": "memory_feedback",
  "engram.memory_promote": "memory_promote",
  "engram.memory_outcome": "memory_outcome",
  "engram.memory_action_apply": "memory_action_apply",
  "engram.context_checkpoint": "context_checkpoint",
  "engram.briefing": "briefing",
  "engram.review_list": "review_list",
  "engram.review_resolve": "review_resolve",
  "engram.contradiction_scan_run": "contradiction_scan_run",
  "engram.memory_summarize_hourly": "memory_summarize_hourly",
  "engram.conversation_index_update": "conversation_index_update",
  "engram.profiling_report": "profiling_report",
  "engram.graph_edge_decay_run": "graph_edge_decay_run",
  "engram.live_connectors_run": "live_connectors_run",
  "engram.peer_list": "peer_list",
  "engram.peer_get": "peer_get",
  "engram.peer_set": "peer_set",
  "engram.peer_delete": "peer_delete",
  "engram.peer_profile_get": "peer_profile_get",
  "engram.peer_forget": "peer_forget",
  "engram.console_state": "console_state",
  "engram.dreams_status": "dreams_status",
  "engram.dreams_run": "dreams_run",
  "engram.memory_chat": "chat_message",
};

function resolveChatGptInspectorRecallSessionKey(
  explicitSessionKey: string | undefined,
  authenticatedPrincipal: string | undefined
): string | undefined {
  if (explicitSessionKey) return explicitSessionKey;
  if (!authenticatedPrincipal) return undefined;
  return `remnic:chatgpt-memory-inspector:${randomUUID()}`;
}

const STRICT_MCP_SCHEMA_KEYS: Partial<Record<SchemaName, readonly string[]>> = {
  daySummary: ["memories", "sessionKey", "namespace", "timeZone", "cwd", "projectTag"],
  memoryStore: [
    "schemaVersion",
    "idempotencyKey",
    "dryRun",
    "sessionKey",
    "content",
    "category",
    "confidence",
    "namespace",
    "tags",
    "entityRef",
    "ttl",
    "sourceReason",
    "cwd",
    "projectTag",
  ],
  suggestionSubmit: [
    "schemaVersion",
    "idempotencyKey",
    "dryRun",
    "sessionKey",
    "content",
    "category",
    "confidence",
    "namespace",
    "tags",
    "entityRef",
    "ttl",
    "sourceReason",
    "cwd",
    "projectTag",
  ],
  capsuleExport: [
    "name",
    "namespace",
    "since",
    "includeKinds",
    "peerIds",
    "includeTranscripts",
    "encrypt",
    "cwd",
    "projectTag",
  ],
  capsuleImport: ["archivePath", "namespace", "mode", "passphrase", "cwd", "projectTag"],
  capsuleList: ["namespace", "sessionKey", "cwd", "projectTag"],
};

// Shared JSON-schema fragments for the client-injected git/project context
// fields (#1434). Declared once to avoid drift across tool definitions.
// `_SCOPED` is for write tools that resolve a project namespace from these
// fields; `_IGNORED` is for tools that merely tolerate them for MCP client
// compatibility (clients like Pi MCPorter auto-inject `cwd` on every call).
const MCP_GIT_CONTEXT_SCHEMA_PROPS_SCOPED: Record<string, unknown> = {
  cwd: {
    type: "string",
    description:
      "Optional working directory. When no explicit namespace is given, resolves the project namespace this write is stored in (mirrors recall/observe).",
  },
  projectTag: {
    type: "string",
    description:
      "Optional project tag for non-git project scoping. When no explicit namespace is given, routes this write to the tagged project namespace.",
  },
};

function parseMcpRequest<N extends SchemaName>(schemaName: N, args: Record<string, unknown>): SchemaTypeFor<N> {
  const allowedKeys = STRICT_MCP_SCHEMA_KEYS[schemaName];
  if (allowedKeys) {
    const allowed = new Set(allowedKeys);
    const unexpected = Object.keys(args).filter((key) => !allowed.has(key));
    if (unexpected.length > 0) {
      throw new EngramAccessInputError(
        `request validation failed: (root): Unrecognized key(s) in object: ${unexpected.join(", ")}`
      );
    }
  }
  const validation = validateRequest<SchemaTypeFor<N>>(schemaName, args);
  if (validation.success) return validation.data;
  const details = validation.error.details.map((detail) => `${detail.field}: ${detail.message}`).join("; ");
  throw new EngramAccessInputError(
    details.length > 0 ? `${validation.error.error}: ${details}` : validation.error.error
  );
}

/**
 * Strict optional-string MCP argument: absent/null/"" → undefined,
 * non-string → loud error (CLAUDE.md rule 51 — no silent coercion).
 */
function optionalNonEmptyString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new Error(`${label} expects a string; got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Strict optional positive-integer MCP argument. Accepts JSON numbers
 * and numeric strings (loosely-typed MCP clients send both); rejects
 * everything else including booleans, which `Number()` would silently
 * coerce.
 */
function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error(`${label} expects a positive integer; got ${JSON.stringify(value)}`);
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new Error(`${label} expects a positive integer; got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function getObjectProperties(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

async function getMcpServerVersion(): Promise<string> {
  const envVersion = readEnvVar("OPENCLAW_ENGRAM_VERSION")?.trim() || readEnvVar("npm_package_version")?.trim();
  if (envVersion) return envVersion;
  try {
    const pkgPath = new URL("../package.json", import.meta.url);
    const raw = await readFile(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version?.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export class EngramMcpServer {
  private buffer = Buffer.alloc(0);
  private flushTask: Promise<void> | null = null;
  private readonly tools: McpTool[];
  private readonly resources: McpResource[];
  private readonly resourceTextByUri: Map<string, string>;
  private readonly authenticatedPrincipal?: string;
  /**
   * MCP client info keyed by server-assigned session ID. On each `initialize`
   * handshake the server generates a UUID, stores the client's clientInfo
   * against it, and returns the ID as `Mcp-Session-Id` in the response
   * metadata. Subsequent requests from the same client include this header,
   * allowing per-session clientInfo lookup without cross-session leaks.
   */
  private clientInfoBySession = new Map<string, { name: string; version?: string }>();
  /**
   * Session IDs generated during initialize, keyed by caller-supplied correlation
   * ID (unique per HTTP request) to avoid collisions when multiple clients send
   * initialize with the same JSON-RPC id concurrently.
   */
  private initSessionIds = new Map<string, string>();

  /**
   * Whether oai-mem-citation guidance is explicitly enabled via config.
   */
  private readonly citationsEnabled: boolean;
  /** Whether to auto-enable citations for Codex adapter connections. */
  private readonly citationsAutoDetect: boolean;
  /**
   * Whether to advertise legacy `engram.*` tool aliases alongside the canonical
   * `remnic.*` names (issue #1427). Defaults to true for backward compatibility;
   * set false to halve the advertised `tools/list` surface.
   */
  private readonly emitLegacyTools: boolean;
  /**
   * Whether the `coding_decision` tool should appear in `tools/list`. Gated on
   * `codingKnowledge.enabled && codingKnowledge.decisionRecords` (issue #1548
   * Track A PR 2, rule 39). When false the tools array is byte-identical to
   * pre-feature.
   */
  private readonly codingDecisionVisible: boolean;
  /**
   * Whether the `coding_architecture` tool should appear in `tools/list`.
   * Gated on `codingKnowledge.enabled && codingKnowledge.architectureCard`
   * (issue #1548 Track A PR 3, rule 39).
   */
  private readonly architectureCardVisible: boolean;
  /**
   * Whether the 14 codegraph parity tools should appear in `tools/list`
   * (issue #1554). Config-only -- runtime availability is checked at call
   * time. When false the tools array is byte-identical to pre-feature.
   */
  private readonly codegraphVisible: boolean;
  private readonly sessionDeltaVisible: boolean;
  /**
   * Whether the two correction tools (memory_correct_plan / memory_correct_apply)
   * should appear in `tools/list` (issue #1580). Gated on `correction.enabled`
   * (default true — plan is read-only; safe on). When false the tools array is
   * byte-identical to pre-feature.
   */
  private readonly correctionVisible: boolean;

  /**
   * Whether the `memory_chat` tool should appear in `tools/list` (issue
   * #1583). Gated on `chat.enabled`. When false the tools array is
   * byte-identical to pre-feature (rule 39).
   */
  private readonly chatVisible: boolean;

  constructor(
    private readonly service: EngramAccessService,
    options: {
      principal?: string;
      citationsEnabled?: boolean;
      citationsAutoDetect?: boolean;
      emitLegacyTools?: boolean;
      codingDecisionVisible?: boolean;
      architectureCardVisible?: boolean;
      codegraphVisible?: boolean;
      sessionDeltaVisible?: boolean;
      correctionVisible?: boolean;
      chatVisible?: boolean;
    } = {}
  ) {
    this.citationsEnabled = options.citationsEnabled === true;
    this.citationsAutoDetect = options.citationsAutoDetect !== false;
    this.emitLegacyTools = options.emitLegacyTools !== false;
    this.codingDecisionVisible = options.codingDecisionVisible === true;
    this.architectureCardVisible = options.architectureCardVisible === true;
    this.codegraphVisible = options.codegraphVisible === true;
    this.sessionDeltaVisible = options.sessionDeltaVisible === true;
    // correction defaults to visible (enabled by default — plan is read-only).
    this.correctionVisible = options.correctionVisible !== false;
    this.chatVisible = options.chatVisible === true;
    this.authenticatedPrincipal =
      options.principal?.trim() || readEnvVar("OPENCLAW_ENGRAM_ACCESS_PRINCIPAL")?.trim() || undefined;
    this.resources = [
      {
        uri: REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_URI,
        name: "remnic-memory-inspector",
        title: "Remnic Memory Inspector",
        description:
          "Apps-compatible widget for inspecting retrieved Remnic memories, provenance, safety, and correction/scoping affordances.",
        mimeType: REMNIC_CHATGPT_MEMORY_INSPECTOR_MIME_TYPE,
        _meta: {
          ui: {
            csp: {
              connectDomains: [],
              resourceDomains: [],
            },
            prefersBorder: true,
          },
          "openai/widgetDescription":
            "Inspect retrieved Remnic memories, provenance, safety, and correction/scoping affordances.",
        },
      },
    ];
    this.resourceTextByUri = new Map([
      [REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_URI, REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_HTML],
    ]);
    this.tools = [
      {
        name: "engram.recall",
        description: "Recall Engram context for a query.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            sessionKey: { type: "string" },
            namespace: { type: "string" },
            topK: { type: "number" },
            mode: { type: "string", enum: ["auto", "no_recall", "minimal", "full", "graph_mode"] },
            includeDebug: { type: "boolean" },
            // Recall disclosure depth (issue #677).  Default `chunk` when
            // omitted.  Section/raw payload shaping ships in PR 2; this PR
            // wires the field end-to-end so clients can already pass it
            // without it being silently dropped.
            disclosure: { type: "string", enum: ["chunk", "section", "raw"] },
            cwd: { type: "string", description: "Working directory for auto git-context resolution." },
            projectTag: {
              type: "string",
              description: "Project tag for non-git project scoping (e.g. 'acme-webshop').",
            },
            asOf: {
              type: "string",
              description:
                "Historical recall pin (issue #680). ISO 8601 timestamp; when set, the recall returns the corpus as it existed at this instant.",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Filter recall results to memories whose frontmatter tags match (issue #689).",
            },
            tagMatch: {
              type: "string",
              enum: ["any", "all"],
              description:
                "Tag-filter match mode. 'any' (default) admits results with at least one filter tag; 'all' requires every filter tag.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.recall_explain",
        description: "Return the last recall snapshot for a session or the most recent one.",
        inputSchema: {
          type: "object",
          properties: {
            sessionKey: { type: "string" },
            namespace: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.set_coding_context",
        description:
          "Attach a coding-agent context (project / branch) to a session so recall routes to a project- / branch-scoped namespace (issue #569). For MCP clients that do not ship cwd automatically (Cursor, generic agents, etc.). Also aliased as remnic.set_coding_context. Pass codingContext: null to clear. Alternatively, pass just a projectTag for non-git project scoping (e.g. OpenClaw channels).",
        inputSchema: {
          type: "object",
          properties: {
            sessionKey: {
              type: "string",
              description: "Session identifier the context should attach to.",
            },
            codingContext: {
              anyOf: [
                { type: "null" },
                {
                  type: "object",
                  properties: {
                    projectId: { type: "string", description: "Stable project id (origin:<hex> or root:<hex>)." },
                    branch: { type: ["string", "null"], description: "Current branch, or null in detached HEAD." },
                    rootPath: { type: "string", description: "Absolute path to the repo root." },
                    defaultBranch: {
                      type: ["string", "null"],
                      description: "Default branch (usually main/master), or null when unknown.",
                    },
                  },
                  required: ["projectId", "branch", "rootPath", "defaultBranch"],
                  additionalProperties: false,
                },
              ],
              description: "The context to attach, or null to clear. Omit when using projectTag instead.",
            },
            projectTag: {
              type: "string",
              description:
                "Arbitrary project tag for non-git project scoping (e.g. 'acme-webshop'). " +
                "Creates a coding context with projectId 'tag:<projectTag>'. " +
                "Use instead of codingContext when the session isn't tied to a specific git repo.",
            },
          },
          required: ["sessionKey"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.recall_tier_explain",
        description:
          "Return a structured tier-explain payload for the last direct-answer-eligible recall (issue #518). Orthogonal to engram.recall_explain, which returns a graph-path explanation.",
        inputSchema: {
          type: "object",
          properties: {
            sessionKey: {
              type: "string",
              description: "Optional session key. Omit to read the most recent snapshot.",
            },
            namespace: {
              type: "string",
              description: "Optional namespace to scope the returned snapshot.",
            },
          },
          additionalProperties: false,
        },
      },
      {
        // Registered as `engram.recall_xray`; `withToolAliases` below
        // emits the canonical `remnic.recall_xray` alias automatically
        // (dual-naming invariant for every new MCP tool).
        name: "engram.recall_xray",
        description:
          "Run a recall with X-ray capture enabled and return the unified per-result attribution snapshot (tier + audit + MMR + filters in one view). Issue #570.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Query to recall against. Required; non-empty.",
            },
            sessionKey: {
              type: "string",
              description: "Optional session key to scope the recall.",
            },
            namespace: {
              type: "string",
              description:
                "Optional namespace. Enforced against the caller's principal; a mismatch yields snapshotFound:false.",
            },
            budget: {
              type: "integer",
              minimum: 1,
              description: "Optional positive-integer override for the recall character budget.",
            },
            disclosure: {
              type: "string",
              enum: ["chunk", "section", "raw"],
              description:
                "Optional disclosure depth for X-ray telemetry (issue #677). When set, populates the per-disclosure token-spend summary on each result.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      ...WEARABLES_MCP_TOOLS, ...MEETINGS_MCP_TOOLS,
      {
        name: "engram.action_confidence",
        description:
          "Advisory ask/draft/act/refuse/escalate decision helper for interruption budgeting. Read-only; never mutates memory.",
        inputSchema: {
          type: "object",
          properties: {
            intendedAction: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            risk: {
              type: "string",
              enum: ["low", "medium", "high", "irreversible", "restricted"],
            },
            contextReadiness: {
              type: "string",
              enum: ["none", "partial", "sufficient"],
            },
            currentContextScopes: {
              type: "array",
              items: { type: "string" },
            },
            userRules: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  kind: {
                    type: "string",
                    enum: ["ask-before", "do-not-use-outside-this-context", "never", "requires-escalation"],
                  },
                  description: { type: "string" },
                  matched: { type: "boolean" },
                },
                required: ["kind"],
                additionalProperties: false,
              },
            },
            retrievedMemories: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  source: { type: "string" },
                  created: { type: "string" },
                  updated: { type: "string" },
                  scope: { type: "string" },
                  userContextScopes: {
                    type: "array",
                    items: { type: "string" },
                  },
                  retrievalReason: { type: "string" },
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                  stale: { type: "boolean" },
                  corrected: { type: "boolean" },
                  correctionState: {
                    type: "string",
                    enum: ["none", "correction", "superseded", "disputed", "forgotten"],
                  },
                  safeToUse: { type: "boolean" },
                  safety: {
                    type: "string",
                    enum: ["safe", "requires-review", "blocked"],
                  },
                  safetyReasons: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: REMNIC_CHATGPT_MEMORY_INSPECTOR_TOOL,
        title: "Show Remnic Memory Inspector",
        description:
          "Use this when the user wants a ChatGPT Apps-compatible UI for inspecting Remnic recall, provenance, safety, and correction/forget/scoping affordances. Read-only; correction and forget actions are proposed as follow-up prompts.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Memory question to inspect.",
            },
            sessionKey: {
              type: "string",
              description: "Optional Remnic session key for scoped recall.",
            },
            namespace: {
              type: "string",
              description: "Optional Remnic namespace to inspect.",
            },
            currentContextScopes: {
              type: "array",
              items: { type: "string" },
              description: "Optional current user-context scopes, such as repo, work, personal, client, or private.",
            },
            allowUnverifiedPreview: {
              type: "boolean",
              description:
                "If true, the inspector may show recalled preview text when X-ray provenance is missing or unavailable. Explicitly blocked memories remain redacted.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            app: { type: "object" },
            query: { type: "string" },
            sessionKey: { type: "string" },
            namespace: { type: "string" },
            safeRecallPreview: { type: "string" },
            memoryCount: { type: "number" },
            memoryIds: { type: "array", items: { type: "string" } },
            memories: { type: "array", items: { type: "object" } },
            actionConfidence: { type: "object" },
            affordances: { type: "array", items: { type: "object" } },
            guidance: { type: "object" },
          },
          required: [
            "app",
            "query",
            "namespace",
            "safeRecallPreview",
            "memoryCount",
            "memoryIds",
            "memories",
            "actionConfidence",
            "affordances",
            "guidance",
          ],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        _meta: {
          ui: {
            resourceUri: REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_URI,
            visibility: ["model", "app"],
          },
          "openai/outputTemplate": REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_URI,
          "openai/toolInvocation/invoking": "Inspecting Remnic memory...",
          "openai/toolInvocation/invoked": "Remnic memory inspector ready.",
        },
      },
      {
        name: "engram.day_summary",
        description:
          "Generate a structured end-of-day summary. When memories is omitted or empty, auto-gathers today's facts and hourly summaries from storage.",
        inputSchema: {
          type: "object",
          properties: {
            memories: { type: "string" },
            sessionKey: { type: "string" },
            namespace: { type: "string" },
            timeZone: { type: "string" },
            ...MCP_GIT_CONTEXT_SCHEMA_PROPS_IGNORED,
          },
          required: [],
          additionalProperties: false,
        },
      },
      ...MCP_ADMIN_OPS_TOOLS,
      {
        name: "engram.memory_get",
        description: "Fetch one Remnic memory by id.",
        inputSchema: {
          type: "object",
          properties: {
            memoryId: { type: "string" },
            namespace: { type: "string" },
            // Issue #1582 — when memoryId is a `[m:xxxx]` handle, sessionKey
            // scopes resolution to this session's recent recall history.
            // Advertising it here lets the transport inject its session key
            // (toolAcceptsArgument) so MCP callers can cite handles (codex review).
            sessionKey: { type: "string" },
          },
          required: ["memoryId"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_timeline",
        description: "Fetch one Remnic memory timeline by id.",
        inputSchema: {
          type: "object",
          properties: {
            memoryId: { type: "string" },
            namespace: { type: "string" },
            limit: { type: "number" },
          },
          required: ["memoryId"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_store",
        description: "Store an explicit Remnic memory through the access layer.",
        inputSchema: {
          type: "object",
          properties: {
            schemaVersion: { type: "number" },
            idempotencyKey: { type: "string" },
            dryRun: { type: "boolean" },
            sessionKey: { type: "string" },
            content: { type: "string" },
            category: { type: "string" },
            confidence: { type: "number" },
            namespace: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            entityRef: { type: "string" },
            ttl: { type: "string" },
            sourceReason: { type: "string" },
            ...MCP_GIT_CONTEXT_SCHEMA_PROPS_SCOPED,
          },
          required: ["content"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.suggestion_submit",
        description: "Queue a suggested Remnic memory for review.",
        inputSchema: {
          type: "object",
          properties: {
            schemaVersion: { type: "number" },
            idempotencyKey: { type: "string" },
            dryRun: { type: "boolean" },
            sessionKey: { type: "string" },
            content: { type: "string" },
            category: { type: "string" },
            confidence: { type: "number" },
            namespace: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            entityRef: { type: "string" },
            ttl: { type: "string" },
            sourceReason: { type: "string" },
            ...MCP_GIT_CONTEXT_SCHEMA_PROPS_SCOPED,
          },
          required: ["content"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.entity_get",
        description: "Fetch one Engram entity by name.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            namespace: { type: "string" },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.review_queue_list",
        description: "Fetch the latest Engram review queue artifact bundle.",
        inputSchema: {
          type: "object",
          properties: {
            runId: { type: "string" },
            namespace: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.observe",
        description: "Feed conversation messages into Engram's memory pipeline (LCM archive + extraction).",
        inputSchema: {
          type: "object",
          properties: {
            sessionKey: { type: "string", description: "Conversation session identifier" },
            messages: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  role: { type: "string", enum: ["user", "assistant"] },
                  content: { type: "string" },
                  sourceFormat: {
                    type: "string",
                    enum: ["openai", "anthropic", "openclaw", "pi", "lossless-claw", "remnic"],
                  },
                  rawContent: {
                    description: "Optional native provider content blocks for structured message-part capture.",
                  },
                  parts: {
                    type: "array",
                    description: "Optional normalized Remnic LCM message parts.",
                    items: {
                      type: "object",
                      properties: {
                        ordinal: { type: ["number", "null"], minimum: 0 },
                        kind: {
                          type: "string",
                          enum: [
                            "text",
                            "tool_call",
                            "tool_result",
                            "patch",
                            "file_read",
                            "file_write",
                            "step_start",
                            "step_finish",
                            "snapshot",
                            "retry",
                          ],
                        },
                        payload: { type: "object", additionalProperties: true },
                        toolName: { type: ["string", "null"] },
                        tool_name: { type: ["string", "null"] },
                        filePath: { type: ["string", "null"] },
                        file_path: { type: ["string", "null"] },
                        createdAt: { type: ["string", "null"] },
                        created_at: { type: ["string", "null"] },
                      },
                      required: ["kind", "payload"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["role", "content"],
                additionalProperties: false,
              },
              description: "Conversation messages to observe",
            },
            idempotencyKey: {
              type: "string",
              description:
                "Optional idempotency key (issue #1649). Deduplicates a retried observe POST server-side so the batch is ingested once even when the HTTP response is lost. Reusing the key with a different payload is rejected.",
            },
            namespace: { type: "string" },
            skipExtraction: { type: "boolean" },
            cwd: { type: "string", description: "Working directory for auto git-context resolution." },
            projectTag: {
              type: "string",
              description: "Project tag for non-git project scoping (e.g. 'acme-webshop').",
            },
          },
          required: ["sessionKey", "messages"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.lcm_search",
        description: "Search the LCM conversation archive for matching content.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            sessionKey: { type: "string", description: "Optional session filter" },
            sessionPrefix: { type: "string", description: "Optional session prefix filter" },
            namespace: { type: "string" },
            limit: { type: "number", description: "Max results to return" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.lcm_compaction_flush",
        description: "Flush pending LCM observe work and incremental summaries before a host compacts session context.",
        inputSchema: {
          type: "object",
          properties: {
            sessionKey: { type: "string", description: "Conversation session identifier" },
            namespace: { type: "string" },
            cwd: { type: "string", description: "Working directory for auto git-context resolution." },
            projectTag: { type: "string", description: "Project tag for non-git project scoping." },
          },
          required: ["sessionKey"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.extraction_force_flush",
        description: "Force-drain a session extraction buffer before a lifecycle boundary.",
        inputSchema: {
          type: "object",
          properties: {
            sessionKey: { type: "string", description: "Conversation session identifier" },
            namespace: { type: "string" },
            cwd: { type: "string", description: "Working directory for auto git-context resolution." },
            projectTag: { type: "string", description: "Project tag for non-git project scoping." },
            deadlineMs: { type: "number", minimum: 0 },
          },
          required: ["sessionKey"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.lcm_compaction_record",
        description: "Record a host compaction event with before/after token counts in the LCM archive.",
        inputSchema: {
          type: "object",
          properties: {
            sessionKey: { type: "string", description: "Conversation session identifier" },
            namespace: { type: "string" },
            tokensBefore: { type: "integer", minimum: 0 },
            tokensAfter: { type: "integer", minimum: 0 },
          },
          required: ["sessionKey", "tokensBefore", "tokensAfter"],
          additionalProperties: false,
        },
      },
      // ── Continuity / Identity tools ─────────────────────────────────────
      {
        name: "engram.continuity_audit_generate",
        description: "Generate a deterministic identity continuity audit report (weekly/monthly).",
        inputSchema: {
          type: "object",
          properties: {
            period: { type: "string", enum: ["weekly", "monthly"] },
            key: {
              type: "string",
              description: "Period key (weekly: YYYY-Www, monthly: YYYY-MM). Defaults to current.",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.continuity_incident_open",
        description: "Create a new continuity incident record in append-only storage.",
        inputSchema: {
          type: "object",
          properties: {
            symptom: { type: "string", description: "Observed continuity failure symptom." },
            namespace: { type: "string" },
            triggerWindow: { type: "string", description: "Time window when incident occurred." },
            suspectedCause: { type: "string" },
          },
          required: ["symptom"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.continuity_incident_close",
        description: "Close an open continuity incident with verification details.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Incident ID to close." },
            namespace: { type: "string" },
            fixApplied: { type: "string", description: "What fix was applied." },
            verificationResult: { type: "string", description: "How closure was verified." },
            preventiveRule: { type: "string", description: "Optional preventive follow-up rule." },
          },
          required: ["id", "fixApplied", "verificationResult"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.continuity_incident_list",
        description: "List continuity incidents, optionally filtered by state.",
        inputSchema: {
          type: "object",
          properties: {
            state: { type: "string", enum: ["open", "closed", "all"] },
            namespace: { type: "string" },
            limit: { type: "number", description: "Max incidents (default 25, max 200)." },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.continuity_loop_add_or_update",
        description: "Add or update a continuity improvement loop entry.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable loop identifier." },
            cadence: { type: "string", enum: ["daily", "weekly", "monthly", "quarterly"] },
            purpose: { type: "string", description: "What this recurring loop improves." },
            status: { type: "string", enum: ["active", "paused", "retired"] },
            killCondition: { type: "string", description: "Clear condition for retiring this loop." },
            namespace: { type: "string" },
            lastReviewed: { type: "string", description: "ISO timestamp for last review." },
            notes: { type: "string" },
          },
          required: ["id", "cadence", "purpose", "status", "killCondition"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.continuity_loop_review",
        description: "Update review metadata for an existing continuity improvement loop.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Loop ID to review." },
            namespace: { type: "string" },
            status: { type: "string", enum: ["active", "paused", "retired"] },
            notes: { type: "string" },
            reviewedAt: { type: "string", description: "ISO timestamp for review event." },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.identity_anchor_get",
        description: "Read the identity continuity anchor document (recovery-safe identity context).",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.identity_anchor_update",
        description: "Conservatively merge identity anchor sections without overwriting existing material.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
            identityTraits: { type: "string", description: "Updates for 'Identity Traits' section." },
            communicationPreferences: {
              type: "string",
              description: "Updates for 'Communication Preferences' section.",
            },
            operatingPrinciples: { type: "string", description: "Updates for 'Operating Principles' section." },
            continuityNotes: { type: "string", description: "Updates for 'Continuity Notes' section." },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_identity",
        description: "Read the agent's identity reflections from the workspace IDENTITY.md file.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      // ── Work Layer tools ─────────────────────────────────────────────────
      {
        name: "engram.work_task",
        description:
          "Manage work-layer tasks (create, get, list, update, transition, delete). Excluded from memory extraction.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["create", "get", "list", "update", "transition", "delete"] },
            id: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            status: { type: "string", enum: ["todo", "in_progress", "blocked", "done", "cancelled"] },
            priority: { type: "string", enum: ["low", "medium", "high"] },
            owner: { type: "string" },
            assignee: { type: "string" },
            projectId: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            dueAt: { type: "string" },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.work_project",
        description:
          "Manage work-layer projects (create, get, list, update, delete, link_task). Excluded from memory extraction.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["create", "get", "list", "update", "delete", "link_task"] },
            id: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            status: { type: "string", enum: ["active", "on_hold", "completed", "archived"] },
            owner: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            taskId: { type: "string", description: "Task ID for link_task." },
            projectId: { type: "string", description: "Project ID for link_task." },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.work_board",
        description: "Export/import work-layer board snapshots and markdown.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["export_markdown", "export_snapshot", "import_snapshot"] },
            projectId: { type: "string" },
            snapshotJson: { type: "string", description: "Snapshot JSON for import_snapshot." },
            linkToMemory: { type: "boolean", description: "If true, output can be retained as long-term memory." },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
      // ── Shared Context / Compounding tools ────────────────────────────
      {
        name: "engram.shared_context_write_output",
        description: "Write agent work product into shared-context directory for cross-agent coordination.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Agent ID producing this output." },
            title: { type: "string", description: "Short title for the output." },
            content: { type: "string", description: "Markdown content to write." },
          },
          required: ["agentId", "title", "content"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.shared_feedback_record",
        description: "Append approval/rejection decision into shared-context feedback inbox for compounding learning.",
        inputSchema: {
          type: "object",
          properties: {
            agent: { type: "string", description: "Agent name that produced the output." },
            decision: { type: "string", enum: ["approved", "approved_with_feedback", "rejected"] },
            reason: { type: "string" },
            date: { type: "string", description: "ISO timestamp. Defaults to now." },
            learning: { type: "string" },
            outcome: { type: "string" },
            severity: { type: "string", enum: ["low", "medium", "high"] },
            confidence: { type: "number", description: "Confidence 0-1." },
            workflow: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            evidenceWindowStart: { type: "string" },
            evidenceWindowEnd: { type: "string" },
            refs: { type: "array", items: { type: "string" } },
          },
          required: ["agent", "decision", "reason"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.shared_priorities_append",
        description: "Append priorities text into shared-context inbox for curator merge.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string" },
            text: { type: "string", description: "Priority notes (markdown)." },
          },
          required: ["agentId", "text"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.shared_context_cross_signals_run",
        description: "Generate cross-signal markdown + JSON artifacts from agent outputs and feedback.",
        inputSchema: {
          type: "object",
          properties: {
            date: { type: "string", description: "YYYY-MM-DD. Defaults to today." },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.shared_context_curate_daily",
        description: "Generate daily roundtable summary (deterministic baseline aggregation).",
        inputSchema: {
          type: "object",
          properties: {
            date: { type: "string", description: "YYYY-MM-DD. Defaults to today." },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.compounding_weekly_synthesize",
        description:
          "Generate weekly compounding outputs: reports, mistake registry, rubrics, and promotion candidates.",
        inputSchema: {
          type: "object",
          properties: {
            weekId: { type: "string", description: "ISO week ID (YYYY-Www). Defaults to current week." },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.compounding_promote_candidate",
        description: "Promote a compounding candidate from weekly report into durable rule/principle memory.",
        inputSchema: {
          type: "object",
          properties: {
            weekId: { type: "string" },
            candidateId: { type: "string" },
            dryRun: { type: "boolean", description: "Preview without writing." },
          },
          required: ["weekId", "candidateId"],
          additionalProperties: false,
        },
      },
      // ── Compression Guidelines tools ────────────────────────────────────
      {
        name: "engram.compression_guidelines_optimize",
        description: "Run compression guideline optimizer, optionally persisting new guidelines.",
        inputSchema: {
          type: "object",
          properties: {
            dryRun: { type: "boolean" },
            eventLimit: { type: "number" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.compression_guidelines_activate",
        description: "Promote staged compression guideline draft to active (after review).",
        inputSchema: {
          type: "object",
          properties: {
            expectedContentHash: { type: "string" },
            expectedGuidelineVersion: { type: "number" },
          },
          additionalProperties: false,
        },
      },
      // ── Memory search & debug tools ────────────────────────────────────
      {
        name: "engram.memory_search",
        description:
          "Direct semantic search over memory files using the QMD index. Returns matching memories with relevance scores.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            namespace: { type: "string" },
            maxResults: { type: "number" },
            collection: {
              type: "string",
              description:
                "QMD collection. With namespaces enabled, omitted, base, and 'global' searches stay scoped to readable namespaces; namespace-derived collections require matching namespace access.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_profile",
        description:
          "Read the user's behavioral profile — a living document of their preferences, habits, and personality.",
        inputSchema: {
          type: "object",
          properties: { namespace: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_entities_list",
        description: "List all tracked entities (people, projects, tools, companies).",
        inputSchema: {
          type: "object",
          properties: { namespace: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_questions",
        description: "List open questions the system is curious about from past conversations.",
        inputSchema: {
          type: "object",
          properties: { namespace: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_last_recall",
        description: "Return the last recall snapshot for a session (debug introspection).",
        inputSchema: {
          type: "object",
          properties: { sessionKey: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_intent_debug",
        description: "Return the last intent classification debug snapshot.",
        inputSchema: {
          type: "object",
          properties: { namespace: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_qmd_debug",
        description: "Return QMD search index debug information from the last recall.",
        inputSchema: {
          type: "object",
          properties: { namespace: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_graph_explain",
        description: "Explain the last entity graph recall — which entities were activated and why.",
        inputSchema: {
          type: "object",
          properties: { namespace: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        // Graph snapshot for the admin pane (issue #691 PR 2/5).  Returns
        // a read-only `{ nodes, edges, generatedAt }` view of the
        // multi-graph adjacency, with the same filter knobs as the HTTP
        // surface so connectors / CLI clients can hit either endpoint
        // interchangeably.
        name: "engram.graph_snapshot",
        description:
          "Return a read-only graph snapshot (nodes + edges) for the admin pane. Filters: limit (default 500, max 5000), since (ISO timestamp), focusNodeId (restricts to neighborhood), categories (allow-list of memory categories).",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
            limit: { type: "number", description: "Maximum number of edges to return (default 500, max 5000)." },
            since: { type: "string", description: "Inclusive lower bound on edge timestamp (ISO-8601)." },
            focusNodeId: {
              type: "string",
              description: "When set, restrict the snapshot to the focus node and its neighbors.",
            },
            categories: {
              type: "array",
              items: { type: "string" },
              description: "Optional category allow-list (e.g. ['fact', 'decision']).",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_feedback",
        description: "Record relevance feedback (thumbs up/down) for a specific memory.",
        inputSchema: {
          type: "object",
          properties: {
            memoryId: { type: "string" },
            vote: { type: "string", enum: ["up", "down"] },
            note: { type: "string" },
          },
          required: ["memoryId", "vote"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_promote",
        description: "Promote a memory's lifecycle state (e.g. from draft to active).",
        inputSchema: {
          type: "object",
          properties: {
            memoryId: { type: "string" },
            namespace: { type: "string" },
            sessionKey: { type: "string" },
          },
          required: ["memoryId"],
          additionalProperties: false,
        },
      },
      // Memory Worth outcome signal (issue #560 PR 3). Callers record whether
      // a session that used a given memory ultimately succeeded or failed;
      // the counter is persisted in the memory's frontmatter (mw_success /
      // mw_fail) and will feed the recall-time filter added in PR 4.
      {
        name: "engram.memory_outcome",
        description:
          "Record a Memory Worth outcome (success/failure) for a memory. Increments mw_success or mw_fail in the memory's frontmatter for use by the recall filter.",
        inputSchema: {
          type: "object",
          properties: {
            memoryId: { type: "string" },
            outcome: { type: "string", enum: ["success", "failure"] },
            namespace: { type: "string" },
            sessionKey: { type: "string" },
            timestamp: { type: "string", description: "Optional ISO-8601 timestamp of the observation." },
          },
          required: ["memoryId", "outcome"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_action_apply",
        description: "Record a memory-action application event for policy-learning telemetry.",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "store_episode",
                "store_note",
                "update_note",
                "create_artifact",
                "summarize_node",
                "discard",
                "link_graph",
              ],
            },
            category: { type: "string" },
            content: { type: "string" },
            outcome: { type: "string", enum: ["applied", "skipped", "failed"] },
            reason: { type: "string" },
            memoryId: { type: "string" },
            sessionKey: { type: "string" },
            linkTargetId: { type: "string" },
            linkType: { type: "string" },
            linkStrength: { type: "number" },
            artifactType: { type: "string" },
            execute: { type: "boolean" },
            sourcePrompt: { type: "string" },
            namespace: { type: "string" },
            dryRun: { type: "boolean" },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.context_checkpoint",
        description: "Save a structured context checkpoint for a session (preserves conversation state to disk).",
        inputSchema: {
          type: "object",
          properties: {
            sessionKey: { type: "string" },
            context: { type: "string", description: "Context content to checkpoint" },
            namespace: { type: "string" },
          },
          required: ["sessionKey", "context"],
          additionalProperties: false,
        },
      },
      // ── Daily Context Briefing (#370) ───────────────────────────────────
      // Uses the legacy "engram.*" prefix like every other tool in this array;
      // withToolAliases (applied via .flatMap below) generates the canonical
      // "remnic.briefing" alias automatically.
      ...(service.briefingEnabled
        ? [
            {
              name: "engram.briefing",
              description:
                "Generate a daily context briefing by cross-referencing active entities, recent facts, open commitments, and optional calendar events.",
              inputSchema: {
                type: "object",
                properties: {
                  since: { type: "string", description: "Lookback window (e.g. 'yesterday', '3d', '1w', '24h')." },
                  focus: {
                    type: "string",
                    description:
                      "Optional focus filter (e.g. 'person:Jane Doe', 'project:remnic-core', 'topic:retrieval').",
                  },
                  namespace: { type: "string" },
                  format: { type: "string", enum: ["markdown", "json"] },
                  maxFollowups: {
                    type: "number",
                    description: "Maximum LLM-suggested follow-ups (0 disables that section).",
                  },
                },
                additionalProperties: false,
              },
            },
          ]
        : []),
      // ── Contradiction Review (issue #520) ────────────────────────────────
      {
        name: "engram.review_list",
        description: "List contradiction review items pending user resolution.",
        inputSchema: {
          type: "object",
          properties: {
            filter: {
              type: "string",
              enum: ["all", "unresolved", "contradicts", "independent", "duplicates", "needs-user"],
              description: "Filter by verdict type. Default: unresolved.",
            },
            namespace: { type: "string" },
            limit: { type: "number", description: "Max items to return (default 50)." },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.review_resolve",
        description: "Resolve a contradiction pair with a chosen verb.",
        inputSchema: {
          type: "object",
          properties: {
            pairId: { type: "string", description: "The contradiction pair ID to resolve." },
            verb: {
              type: "string",
              enum: ["keep-a", "keep-b", "merge", "both-valid", "needs-more-context"],
              description: "Resolution action.",
            },
            mergedMemoryId: { type: "string", description: "Existing merged memory ID to use when verb is merge." },
            mergedContent: { type: "string", description: "Content for a new merged memory when verb is merge." },
          },
          required: ["pairId", "verb"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.contradiction_scan_run",
        description: "Run an on-demand contradiction scan over the memory corpus.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_summarize_hourly",
        description: "Generate hourly summaries for recent conversations.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "engram.conversation_index_update",
        description: "Chunk transcript history into conversation-index documents.",
        inputSchema: {
          type: "object",
          properties: {
            sessionKey: { type: "string" },
            hours: { type: "number", description: "How many hours of transcript history to include." },
            embed: { type: "boolean", description: "If true, run QMD embed after update for this invocation." },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.profiling_report",
        description:
          "Return timing and performance data for Remnic recall and extraction pipelines. Requires profilingEnabled: true.",
        inputSchema: {
          type: "object",
          properties: {
            format: {
              type: "string",
              enum: ["ascii", "json"],
              description: "Output format. Defaults to ascii.",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 20,
              description: "Number of recent traces to include. Defaults to 5.",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.graph_edge_decay_run",
        description:
          "Run the graph-edge-confidence decay maintenance pass (issue #681 PR 2/3). Respects graphEdgeDecayEnabled; writes a structured telemetry record to state/graph-edge-decay-status.json.",
        inputSchema: {
          type: "object",
          properties: {
            dryRun: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.live_connectors_run",
        description:
          "Run due live connectors once. Used by the live-connector cron and available for operator-triggered sync checks.",
        inputSchema: {
          type: "object",
          properties: {
            force: {
              type: "boolean",
              description: "When true, run enabled connectors even if their poll interval has not elapsed.",
            },
          },
          additionalProperties: false,
        },
      },
      // ── Peer Registry tools (issue #679 PR 4/5) ─────────────────────────
      {
        name: "engram.peer_list",
        description:
          "List all registered peers in the peer registry (issue #679). Returns an array of peer identity records sorted alphabetically by id.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "engram.peer_get",
        description:
          "Get a single peer by id. Returns the peer's identity record or { found: false } when not found (issue #679).",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Peer id to look up." },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.peer_set",
        description:
          "Create or update a peer identity record (issue #679). On first write, creates the peer with the given kind (default 'human'). On subsequent writes, updates displayName and/or notes; kind and createdAt are immutable.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Peer id — must match PEER_ID_PATTERN." },
            kind: {
              type: "string",
              enum: ["self", "human", "agent", "integration"],
              description: "Kind of peer. Required on first write; ignored on updates.",
            },
            displayName: { type: "string", description: "Human-readable display name." },
            notes: { type: "string", description: "Optional free-form markdown notes." },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.peer_delete",
        description:
          "Delete a peer's identity record (issue #679). Idempotent — succeeds even if the peer does not exist. The peer directory is preserved so profile and interaction-log data are not destroyed.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Peer id to delete." },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.peer_profile_get",
        description:
          "Get the evolving cognitive profile for a peer (issue #679). Returns the profile written by the async reasoner (PR 2/5), or { found: false } if no profile has been generated yet.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Peer id whose profile to retrieve." },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.peer_forget",
        description:
          "DESTRUCTIVELY purge the entire peer directory (identity.md + profile.md + interactions.log.md and any companion files). " +
          "Requires confirm: 'yes'. Idempotent — safe to call twice. " +
          "Use engram.peer_delete when you only want to remove the identity record and preserve profile data.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Peer id to purge." },
            confirm: {
              type: "string",
              enum: ["yes"],
              description: "Must be exactly 'yes' to proceed. Guard against accidental invocation.",
            },
          },
          required: ["id", "confirm"],
          additionalProperties: false,
        },
      },
      // ── Operator Console state (issue #688 PR 2/3) ─────────────────────────
      {
        name: "engram.console_state",
        description:
          "Return a point-in-time ConsoleStateSnapshot of the engine's runtime state — buffer, extraction queue, dedup decisions, maintenance ledger tail, QMD probe, and daemon info (issue #688). Read-only; never mutates state.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: {
              type: "string",
              description: "Optional namespace to scope the snapshot.",
            },
          },
          additionalProperties: false,
        },
      },
      // ── Dreams telemetry (issue #678 PR 3+4) ─────────────────────────────
      {
        name: "engram.dreams_status",
        description:
          "Return per-phase Dreams pipeline telemetry for the last N hours (default 24). Reports run count, total duration, and items processed for each phase: lightSleep, rem, deepSleep.",
        inputSchema: {
          type: "object",
          properties: {
            windowHours: {
              type: "number",
              description: "How many hours to look back (default 24, minimum 1).",
            },
            namespace: {
              type: "string",
              description: "Optional namespace to read Dreams telemetry from.",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.dreams_run",
        description:
          "Manually invoke a single Dreams pipeline phase (lightSleep, rem, or deepSleep). Returns the same telemetry shape as a scheduled run. Pass dryRun: true to preview without committing writes.",
        inputSchema: {
          type: "object",
          properties: {
            phase: {
              type: "string",
              enum: ["lightSleep", "rem", "deepSleep"],
              description: "Which phase to run.",
            },
            dryRun: {
              type: "boolean",
              description: "When true, report what would change without committing writes (default false).",
            },
            namespace: {
              type: "string",
              description: "Optional namespace to run the phase in.",
            },
          },
          required: ["phase"],
          additionalProperties: false,
        },
      },
    ].flatMap((tool) => withToolAliases(tool, this.emitLegacyTools));
    if (this.codingDecisionVisible) {
      const codingDecisionTools = withToolAliases(
        {
          name: "engram.coding_decision",
          description:
            "List, get, record, or supersede decision records in the session's coding namespace (issue #1548 Track A). Subcommands: list, get, record, supersede.",
          inputSchema: {
            type: "object",
            properties: {
              subcommand: {
                type: "string",
                enum: ["list", "get", "record", "supersede"],
                description: "Which decision-record operation to run.",
              },
              sessionKey: {
                type: "string",
                description: "Session identifier whose coding context scopes the operation.",
              },
              namespace: {
                type: "string",
                description: "Optional explicit namespace (overrides coding-context overlay).",
              },
              id: { type: "string", description: "Decision record id (required for get and supersede)." },
              title: { type: "string", description: "Decision title (required for record and supersede)." },
              status: {
                type: "string",
                enum: ["proposed", "accepted", "superseded", "rejected"],
                description: "Decision status (record only; defaults to proposed).",
              },
              context: { type: "string", description: "Context/background for the decision." },
              decision: { type: "string", description: "The decision itself (required for record and supersede)." },
              consequences: { type: "string", description: "Consequences of the decision." },
              entityRefs: {
                type: "array",
                items: { type: "string" },
                description: "Entity references the decision relates to.",
              },
              supersedesId: {
                type: "string",
                description: "Id of the record this decision supersedes (supersede only).",
              },
            },
            required: ["subcommand"],
            additionalProperties: false,
          },
        },
        this.emitLegacyTools
      );
      this.tools = [...this.tools, ...codingDecisionTools];
    }
    if (this.architectureCardVisible) {
      const architectureTools = withToolAliases(
        {
          name: "engram.coding_architecture",
          description:
            "Get or refresh the architecture card for the session's coding namespace (issue #1548 Track A PR 3). Subcommands: get, refresh.",
          inputSchema: {
            type: "object",
            properties: {
              subcommand: {
                type: "string",
                enum: ["get", "refresh"],
                description: "Which architecture-card operation to run.",
              },
              sessionKey: {
                type: "string",
                description: "Session identifier whose coding context scopes the operation.",
              },
              namespace: {
                type: "string",
                description: "Optional explicit namespace (overrides coding-context overlay).",
              },
            },
            required: ["subcommand"],
            additionalProperties: false,
          },
        },
        this.emitLegacyTools
      );
      this.tools = [...this.tools, ...architectureTools];
    }
    if (this.codegraphVisible) {
      // The 14 codegraph parity tools (issue #1554). Each delegates to its
      // boundary operation; the MCP dispatch injects the `tool` field from
      // the operation name. The inputSchema is intentionally permissive —
      // the boundary's zod schema owns validation (rule 51).
      const codegraphToolDefs: Array<{ suffix: string; description: string; required?: string[] }> = [
        { suffix: "index", description: "Index a repository into the code graph.", required: ["repoRoot"] },
        { suffix: "list_projects", description: "List code graph projects for the principal." },
        {
          suffix: "delete_project",
          description: "Delete a code graph project (requires confirm: true).",
          required: ["confirm"],
        },
        { suffix: "index_status", description: "Get the indexing status for a project." },
        { suffix: "search_graph", description: "Search the code graph for symbols.", required: ["query"] },
        {
          suffix: "trace_path",
          description: "Trace call/dependency paths from a starting symbol.",
          required: ["start"],
        },
        { suffix: "detect_changes", description: "Detect changed symbols since a git ref.", required: ["head"] },
        {
          suffix: "query_graph",
          description: "Run a structured query against the code graph.",
          required: ["structuredQuery"],
        },
        { suffix: "get_schema", description: "Get the code graph schema statistics." },
        { suffix: "get_snippet", description: "Get a source code snippet for a symbol.", required: ["qualifiedName"] },
        { suffix: "get_architecture", description: "Get the composed architecture card + graph stats." },
        {
          suffix: "search_code",
          description: "Search the code graph for code (functions, classes, methods).",
          required: ["query"],
        },
        {
          suffix: "manage_adr",
          description: "Manage ADRs via Track A decision records (list, get, record, supersede).",
          required: ["subcommand"],
        },
        {
          suffix: "ingest_traces",
          description: "Ingest call-site traces to upgrade edge confidence.",
          required: ["traces"],
        },
      ];
      for (const def of codegraphToolDefs) {
        const tools = withToolAliases(
          {
            name: `engram.codegraph_${def.suffix}`,
            description: def.description,
            inputSchema: {
              type: "object",
              properties: {
                sessionKey: {
                  type: "string",
                  description: "Session identifier whose coding context scopes the operation.",
                },
                project: { type: "string", description: "Explicit project id (defaults to session coding context)." },
                principal: { type: "string", description: "Authenticated principal override." },
                query: { type: "string" },
                limit: { type: "number" },
                start: { type: "string" },
                direction: { type: "string", enum: ["inbound", "outbound", "both"] },
                depth: { type: "number" },
                qualifiedName: { type: "string" },
                path: { type: "string" },
                structuredQuery: { type: "object" },
                head: { type: "string" },
                repoRoot: { type: "string" },
                mode: { type: "string", enum: ["auto", "full", "incremental"] },
                confirm: { type: "boolean" },
                subcommand: { type: "string", enum: ["list", "get", "record", "supersede"] },
                id: { type: "string" },
                title: { type: "string" },
                status: { type: "string", enum: ["proposed", "accepted", "superseded", "rejected"] },
                context: { type: "string" },
                decision: { type: "string" },
                consequences: { type: "string" },
                entityRefs: { type: "array", items: { type: "string" } },
                supersedesId: { type: "string" },
                traces: { type: "array", items: { type: "object" } },
              },
              required: def.required ?? [],
              additionalProperties: false,
            },
          },
          this.emitLegacyTools
        );
        this.tools = [...this.tools, ...tools];
      }
    }
    if (this.sessionDeltaVisible) {
      const deltaTools = withToolAliases(
        {
          name: "engram.coding_delta",
          description:
            "Get the session delta (commits + touched files since last seen) for the session's coding namespace (issue #1548 Track A PR 4). Subcommand: get.",
          inputSchema: {
            type: "object",
            properties: {
              subcommand: {
                type: "string",
                enum: ["get"],
                description: "Which delta operation to run.",
              },
              sessionKey: {
                type: "string",
                description: "Session identifier whose coding context scopes the operation.",
              },
              namespace: {
                type: "string",
                description: "Optional explicit namespace (overrides coding-context overlay).",
              },
            },
            required: ["subcommand"],
            additionalProperties: false,
          },
        },
        this.emitLegacyTools
      );
      this.tools = [...this.tools, ...deltaTools];
    }
    if (this.correctionVisible) {
      // Correction Contract (issue #1580) — one plan/apply pipeline for every
      // memory correction. Both tools dispatch through the boundary operations
      // (memory_correct_plan / memory_correct_apply) which delegate to the
      // CorrectionService.
      const planTool = withToolAliases(
        {
          name: "engram.memory_correct_plan",
          description:
            "Plan a memory correction from a plain-language statement (issue #1580). Returns a CorrectionPlan with a diff preview; apply via memory_correct_apply.",
          inputSchema: {
            type: "object",
            properties: {
              text: {
                type: "string",
                description: 'The natural-language correction (e.g. "we migrated to MySQL in March").',
              },
              targetIds: {
                type: "array",
                items: { type: "string" },
                description: "Optional explicit target memory ids. When omitted, the planner searches.",
              },
              sessionKey: { type: "string", description: "Session identifier for namespace resolution." },
              namespace: { type: "string", description: "Optional explicit namespace (validated by policy)." },
            },
            required: ["text"],
            additionalProperties: false,
          },
        },
        this.emitLegacyTools
      );
      const applyTool = withToolAliases(
        {
          name: "engram.memory_correct_apply",
          description:
            "Apply a planned memory correction by planId (issue #1580). Requires confirm: true when correction.applyRequiresConfirm is on (default).",
          inputSchema: {
            type: "object",
            properties: {
              planId: { type: "string", description: "The plan id returned by memory_correct_plan." },
              confirm: { type: "boolean", description: "Must be true to apply (safety guard, rule 48)." },
              sessionKey: { type: "string", description: "Session identifier for namespace resolution." },
              namespace: { type: "string", description: "Optional explicit namespace (validated by policy)." },
            },
            required: ["planId"],
            additionalProperties: false,
          },
        },
        this.emitLegacyTools
      );
      this.tools = [...this.tools, ...planTool, ...applyTool];
    }
    if (this.chatVisible) {
      const chatTools = withToolAliases(
        {
          name: "engram.memory_chat",
          description:
            "Conversational memory inspection and correction (issue #1583). Send a message to chat about what Remnic remembers, inspect memories, or request corrections. Returns {reply, chatSessionId, pendingPlan?}.",
          inputSchema: {
            type: "object",
            properties: {
              message: {
                type: "string",
                description:
                  "The user's message — a question about memories, a correction request, or a confirmation (yes/apply) to proceed with a pending plan.",
              },
              chatSessionId: {
                type: "string",
                description: "Optional existing chat session id to resume. Omit to start a new session.",
              },
            },
            required: ["message"],
            additionalProperties: false,
          },
        },
        this.emitLegacyTools
      );
      this.tools = [...this.tools, ...chatTools];
    }
    // Apply `readOnlyHint` annotations to the conservative read-only
    // allowlist. Done as a final pass so every spread (chat, codegraph,
    // coding_*, correction, etc.) inherits the annotation without
    // scattering the same logic across every `withToolAliases` call site.
    // Suffix-based matching covers both the `remnic.*` and `engram.*`
    // naming forms emitted by `withToolAliases`.
    this.tools = this.tools.map((tool) =>
      isReadOnlyToolName(tool.name) && tool.annotations?.readOnlyHint !== true
        ? { ...tool, annotations: { ...(tool.annotations ?? {}), readOnlyHint: true } }
        : tool
    );
    // Apply `outputSchema` declarations from the registry. Like the
    // readOnlyHint pass above, this is a final suffix-based pass so every
    // tool (including both `remnic.*` and `engram.*` aliases) gets a
    // schema. Tools that already declare an outputSchema (e.g.
    // chatgpt_memory_inspector) are left untouched.
    this.tools = applyToolOutputSchemas(this.tools, CANONICAL_MCP_PREFIX, LEGACY_MCP_PREFIX);
  }

  /** Get clientInfo for a specific MCP session. Returns undefined for non-MCP requests. */
  getClientInfo(sessionId?: string): { name: string; version?: string } | undefined {
    if (sessionId) {
      return this.clientInfoBySession.get(sessionId);
    }
    return undefined;
  }

  /** Pop the session ID generated during an initialize handshake, keyed by correlation ID. */
  popInitSessionId(correlationId: string): string | undefined {
    const sid = this.initSessionIds.get(correlationId);
    if (sid !== undefined) this.initSessionIds.delete(correlationId);
    return sid;
  }

  async handleRequest(request: JsonRpcRequest, options?: McpRequestOptions): Promise<Record<string, unknown> | null> {
    const id = request.id ?? null;
    const method = request.method ?? "";

    if (method === "notifications/initialized") return null;
    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }
    if (method === "initialize") {
      const params = request.params ?? {};
      // MCP initialize REQUIRES params.protocolVersion (string). Reject a
      // missing/mistyped field with JSON-RPC invalid params instead of
      // silently negotiating (repo rule: never reinterpret invalid input).
      // An unsupported-but-well-formed version gets the spec-mandated
      // counter-offer below instead: the server answers with the newest
      // version it supports and the client decides whether to proceed.
      if (typeof params.protocolVersion !== "string" || params.protocolVersion.length === 0) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32602,
            message: `initialize requires params.protocolVersion (string); supported versions: ${MCP_SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
          },
        };
      }
      const rawClientInfo = params.clientInfo as { name?: string; version?: string } | undefined;
      // Generate a server-side session ID for this MCP session.
      // The caller should send this back as Mcp-Session-Id on subsequent requests.
      const newSessionId = randomUUID();
      if (rawClientInfo && typeof rawClientInfo.name === "string") {
        const info = { name: rawClientInfo.name, version: rawClientInfo.version as string | undefined };
        this.clientInfoBySession.set(newSessionId, info);
        // Evict oldest sessions if map exceeds limit
        if (this.clientInfoBySession.size > 1000) {
          const firstKey = this.clientInfoBySession.keys().next().value;
          if (firstKey) this.clientInfoBySession.delete(firstKey);
        }
      }
      const version = await getMcpServerVersion();
      // Store session ID keyed by correlation ID (unique per HTTP request) so
      // concurrent initializes with the same JSON-RPC id don't collide.
      const corrId = options?.correlationId;
      if (corrId) this.initSessionIds.set(corrId, newSessionId);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion)
            ? params.protocolVersion
            : MCP_DEFAULT_PROTOCOL_VERSION,
          capabilities: {
            tools: {},
            resources: {},
          },
          serverInfo: {
            name: "remnic",
            version,
          },
        },
      };
    }
    if (method === "tools/list") {
      // Issue #1850 round 5 (finding 3): a scoped/deny-all token must not
      // enumerate the full tool surface — filter advertised tools by the
      // token's ops allow-list via the same map callTool uses. Unrestricted
      // tokens (ops axis absent) see everything; unmapped tool ⇒ "" ⇒ hidden.
      const caps = tokenCapabilityStore.getStore();
      const tools = caps?.ops === undefined
        ? this.tools
        : this.tools.filter((t) => capabilityAllowsOp(caps, MCP_MIGRATED_OPERATIONS[toLegacyToolName(t.name)] ?? ""));
      return { jsonrpc: "2.0", id, result: { tools } };
    }
    if (method === "resources/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resources: this.resources,
        },
      };
    }
    if (method === "resources/templates/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resourceTemplates: [],
        },
      };
    }
    if (method === "resources/read") {
      const params = request.params ?? {};
      const uri = typeof params.uri === "string" ? params.uri : "";
      const resource = this.resources.find((entry) => entry.uri === uri);
      if (!resource) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32602,
            message: `Unknown resource URI: ${uri}`,
          },
        };
      }
      const text = this.resourceTextByUri.get(resource.uri);
      if (text === undefined) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: `Resource content unavailable: ${resource.uri}`,
          },
        };
      }
      return {
        jsonrpc: "2.0",
        id,
        result: {
          contents: [
            {
              uri: resource.uri,
              mimeType: resource.mimeType,
              text,
              _meta: resource._meta,
            },
          ],
        },
      };
    }
    if (method === "tools/call") {
      const params = request.params ?? {};
      const name = typeof params.name === "string" ? params.name : "";

      try {
        let argumentsObject: Record<string, unknown> = {};
        if ("arguments" in params && params.arguments !== undefined) {
          if (params.arguments === null || typeof params.arguments !== "object" || Array.isArray(params.arguments)) {
            throw new EngramAccessInputError("tools/call arguments must be an object when provided");
          }
          argumentsObject = params.arguments as Record<string, unknown>;
        }
        if (
          !("namespace" in argumentsObject) &&
          options?.namespaceOverride &&
          this.toolAcceptsArgument(name, "namespace")
        ) {
          argumentsObject = { ...argumentsObject, namespace: options.namespaceOverride };
        }
        const skipSessionKeyOverride =
          toLegacyToolName(name) === "engram.lcm_search" &&
          typeof argumentsObject.sessionPrefix === "string" &&
          argumentsObject.sessionPrefix.length > 0;
        if (
          !("sessionKey" in argumentsObject) &&
          !skipSessionKeyOverride &&
          options?.sessionKeyOverride &&
          this.toolAcceptsArgument(name, "sessionKey")
        ) {
          argumentsObject = { ...argumentsObject, sessionKey: options.sessionKeyOverride };
        }
        const effectivePrincipal = options?.principalOverride ?? this.authenticatedPrincipal;
        // Forward the MCP session scope (namespace/sessionKey overrides) so
        // tools like memory_chat bind the caller active scope (Thread 17).
        const mcpScope = {
          ...(options?.namespaceOverride ? { namespace: options.namespaceOverride } : {}),
          ...(options?.sessionKeyOverride ? { sessionKey: options.sessionKeyOverride } : {}),
        };
        // Abort before dispatch so a disconnected request never starts work.
        // Once a mutating tool has returned, cancellation is deferred to the
        // HTTP transport so it can account for the committed write first.
        throwMcpAbort(options?.abortSignal, "MCP request aborted before operation start");
        const result = await this.callTool(
          name,
          argumentsObject,
          effectivePrincipal,
          options?.sessionId,
          mcpScope,
          options?.enforceWriteQuota,
          options?.recordWriteCommit,
          options?.sourceConnector,
          options?.abortSignal,
        );
        if (isReadOnlyToolName(name)) {
          throwMcpAbort(options?.abortSignal, "MCP request aborted before response");
        }
        const structuredContent = result;
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }],
            ...(structuredContent == null ? {} : { structuredContent }),
            isError: false,
          },
        };
      } catch (err) {
        // Cancellation is transport control flow, not a JSON-RPC tool error.
        // Preserve the original AbortError so HTTP can silently end a dead socket.
        if (isAbortError(err)) throw err;
        const message = err instanceof Error ? err.message : String(err);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: message }],
            isError: true,
          },
        };
      }
    }

    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`,
      },
    };
  }

  async runStdio(input: Readable, output: Writable): Promise<void> {
    input.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      this.scheduleFlush(output);
    });
    await new Promise<void>((resolve, reject) => {
      input.on("end", resolve);
      input.on("error", reject);
    });
    while (this.flushTask) {
      await this.flushTask;
    }
  }

  private scheduleFlush(output: Writable): void {
    if (this.flushTask) return;
    const task = this.flushBuffer(output)
      .catch((err) => {
        this.writeMessage(output, {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: err instanceof Error ? err.message : String(err),
          },
        });
      })
      .finally(() => {
        if (this.flushTask === task) {
          this.flushTask = null;
        }
        if (this.buffer.length > 0) {
          this.scheduleFlush(output);
        }
      });
    this.flushTask = task;
  }

  private async flushBuffer(output: Writable): Promise<void> {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headerText = this.buffer.slice(0, headerEnd).toString("utf-8");
      const headers = headerText.split("\r\n");
      const contentLengthHeader = headers.find((line) => line.toLowerCase().startsWith("content-length:"));
      if (!contentLengthHeader) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      const contentLength = Number.parseInt(contentLengthHeader.split(":")[1]?.trim() ?? "0", 10);
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (this.buffer.length < messageEnd) return;
      const body = this.buffer.slice(messageStart, messageEnd).toString("utf-8");
      this.buffer = this.buffer.slice(messageEnd);

      let parsed: JsonRpcRequest;
      try {
        parsed = JSON.parse(body) as JsonRpcRequest;
      } catch {
        this.writeMessage(output, {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: "Parse error",
          },
        });
        continue;
      }
      const response = await this.handleRequest(parsed);
      if (response) {
        this.writeMessage(output, response);
      }
    }
  }

  private writeMessage(output: Writable, payload: Record<string, unknown>): void {
    const body = JSON.stringify(payload);
    const message = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`;
    output.write(message);
  }

  private toolAcceptsArgument(name: string, key: string): boolean {
    // Match by canonical name so argument validation resolves whether the
    // caller used the `engram.*` or `remnic.*` name and regardless of whether
    // legacy aliases are advertised (issue #1427) — a tool stays callable under
    // both names even when only the canonical alias appears in `tools/list`.
    const target = toCanonicalToolName(name);
    const tool = this.tools.find((entry) => toCanonicalToolName(entry.name) === target);
    const inputSchema = getObjectProperties(tool?.inputSchema);
    const properties = getObjectProperties(inputSchema?.properties);
    if (properties && Object.prototype.hasOwnProperty.call(properties, key)) {
      return true;
    }
    return inputSchema?.additionalProperties === true;
  }

  /**
   * Whether a tool accepts a `namespace` argument — i.e. it is a
   * namespace-scoped operation whose effective namespace MUST be gated by the
   * per-token allow-list. Exposed (public) so the HTTP MCP transport can run
   * the SAME effective-namespace enforcement the REST surface runs, without
   * duplicating the tool-schema introspection (issue #1850). Namespace-
   * agnostic tools (peer/wearables/etc.) return false and stay ungated,
   * matching the REST surface where those routes never call resolveNamespace.
   */
  toolAcceptsNamespace(name: string): boolean {
    return this.toolAcceptsArgument(name, "namespace");
  }

  /**
   * Determine whether oai-mem-citation guidance should be appended to recall.
   * Returns true when explicitly enabled via config OR when auto-detect is
   * active and the current MCP session belongs to a Codex adapter client.
   *
   * When no sessionId is provided (e.g., stdio transport where there are no
   * HTTP headers carrying mcp-session-id), fall back to checking if there is
   * exactly one known session whose clientInfo matches the Codex pattern.
   * This covers the common stdio case where a single client connection exists.
   */
  private shouldEmitCitations(mcpSessionId?: string): boolean {
    if (this.citationsEnabled) return true;
    if (!this.citationsAutoDetect) return false;

    // Direct session lookup (HTTP transport with mcp-session-id header).
    if (mcpSessionId) {
      const info = this.clientInfoBySession.get(mcpSessionId);
      if (!info) return false;
      return this.isCodexClient(info);
    }

    // Stdio fallback: no session ID available. If there is exactly one session
    // registered (the typical stdio pattern), check that session's clientInfo.
    if (this.clientInfoBySession.size === 1) {
      const [info] = [...this.clientInfoBySession.values()];
      if (info) return this.isCodexClient(info);
    }

    return false;
  }

  /** Check whether a clientInfo record identifies a Codex adapter client. */
  private isCodexClient(info: { name: string; version?: string }): boolean {
    const lowerName = info.name.toLowerCase();
    return lowerName === "codex-mcp-client" || lowerName.includes("codex");
  }

  /**
   * Build citation metadata for each recall result that has a path.
   * Line range defaults to 1-1 when not determinable from the summary.
   */
  private buildRecallCitations(response: EngramAccessRecallResponse): CitationMetadata[] {
    return response.results
      .filter((r) => r.path && r.path.length > 0)
      .map((r) => ({
        memoryId: r.id,
        path: r.path,
        lineStart: 1,
        lineEnd: 1,
        noteDefault: r.preview?.slice(0, 60) || r.id,
      }));
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
    effectivePrincipal?: string,
    mcpSessionId?: string,
    scope?: { namespace?: string; sessionKey?: string },
    enforceWriteQuota?: () => void | Promise<void>,
    recordWriteCommit?: () => void,
    sourceConnector?: string,
    abortSignal?: AbortSignal,
  ): Promise<unknown> {
    const migrated = MCP_MIGRATED_OPERATIONS[toLegacyToolName(name)];
    if (!migrated) {
      throw new Error(`unknown tool: ${name}`);
    }
    const op = getOperation(migrated);
    if (!op) {
      throw new EngramAccessInputError(`access-boundary: operation not registered: ${migrated}`);
    }
    let envelope: Record<string, unknown>;
    if (migrated === "memory_store") {
      envelope = parseMcpRequest("memoryStore", args);
    } else if (migrated === "suggestion_submit") {
      envelope = parseMcpRequest("suggestionSubmit", args);
    } else if (migrated === "action_confidence") {
      envelope = parseMcpRequest("actionConfidence", args);
    } else if (migrated === "day_summary") {
      envelope = parseMcpRequest("daySummary", args);
    } else if (migrated === "capsule_export") {
      envelope = parseMcpRequest("capsuleExport", args);
    } else if (migrated === "capsule_import") {
      envelope = parseMcpRequest("capsuleImport", args);
    } else if (migrated === "capsule_list") {
      envelope = parseMcpRequest("capsuleList", args);
    } else if (migrated === "observe") {
      envelope = parseMcpRequest("observe", args);
    } else if (migrated === "lcm_compaction_flush") {
      envelope = parseMcpRequest("lcmCompactionFlush", args);
    } else if (migrated === "extraction_force_flush") {
      envelope = parseMcpRequest("extractionForceFlush", args);
    } else if (migrated === "lcm_compaction_record") {
      envelope = parseMcpRequest("lcmCompactionRecord", args);
    } else if (migrated.startsWith("codegraph_")) {
      envelope = { ...args, tool: migrated.slice("codegraph_".length) };
    } else if (migrated === "chat_message") {
      // memory_chat bypasses op.run(); gate op + resumed-session namespace like the HTTP route (#1850 r6).
      assertOperationAllowed(tokenCapabilityStore.getStore(), migrated);
      const message = typeof args.message === "string" ? args.message : "";
      if (!message) throw new EngramAccessInputError("message is required");
      const chatSessionId = typeof args.chatSessionId === "string" ? args.chatSessionId : undefined;
      if (chatSessionId) {
        await enforceChatSessionNamespace(this.service, chatSessionId);
      } else {
        // NEW chat session (no chatSessionId): processChatMessage mints a fresh
        // session under the EFFECTIVE namespace (scope.namespace OR server
        // default). Unlike the HTTP chat handler (which forwards no namespace),
        // the MCP scope CAN carry one (Thread 17), so route it through the SAME
        // effective-namespace chokepoint as the HTTP new-chat path
        // (enforceNamespaceAllowList maps undefined → default) — a namespace-
        // scoped token CANNOT start a chat in a namespace outside its allow-
        // list, including an unconfigured/forbidden server default. Fail closed;
        // no-op for unrestricted/legacy tokens (issue #1850 round 8).
        enforceNamespaceAllowList(
          tokenCapabilityStore.getStore(),
          scope?.namespace,
          this.service.configRef?.defaultNamespace,
        );
      }
      const chatResult = await processChatMessage({
        service: this.service,
        config: this.service.configRef?.chat,
        memoryDir: this.service.memoryDir,
        message,
        ...(chatSessionId ? { chatSessionId } : {}),
        ...(effectivePrincipal ? { principal: effectivePrincipal } : {}),
        ...(scope?.namespace ? { namespace: scope.namespace } : {}),
        ...(scope?.sessionKey ? { sessionKey: scope.sessionKey } : {}),
      });
      if (chatResult && typeof chatResult === "object" && "error" in chatResult) {
        const { error: _stripped, ...wireResult } = chatResult as unknown as Record<string, unknown>;
        return wireResult;
      }
      return chatResult;
    } else {
      envelope = args;
    }
    // recall citation guidance (MCP-specific post-processing).
    if (migrated === "recall") {
      const result = (await op.run(envelope, {
        service: this.service,
        authenticatedPrincipal: effectivePrincipal,
        ...(abortSignal ? { abortSignal } : {}),
      })) as { result: unknown };
      throwMcpAbort(abortSignal, "MCP recall aborted before postprocessing");
      const response = result.result as Record<string, unknown>;
      if (this.shouldEmitCitations(mcpSessionId)) {
        const citations = this.buildRecallCitations(response as unknown as EngramAccessRecallResponse);
        const guidance = buildCitationGuidance(citations);
        if (guidance.length > 0) {
          return {
            ...response,
            context: (((response as Record<string, unknown>).context as string) ?? "") + guidance,
            citations,
          };
        }
      }
      return response;
    }
    const output = (await op.run(envelope, {
      service: this.service,
      authenticatedPrincipal: effectivePrincipal,
      ...(enforceWriteQuota || recordWriteCommit
        ? { hooks: { ...(enforceWriteQuota ? { enforceWriteQuota } : {}), ...(recordWriteCommit ? { recordWriteCommit } : {}) } }
        : {}),
      ...(sourceConnector ? { sourceConnector } : {}),
      ...(abortSignal ? { abortSignal } : {}),
    })) as { result: unknown };
    return output.result;
  }
}
