import type { Readable, Writable } from "node:stream";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { EngramAccessInputError, type EngramAccessService, type EngramAccessRecallResponse } from "./access-service.js";
import {
  validateRequest,
  type ActionConfidenceRequest,
  type CapsuleExportRequest,
  type CapsuleImportRequest,
  type CapsuleListRequest,
  type MemoryStoreRequest,
  type SchemaName,
  type SchemaTypeFor,
  type SuggestionSubmitRequest,
} from "./access-schema.js";
import { readEnvVar } from "./runtime/env.js";
import type { RecallDisclosure, RecallPlanMode } from "./types.js";
import { validateBriefingFormat } from "./briefing.js";
import { buildCitationGuidance, type CitationMetadata } from "./citations.js";
import { projectTagProjectId } from "./coding/coding-namespace.js";
import { expandTildePath } from "./utils/path.js";
import {
  REMNIC_CHATGPT_MEMORY_INSPECTOR_MIME_TYPE,
  REMNIC_CHATGPT_MEMORY_INSPECTOR_TOOL,
  REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_HTML,
  REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_URI,
  buildChatGptMemoryInspectorActionRequest,
  buildChatGptMemoryInspectorResult,
  type RemnicChatGptMemoryInspectorInput,
} from "./mcp-memory-inspector-app.js";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

type McpRequestOptions = {
  principalOverride?: string;
  namespaceOverride?: string;
  sessionKeyOverride?: string;
  sessionId?: string;
  correlationId?: string;
};

type McpTool = {
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

const MCP_PROTOCOL_VERSION = "2024-11-05";
const LEGACY_MCP_PREFIX = "engram.";
const CANONICAL_MCP_PREFIX = "remnic.";

function toCanonicalToolName(name: string): string {
  return name.startsWith(LEGACY_MCP_PREFIX)
    ? `${CANONICAL_MCP_PREFIX}${name.slice(LEGACY_MCP_PREFIX.length)}`
    : name;
}

function toLegacyToolName(name: string): string {
  return name.startsWith(CANONICAL_MCP_PREFIX)
    ? `${LEGACY_MCP_PREFIX}${name.slice(CANONICAL_MCP_PREFIX.length)}`
    : name;
}

function withToolAliases(tool: McpTool): McpTool[] {
  const canonicalName = toCanonicalToolName(tool.name);
  const canonicalTool = canonicalName === tool.name ? tool : { ...tool, name: canonicalName };
  if (canonicalName === tool.name) return [canonicalTool];
  return [canonicalTool, tool];
}

function resolveChatGptInspectorRecallSessionKey(
  explicitSessionKey: string | undefined,
  authenticatedPrincipal: string | undefined,
): string | undefined {
  if (explicitSessionKey) return explicitSessionKey;
  if (!authenticatedPrincipal) return undefined;
  return `remnic:chatgpt-memory-inspector:${randomUUID()}`;
}

const STRICT_MCP_SCHEMA_KEYS: Partial<Record<SchemaName, readonly string[]>> = {
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
  ],
  capsuleExport: [
    "name",
    "namespace",
    "since",
    "includeKinds",
    "peerIds",
    "includeTranscripts",
    "encrypt",
  ],
  capsuleImport: ["archivePath", "namespace", "mode"],
  capsuleList: ["namespace"],
};

function parseMcpRequest<N extends SchemaName>(
  schemaName: N,
  args: Record<string, unknown>,
): SchemaTypeFor<N> {
  const allowedKeys = STRICT_MCP_SCHEMA_KEYS[schemaName];
  if (allowedKeys) {
    const allowed = new Set(allowedKeys);
    const unexpected = Object.keys(args).filter((key) => !allowed.has(key));
    if (unexpected.length > 0) {
      throw new EngramAccessInputError(
        `request validation failed: (root): Unrecognized key(s) in object: ${unexpected.join(", ")}`,
      );
    }
  }
  const validation = validateRequest<SchemaTypeFor<N>>(schemaName, args);
  if (validation.success) return validation.data;
  const details = validation.error.details
    .map((detail) => `${detail.field}: ${detail.message}`)
    .join("; ");
  throw new EngramAccessInputError(
    details.length > 0
      ? `${validation.error.error}: ${details}`
      : validation.error.error,
  );
}

async function getMcpServerVersion(): Promise<string> {
  const envVersion =
    readEnvVar("OPENCLAW_ENGRAM_VERSION")?.trim() ||
    readEnvVar("npm_package_version")?.trim();
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

  /** Whether oai-mem-citation guidance is explicitly enabled via config. */
  private readonly citationsEnabled: boolean;
  /** Whether to auto-enable citations for Codex adapter connections. */
  private readonly citationsAutoDetect: boolean;

  constructor(
    private readonly service: EngramAccessService,
    options: { principal?: string; citationsEnabled?: boolean; citationsAutoDetect?: boolean } = {},
  ) {
    this.citationsEnabled = options.citationsEnabled === true;
    this.citationsAutoDetect = options.citationsAutoDetect !== false;
    this.authenticatedPrincipal =
      options.principal?.trim() ||
      readEnvVar("OPENCLAW_ENGRAM_ACCESS_PRINCIPAL")?.trim() ||
      undefined;
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
      [
        REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_URI,
        REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_HTML,
      ],
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
            projectTag: { type: "string", description: "Project tag for non-git project scoping (e.g. 'blend-supply')." },
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
              description: "Tag-filter match mode. 'any' (default) admits results with at least one filter tag; 'all' requires every filter tag.",
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
                    defaultBranch: { type: ["string", "null"], description: "Default branch (usually main/master), or null when unknown." },
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
                "Arbitrary project tag for non-git project scoping (e.g. 'blend-supply'). " +
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
              description:
                "Optional positive-integer override for the recall character budget.",
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
                    enum: [
                      "ask-before",
                      "do-not-use-outside-this-context",
                      "never",
                      "requires-escalation",
                    ],
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
              description:
                "Optional current user-context scopes, such as repo, work, personal, client, or private.",
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
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: "engram.capsule_export",
        description: "Export a portable Remnic capsule archive from the namespace-scoped memory store.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Capsule id (alphanumeric with single dashes, max 64 characters).",
            },
            namespace: { type: "string" },
            since: {
              type: "string",
              description: "Only include files modified on or after this ISO 8601 timestamp.",
            },
            includeKinds: {
              type: "array",
              items: { type: "string" },
              description: "Optional top-level directory allow-list.",
            },
            peerIds: {
              type: "array",
              items: { type: "string" },
              description: "Optional peer id allow-list for the peers/ subtree.",
            },
            includeTranscripts: { type: "boolean" },
            encrypt: { type: "boolean" },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.capsule_import",
        description: "Import a Remnic capsule archive into the namespace-scoped memory store.",
        inputSchema: {
          type: "object",
          properties: {
            archivePath: {
              type: "string",
              description: "Path to a .capsule.json.gz or .capsule.json.gz.enc archive.",
            },
            namespace: { type: "string" },
            mode: {
              type: "string",
              enum: ["skip", "overwrite", "fork"],
              description: "Conflict handling mode. Defaults to skip.",
            },
          },
          required: ["archivePath"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.capsule_list",
        description: "List capsule archives in the namespace-scoped capsule store.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_governance_run",
        description: "Run Remnic memory governance in a bounded shadow/apply pass.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
            mode: { type: "string", enum: ["shadow", "apply"] },
            recentDays: { type: "number" },
            maxMemories: { type: "number" },
            batchSize: { type: "number" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.procedure_mining_run",
        description:
          "Run procedural memory mining from causal trajectories (issue #519). Respects procedural.enabled; writes under procedures/ when clusters qualify.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.pattern_reinforcement_run",
        description:
          "Run the pattern-reinforcement maintenance job (issue #687 PR 2/4). Clusters duplicate non-procedural memories by normalized content, promotes the most-recent member to canonical, and supersedes the older duplicates. Gated on patternReinforcementEnabled and the patternReinforcementCadenceMs floor — pass force=true to bypass the cadence for an ad-hoc operator run.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
            force: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
      {
        // The canonical `remnic.procedural_stats` alias is added automatically
        // by `withToolAliases` — the dual-naming invariant keeps both names
        // alive for the legacy surface.
        name: "engram.procedural_stats",
        description:
          "Procedural memory stats (issue #567): counts by status, recent write activity, and the active procedural.* config. Read-only, namespace-scoped.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_get",
        description: "Fetch one Remnic memory by id.",
        inputSchema: {
          type: "object",
          properties: {
            memoryId: { type: "string" },
            namespace: { type: "string" },
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
            namespace: { type: "string" },
            skipExtraction: { type: "boolean" },
            cwd: { type: "string", description: "Working directory for auto git-context resolution." },
            projectTag: { type: "string", description: "Project tag for non-git project scoping (e.g. 'blend-supply')." },
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
        description:
          "Flush pending LCM observe work and incremental summaries before a host compacts session context.",
        inputSchema: {
          type: "object",
          properties: {
            sessionKey: { type: "string", description: "Conversation session identifier" },
            namespace: { type: "string" },
          },
          required: ["sessionKey"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.lcm_compaction_record",
        description:
          "Record a host compaction event with before/after token counts in the LCM archive.",
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
            key: { type: "string", description: "Period key (weekly: YYYY-Www, monthly: YYYY-MM). Defaults to current." },
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
            communicationPreferences: { type: "string", description: "Updates for 'Communication Preferences' section." },
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
        description: "Manage work-layer tasks (create, get, list, update, transition, delete). Excluded from memory extraction.",
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
        description: "Manage work-layer projects (create, get, list, update, delete, link_task). Excluded from memory extraction.",
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
        description: "Generate weekly compounding outputs: reports, mistake registry, rubrics, and promotion candidates.",
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
        description: "Direct semantic search over memory files using the QMD index. Returns matching memories with relevance scores.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            namespace: { type: "string" },
            maxResults: { type: "number" },
            collection: { type: "string", description: "QMD collection (omit for memory, 'global' for all)" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_profile",
        description: "Read the user's behavioral profile — a living document of their preferences, habits, and personality.",
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
        description: "Return a read-only graph snapshot (nodes + edges) for the admin pane. Filters: limit (default 500, max 5000), since (ISO timestamp), focusNodeId (restricts to neighborhood), categories (allow-list of memory categories).",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
            limit: { type: "number", description: "Maximum number of edges to return (default 500, max 5000)." },
            since: { type: "string", description: "Inclusive lower bound on edge timestamp (ISO-8601)." },
            focusNodeId: { type: "string", description: "When set, restrict the snapshot to the focus node and its neighbors." },
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
        description: "Record a Memory Worth outcome (success/failure) for a memory. Increments mw_success or mw_fail in the memory's frontmatter for use by the recall filter.",
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
        description:
          "Record a memory-action application event for policy-learning telemetry.",
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
      ...(service.briefingEnabled ? [{
        name: "engram.briefing",
        description: "Generate a daily context briefing by cross-referencing active entities, recent facts, open commitments, and optional calendar events.",
        inputSchema: {
          type: "object",
          properties: {
            since: { type: "string", description: "Lookback window (e.g. 'yesterday', '3d', '1w', '24h')." },
            focus: { type: "string", description: "Optional focus filter (e.g. 'person:Jane Doe', 'project:remnic-core', 'topic:retrieval')." },
            namespace: { type: "string" },
            format: { type: "string", enum: ["markdown", "json"] },
            maxFollowups: { type: "number", description: "Maximum LLM-suggested follow-ups (0 disables that section)." },
          },
          additionalProperties: false,
        },
      }] : []),
      // ── Contradiction Review (issue #520) ────────────────────────────────
      {
        name: "engram.review_list",
        description: "List contradiction review items pending user resolution.",
        inputSchema: {
          type: "object",
          properties: {
            filter: { type: "string", enum: ["all", "unresolved", "contradicts", "independent", "duplicates", "needs-user"], description: "Filter by verdict type. Default: unresolved." },
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
            verb: { type: "string", enum: ["keep-a", "keep-b", "merge", "both-valid", "needs-more-context"], description: "Resolution action." },
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
    ].flatMap((tool) => withToolAliases(tool));
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
          protocolVersion: MCP_PROTOCOL_VERSION,
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
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: this.tools,
        },
      };
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
        if (!("namespace" in argumentsObject) && options?.namespaceOverride) {
          argumentsObject = { ...argumentsObject, namespace: options.namespaceOverride };
        }
        if (!("sessionKey" in argumentsObject) && options?.sessionKeyOverride) {
          argumentsObject = { ...argumentsObject, sessionKey: options.sessionKeyOverride };
        }
        const effectivePrincipal = options?.principalOverride ?? this.authenticatedPrincipal;
        const result = await this.callTool(name, argumentsObject, effectivePrincipal, options?.sessionId);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
            isError: false,
          },
        };
      } catch (err) {
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
      const contentLength = parseInt(contentLengthHeader.split(":")[1]?.trim() ?? "0", 10);
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

  private async callTool(name: string, args: Record<string, unknown>, effectivePrincipal?: string, mcpSessionId?: string): Promise<unknown> {
    switch (toLegacyToolName(name)) {
      case "engram.recall": {
        // Forward `disclosure` only when the caller actually supplied it,
        // so the service layer's default-application path stays the
        // single source of truth.  We must distinguish "absent" from
        // "present-but-wrong-type": absence forwards as `undefined`
        // (service applies the chunk default), while a present-but-
        // non-string value (e.g. `1`, `true`) is rejected here as a
        // structured input error instead of silently being coerced to
        // `undefined`.  CLAUDE.md rule 51: never silently default on
        // malformed input.  String values are forwarded as-is; the
        // service's `isRecallDisclosure` guard rejects unknown enum
        // strings (e.g. `"verbose"`) with the same error class.
        let disclosure: RecallDisclosure | undefined;
        if ("disclosure" in args && args.disclosure !== undefined && args.disclosure !== null) {
          if (typeof args.disclosure !== "string") {
            throw new EngramAccessInputError(
              "disclosure must be a string (one of: chunk, section, raw)",
            );
          }
          disclosure = args.disclosure as RecallDisclosure;
        }
        // Reject non-string cwd/projectTag (CLAUDE.md #51) — these control
        // namespace routing so silent coercion to undefined would mix memories.
        if ("cwd" in args && args.cwd !== undefined && args.cwd !== null && typeof args.cwd !== "string") {
          throw new EngramAccessInputError("cwd must be a string");
        }
        if ("projectTag" in args && args.projectTag !== undefined && args.projectTag !== null && typeof args.projectTag !== "string") {
          throw new EngramAccessInputError("projectTag must be a string");
        }
        // Issue #680 — historical recall pin. Reject non-string asOf
        // values up-front so malformed payloads surface as structured
        // input errors. The service layer performs Date.parse on the
        // string value.
        if ("asOf" in args && args.asOf !== undefined && args.asOf !== null && typeof args.asOf !== "string") {
          throw new EngramAccessInputError("asOf must be a string (ISO 8601 timestamp)");
        }
        // Tag filter (issue #689). Reject malformed tags / tagMatch
        // up front rather than silently dropping (CLAUDE.md rule 51).
        let tags: string[] | undefined;
        if ("tags" in args && args.tags !== undefined && args.tags !== null) {
          if (!Array.isArray(args.tags) || !args.tags.every((t) => typeof t === "string")) {
            throw new EngramAccessInputError("tags must be an array of strings");
          }
          tags = args.tags;
        }
        let tagMatch: "any" | "all" | undefined;
        if ("tagMatch" in args && args.tagMatch !== undefined && args.tagMatch !== null) {
          if (typeof args.tagMatch !== "string" || (args.tagMatch !== "any" && args.tagMatch !== "all")) {
            throw new EngramAccessInputError(
              `tagMatch must be one of: any, all (got: ${String(args.tagMatch)})`,
            );
          }
          tagMatch = args.tagMatch;
        }
        const response = await this.service.recall({
          query: typeof args.query === "string" ? args.query : "",
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : undefined,
          authenticatedPrincipal: effectivePrincipal,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          topK: typeof args.topK === "number" && Number.isFinite(args.topK) ? args.topK : undefined,
          mode: typeof args.mode === "string" ? args.mode as RecallPlanMode | "auto" : undefined,
          includeDebug: args.includeDebug === true,
          disclosure,
          cwd: typeof args.cwd === "string" ? args.cwd : undefined,
          projectTag: typeof args.projectTag === "string" ? args.projectTag : undefined,
          asOf: typeof args.asOf === "string" ? args.asOf : undefined,
          ...(tags !== undefined ? { tags } : {}),
          ...(tagMatch !== undefined ? { tagMatch } : {}),
        });

        if (this.shouldEmitCitations(mcpSessionId)) {
          const citations = this.buildRecallCitations(response);
          const guidance = buildCitationGuidance(citations);
          if (guidance.length > 0) {
            return {
              ...response,
              context: response.context + guidance,
              citations,
            };
          }
        }
        return response;
      }
      case "engram.recall_explain":
        return this.service.recallExplain({
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
        });
      case "engram.set_coding_context": {
        // Issue #569 PR 7 — MCP tool for clients that don't ship cwd.
        // Validation lives in EngramAccessService.setCodingContext; any
        // EngramAccessInputError surfaces as a structured tool-call error.
        const sessionKey = typeof args.sessionKey === "string" ? args.sessionKey : "";
        // Support projectTag as an alternative to full codingContext.
        // When projectTag is provided and codingContext is absent, create
        // a tag-based context (issue #569 wiring).
        const hasProjectTag = typeof args.projectTag === "string" && args.projectTag.trim().length > 0;
        const hasCodingContext = "codingContext" in args;
        if (!hasCodingContext && hasProjectTag) {
          const tag = (args.projectTag as string).trim();
          const projectId = projectTagProjectId(tag);
          this.service.setCodingContext({
            sessionKey,
            codingContext: {
              projectId,
              branch: null,
              rootPath: projectId,
              defaultBranch: null,
            },
          });
          return { ok: true };
        }
        // Require at least one of codingContext or projectTag (CLAUDE.md #51).
        if (!hasCodingContext && !hasProjectTag) {
          throw new EngramAccessInputError(
            "set_coding_context requires either codingContext or projectTag",
          );
        }
        const rawCtx = args.codingContext;
        let codingContext: {
          projectId: string;
          branch: string | null;
          rootPath: string;
          defaultBranch: string | null;
        } | null = null;
        if (rawCtx !== null) {
          if (typeof rawCtx !== "object" || rawCtx === undefined) {
            throw new EngramAccessInputError("codingContext must be an object or null");
          }
          const obj = rawCtx as Record<string, unknown>;
          const projectId = typeof obj.projectId === "string" ? obj.projectId : "";
          const rootPath = typeof obj.rootPath === "string" ? obj.rootPath : "";
          const branch = obj.branch === null
            ? null
            : typeof obj.branch === "string" ? obj.branch : undefined;
          const defaultBranch = obj.defaultBranch === null
            ? null
            : typeof obj.defaultBranch === "string" ? obj.defaultBranch : undefined;
          if (branch === undefined) {
            throw new EngramAccessInputError("codingContext.branch must be a string or null");
          }
          if (defaultBranch === undefined) {
            throw new EngramAccessInputError("codingContext.defaultBranch must be a string or null");
          }
          codingContext = { projectId, branch, rootPath, defaultBranch };
        }
        this.service.setCodingContext({ sessionKey, codingContext });
        return { ok: true };
      }
      case "engram.recall_tier_explain":
        return this.service.recallTierExplain(
          typeof args.sessionKey === "string" && args.sessionKey.length > 0
            ? args.sessionKey
            : undefined,
          typeof args.namespace === "string" && args.namespace.length > 0
            ? args.namespace
            : undefined,
          effectivePrincipal,
        );
      case "engram.recall_xray": {
        // `recallXray` throws on empty query / invalid budget; surface
        // those as MCP errors with a listed-options message rather
        // than silently returning `snapshotFound: false` (CLAUDE.md
        // rule 51).  Namespace scope is enforced inside the service
        // via `canReadNamespace`.
        const query = typeof args.query === "string" ? args.query : "";
        const sessionKey =
          typeof args.sessionKey === "string" && args.sessionKey.length > 0
            ? args.sessionKey
            : undefined;
        const namespace =
          typeof args.namespace === "string" && args.namespace.length > 0
            ? args.namespace
            : undefined;
        // `budget` may arrive as a JSON number or a string ('4096')
        // from loosely-typed MCP clients; coerce + validate here so
        // the service sees a number.  Reject booleans, objects, and
        // other non-string-non-number inputs explicitly — `Number()`
        // otherwise coerces `true` to `1`, which would silently force
        // an extremely small recall budget (CLAUDE.md rule 51).
        let budget: number | undefined;
        if (args.budget !== undefined && args.budget !== null) {
          if (typeof args.budget !== "number" && typeof args.budget !== "string") {
            throw new Error(
              `engram.recall_xray: budget expects a positive integer; got ${JSON.stringify(args.budget)}`,
            );
          }
          const parsed =
            typeof args.budget === "number"
              ? args.budget
              : Number(args.budget);
          if (
            !Number.isFinite(parsed)
            || parsed <= 0
            || !Number.isInteger(parsed)
          ) {
            throw new Error(
              `engram.recall_xray: budget expects a positive integer; got ${JSON.stringify(args.budget)}`,
            );
          }
          budget = parsed;
        }
        // Forward disclosure depth so the recallXray telemetry table is
        // populated for MCP callers (issue #677 PR 3/4).  Reject
        // non-string types explicitly (matches the strict input
        // contract used elsewhere in this handler — see `budget` /
        // `disclosure` in engram.recall around line 1198 — and the
        // HTTP path's 400-on-bad-disclosure handling).  Treat empty
        // string as absent so HTTP `?disclosure=` and MCP align on
        // the same observable contract for that pathological input.
        // Non-empty strings flow through to the service's strict
        // allow-list validator (which throws on unknown values).
        let disclosure: string | undefined;
        if (
          "disclosure" in args &&
          args.disclosure !== undefined &&
          args.disclosure !== null &&
          args.disclosure !== ""
        ) {
          if (typeof args.disclosure !== "string") {
            throw new Error(
              "engram.recall_xray: disclosure must be a string (one of: chunk, section, raw)",
            );
          }
          disclosure = args.disclosure;
        }
        return this.service.recallXray({
          query,
          sessionKey,
          namespace,
          budget,
          authenticatedPrincipal: effectivePrincipal,
          ...(disclosure !== undefined
            ? { disclosure: disclosure as import("./types.js").RecallDisclosure }
            : {}),
        });
      }
      case "engram.action_confidence": {
        const body: ActionConfidenceRequest = parseMcpRequest("actionConfidence", args);
        return this.service.actionConfidence(body);
      }
      case REMNIC_CHATGPT_MEMORY_INSPECTOR_TOOL: {
        if (typeof args.query !== "string" || args.query.trim().length === 0) {
          throw new EngramAccessInputError(
            "chatgpt_memory_inspector requires a non-empty query string",
          );
        }
        if (
          "sessionKey" in args &&
          args.sessionKey !== undefined &&
          args.sessionKey !== null &&
          typeof args.sessionKey !== "string"
        ) {
          throw new EngramAccessInputError("sessionKey must be a string");
        }
        if (
          "namespace" in args &&
          args.namespace !== undefined &&
          args.namespace !== null &&
          typeof args.namespace !== "string"
        ) {
          throw new EngramAccessInputError("namespace must be a string");
        }
        let currentContextScopes: string[] | undefined;
        if (args.currentContextScopes !== undefined && args.currentContextScopes !== null) {
          if (
            !Array.isArray(args.currentContextScopes) ||
            !args.currentContextScopes.every((scope) => typeof scope === "string")
          ) {
            throw new EngramAccessInputError(
              "currentContextScopes must be an array of strings",
            );
          }
          currentContextScopes = args.currentContextScopes;
        }

        const input: RemnicChatGptMemoryInspectorInput = {
          query: args.query.trim(),
        };
        if (typeof args.sessionKey === "string" && args.sessionKey.trim().length > 0) {
          input.sessionKey = args.sessionKey;
        }
        if (typeof args.namespace === "string" && args.namespace.trim().length > 0) {
          input.namespace = args.namespace;
        }
        if (currentContextScopes !== undefined) {
          input.currentContextScopes = currentContextScopes;
        }
        const recallSessionKey = resolveChatGptInspectorRecallSessionKey(
          input.sessionKey,
          effectivePrincipal,
        );
        const xrayResponse = await this.service.recallXray({
          query: input.query,
          sessionKey: recallSessionKey,
          namespace: input.namespace,
          currentContextScopes: input.currentContextScopes,
          authenticatedPrincipal: effectivePrincipal,
          mode: "full",
          disclosure: "chunk",
          includeRecall: true,
        });
        const xray = xrayResponse.snapshotFound === true
          ? xrayResponse.snapshot ?? null
          : null;
        const recall = xrayResponse.recall ?? {
          query: input.query,
          namespace: input.namespace ?? xray?.namespace ?? "global",
          context: "",
          count: 0,
          memoryIds: [],
          results: [],
          fallbackUsed: false,
          sourcesUsed: [],
          disclosure: "chunk",
        };
        const actionRequest = buildChatGptMemoryInspectorActionRequest(
          input,
          recall,
          xray,
        );
        const actionConfidence = await this.service.actionConfidence(actionRequest);
        return buildChatGptMemoryInspectorResult(
          input,
          recall,
          xray,
          actionConfidence,
        );
      }
      case "engram.day_summary":
        return this.service.daySummary({
          memories: typeof args.memories === "string" ? args.memories : "",
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
        });
      case "engram.capsule_export": {
        const body: CapsuleExportRequest = parseMcpRequest("capsuleExport", args);
        return this.service.capsuleExport({
          name: body.name,
          namespace: body.namespace,
          principal: effectivePrincipal,
          since: body.since,
          includeKinds: body.includeKinds,
          peerIds: body.peerIds,
          includeTranscripts: body.includeTranscripts,
          encrypt: body.encrypt,
        });
      }
      case "engram.capsule_import": {
        const body: CapsuleImportRequest = parseMcpRequest("capsuleImport", args);
        return this.service.capsuleImport({
          archivePath: expandTildePath(body.archivePath),
          namespace: body.namespace,
          principal: effectivePrincipal,
          mode: body.mode,
        });
      }
      case "engram.capsule_list": {
        const body: CapsuleListRequest = parseMcpRequest("capsuleList", args);
        return this.service.capsuleList({
          namespace: body.namespace,
          principal: effectivePrincipal,
        });
      }
      case "engram.memory_governance_run":
        return this.service.governanceRun({
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          mode: args.mode === "apply" ? "apply" : "shadow",
          recentDays: typeof args.recentDays === "number" && Number.isFinite(args.recentDays) ? args.recentDays : undefined,
          maxMemories: typeof args.maxMemories === "number" && Number.isFinite(args.maxMemories) ? args.maxMemories : undefined,
          batchSize: typeof args.batchSize === "number" && Number.isFinite(args.batchSize) ? args.batchSize : undefined,
          authenticatedPrincipal: effectivePrincipal,
        }, effectivePrincipal);
      case "engram.procedure_mining_run":
        return this.service.procedureMiningRun(
          {
            namespace: typeof args.namespace === "string" ? args.namespace : undefined,
            authenticatedPrincipal: effectivePrincipal,
          },
          effectivePrincipal,
        );
      case "engram.pattern_reinforcement_run":
        return this.service.patternReinforcementRun(
          {
            namespace: typeof args.namespace === "string" ? args.namespace : undefined,
            authenticatedPrincipal: effectivePrincipal,
            force: args.force === true,
          },
          effectivePrincipal,
        );
      case "remnic.procedural_stats":
      case "engram.procedural_stats":
        return this.service.procedureStats(
          {
            namespace:
              typeof args.namespace === "string" ? args.namespace : undefined,
          },
          effectivePrincipal,
        );
      case "engram.memory_get":
        return this.service.memoryGet(
          typeof args.memoryId === "string" ? args.memoryId : "",
          typeof args.namespace === "string" ? args.namespace : undefined,
          effectivePrincipal,
        );
      case "engram.memory_timeline": {
        const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : 200;
        return this.service.memoryTimeline(
          typeof args.memoryId === "string" ? args.memoryId : "",
          typeof args.namespace === "string" ? args.namespace : undefined,
          limit,
          effectivePrincipal,
        );
      }
      case "engram.memory_store": {
        const body: MemoryStoreRequest = parseMcpRequest("memoryStore", args);
        return this.service.memoryStore({
          schemaVersion: body.schemaVersion,
          idempotencyKey: body.idempotencyKey,
          dryRun: body.dryRun,
          sessionKey: body.sessionKey,
          authenticatedPrincipal: effectivePrincipal,
          content: body.content,
          category: body.category,
          confidence: body.confidence,
          namespace: body.namespace,
          tags: body.tags,
          entityRef: body.entityRef,
          ttl: body.ttl,
          sourceReason: body.sourceReason,
        });
      }
      case "engram.suggestion_submit": {
        const body: SuggestionSubmitRequest = parseMcpRequest("suggestionSubmit", args);
        return this.service.suggestionSubmit({
          schemaVersion: body.schemaVersion,
          idempotencyKey: body.idempotencyKey,
          dryRun: body.dryRun,
          sessionKey: body.sessionKey,
          authenticatedPrincipal: effectivePrincipal,
          content: body.content,
          category: body.category,
          confidence: body.confidence,
          namespace: body.namespace,
          tags: body.tags,
          entityRef: body.entityRef,
          ttl: body.ttl,
          sourceReason: body.sourceReason,
        });
      }
      case "engram.entity_get":
        return this.service.entityGet(
          typeof args.name === "string" ? args.name : "",
          typeof args.namespace === "string" ? args.namespace : undefined,
        );
      case "engram.review_queue_list":
        return this.service.reviewQueue(
          typeof args.runId === "string" ? args.runId : undefined,
          typeof args.namespace === "string" ? args.namespace : undefined,
          effectivePrincipal,
        );
      case "engram.observe": {
        const body = parseMcpRequest("observe", args);
        return this.service.observe({
          sessionKey: body.sessionKey,
          messages: body.messages.map((message) => ({
            role: message.role,
            content: message.content,
            parts: message.parts ?? undefined,
            rawContent: message.rawContent ?? undefined,
            sourceFormat: message.sourceFormat ?? undefined,
          })),
          namespace: body.namespace,
          authenticatedPrincipal: effectivePrincipal,
          skipExtraction: body.skipExtraction === true,
          cwd: body.cwd,
          projectTag: body.projectTag,
        });
      }
      case "engram.lcm_search":
        return this.service.lcmSearch({
          query: typeof args.query === "string" ? args.query : "",
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : undefined,
          sessionPrefix: typeof args.sessionPrefix === "string" ? args.sessionPrefix : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          limit: typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : undefined,
          authenticatedPrincipal: effectivePrincipal,
        });
      case "engram.lcm_compaction_flush": {
        const body = parseMcpRequest("lcmCompactionFlush", args);
        return this.service.lcmCompactionFlush({
          sessionKey: body.sessionKey,
          namespace: body.namespace,
          authenticatedPrincipal: effectivePrincipal,
        });
      }
      case "engram.lcm_compaction_record": {
        const body = parseMcpRequest("lcmCompactionRecord", args);
        return this.service.lcmCompactionRecord({
          sessionKey: body.sessionKey,
          namespace: body.namespace,
          tokensBefore: body.tokensBefore,
          tokensAfter: body.tokensAfter,
          authenticatedPrincipal: effectivePrincipal,
        });
      }
      // ── Continuity / Identity tools ───────────────────────────────────
      case "engram.continuity_audit_generate":
        return this.service.continuityAuditGenerate({
          period: args.period === "monthly" ? "monthly" : args.period === "weekly" ? "weekly" : undefined,
          key: typeof args.key === "string" ? args.key : undefined,
        });
      case "engram.continuity_incident_open":
        return this.service.continuityIncidentOpen({
          symptom: typeof args.symptom === "string" ? args.symptom : "",
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          principal: effectivePrincipal,
          triggerWindow: typeof args.triggerWindow === "string" ? args.triggerWindow : undefined,
          suspectedCause: typeof args.suspectedCause === "string" ? args.suspectedCause : undefined,
        });
      case "engram.continuity_incident_close":
        return this.service.continuityIncidentClose({
          id: typeof args.id === "string" ? args.id : "",
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          principal: effectivePrincipal,
          fixApplied: typeof args.fixApplied === "string" ? args.fixApplied : "",
          verificationResult: typeof args.verificationResult === "string" ? args.verificationResult : "",
          preventiveRule: typeof args.preventiveRule === "string" ? args.preventiveRule : undefined,
        });
      case "engram.continuity_incident_list":
        return this.service.continuityIncidentList({
          state: args.state === "closed" ? "closed" : args.state === "all" ? "all" : args.state === "open" ? "open" : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          principal: effectivePrincipal,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        });
      case "engram.continuity_loop_add_or_update":
        return this.service.continuityLoopAddOrUpdate({
          id: typeof args.id === "string" ? args.id : "",
          cadence: (args.cadence as "daily" | "weekly" | "monthly" | "quarterly") ?? "weekly",
          purpose: typeof args.purpose === "string" ? args.purpose : "",
          status: (args.status as "active" | "paused" | "retired") ?? "active",
          killCondition: typeof args.killCondition === "string" ? args.killCondition : "",
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          principal: effectivePrincipal,
          lastReviewed: typeof args.lastReviewed === "string" ? args.lastReviewed : undefined,
          notes: typeof args.notes === "string" ? args.notes : undefined,
        });
      case "engram.continuity_loop_review":
        return this.service.continuityLoopReview({
          id: typeof args.id === "string" ? args.id : "",
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          principal: effectivePrincipal,
          status: args.status === "active" || args.status === "paused" || args.status === "retired" ? args.status : undefined,
          notes: typeof args.notes === "string" ? args.notes : undefined,
          reviewedAt: typeof args.reviewedAt === "string" ? args.reviewedAt : undefined,
        });
      case "engram.identity_anchor_get":
        return this.service.identityAnchorGet({
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          principal: effectivePrincipal,
        });
      case "engram.identity_anchor_update":
        return this.service.identityAnchorUpdate({
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          principal: effectivePrincipal,
          identityTraits: typeof args.identityTraits === "string" ? args.identityTraits : undefined,
          communicationPreferences: typeof args.communicationPreferences === "string" ? args.communicationPreferences : undefined,
          operatingPrinciples: typeof args.operatingPrinciples === "string" ? args.operatingPrinciples : undefined,
          continuityNotes: typeof args.continuityNotes === "string" ? args.continuityNotes : undefined,
        });
      case "engram.memory_identity":
        return this.service.memoryIdentity({
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          principal: effectivePrincipal,
        });
      // ── Work Layer tools ──────────────────────────────────────────────
      case "engram.work_task":
        return this.service.workTask({
          action: (args.action as any) ?? "list",
          id: typeof args.id === "string" ? args.id : undefined,
          title: typeof args.title === "string" ? args.title : undefined,
          description: typeof args.description === "string" ? args.description : undefined,
          status: typeof args.status === "string" ? args.status : undefined,
          priority: typeof args.priority === "string" ? args.priority : undefined,
          owner: typeof args.owner === "string" ? args.owner : undefined,
          assignee: typeof args.assignee === "string" ? args.assignee : undefined,
          projectId: typeof args.projectId === "string" ? args.projectId : undefined,
          tags: Array.isArray(args.tags) ? args.tags.filter((x: unknown): x is string => typeof x === "string") : undefined,
          dueAt: typeof args.dueAt === "string" ? args.dueAt : undefined,
        });
      case "engram.work_project":
        return this.service.workProject({
          action: (args.action as any) ?? "list",
          id: typeof args.id === "string" ? args.id : undefined,
          name: typeof args.name === "string" ? args.name : undefined,
          description: typeof args.description === "string" ? args.description : undefined,
          status: typeof args.status === "string" ? args.status : undefined,
          owner: typeof args.owner === "string" ? args.owner : undefined,
          tags: Array.isArray(args.tags) ? args.tags.filter((x: unknown): x is string => typeof x === "string") : undefined,
          taskId: typeof args.taskId === "string" ? args.taskId : undefined,
          projectId: typeof args.projectId === "string" ? args.projectId : undefined,
        });
      case "engram.work_board":
        return this.service.workBoard({
          action: (args.action as any) ?? "export_markdown",
          projectId: typeof args.projectId === "string" ? args.projectId : undefined,
          snapshotJson: typeof args.snapshotJson === "string" ? args.snapshotJson : undefined,
          linkToMemory: args.linkToMemory === true,
        });
      // ── Shared Context / Compounding tools ─────────────────────────
      case "engram.shared_context_write_output":
        return this.service.sharedContextWriteOutput({
          agentId: typeof args.agentId === "string" ? args.agentId : "",
          title: typeof args.title === "string" ? args.title : "",
          content: typeof args.content === "string" ? args.content : "",
        });
      case "engram.shared_feedback_record":
        return this.service.sharedFeedbackRecord({
          agent: typeof args.agent === "string" ? args.agent : "",
          decision: (args.decision as any) ?? "approved",
          reason: typeof args.reason === "string" ? args.reason : "",
          date: typeof args.date === "string" ? args.date : undefined,
          learning: typeof args.learning === "string" ? args.learning : undefined,
          outcome: typeof args.outcome === "string" ? args.outcome : undefined,
          severity: args.severity === "low" || args.severity === "medium" || args.severity === "high" ? args.severity : undefined,
          confidence: typeof args.confidence === "number" ? args.confidence : undefined,
          workflow: typeof args.workflow === "string" ? args.workflow : undefined,
          tags: Array.isArray(args.tags) ? args.tags.filter((x: unknown): x is string => typeof x === "string") : undefined,
          evidenceWindowStart: typeof args.evidenceWindowStart === "string" ? args.evidenceWindowStart : undefined,
          evidenceWindowEnd: typeof args.evidenceWindowEnd === "string" ? args.evidenceWindowEnd : undefined,
          refs: Array.isArray(args.refs) ? args.refs.filter((x: unknown): x is string => typeof x === "string") : undefined,
        });
      case "engram.shared_priorities_append":
        return this.service.sharedPrioritiesAppend({
          agentId: typeof args.agentId === "string" ? args.agentId : "",
          text: typeof args.text === "string" ? args.text : "",
        });
      case "engram.shared_context_cross_signals_run":
        return this.service.sharedContextCrossSignalsRun({
          date: typeof args.date === "string" ? args.date : undefined,
        });
      case "engram.shared_context_curate_daily":
        return this.service.sharedContextCurateDaily({
          date: typeof args.date === "string" ? args.date : undefined,
        });
      case "engram.compounding_weekly_synthesize":
        return this.service.compoundingWeeklySynthesize({
          weekId: typeof args.weekId === "string" ? args.weekId : undefined,
        });
      case "engram.compounding_promote_candidate":
        return this.service.compoundingPromoteCandidate({
          weekId: typeof args.weekId === "string" ? args.weekId : "",
          candidateId: typeof args.candidateId === "string" ? args.candidateId : "",
          dryRun: args.dryRun === true,
        });
      // ── Compression Guidelines tools ───────────────────────────────────
      case "engram.compression_guidelines_optimize":
        return this.service.compressionGuidelinesOptimize({
          dryRun: args.dryRun === true,
          eventLimit: typeof args.eventLimit === "number" ? args.eventLimit : undefined,
        });
      case "engram.compression_guidelines_activate":
        return this.service.compressionGuidelinesActivate({
          expectedContentHash: typeof args.expectedContentHash === "string" ? args.expectedContentHash : undefined,
          expectedGuidelineVersion: typeof args.expectedGuidelineVersion === "number" ? args.expectedGuidelineVersion : undefined,
        });
      // ── Memory search & debug tools ──────────────────────────────────
      case "engram.memory_search":
        return this.service.memorySearch({
          query: typeof args.query === "string" ? args.query : "",
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          maxResults: typeof args.maxResults === "number" && Number.isFinite(args.maxResults) ? args.maxResults : undefined,
          collection: typeof args.collection === "string" ? args.collection : undefined,
          principal: effectivePrincipal,
        });
      case "engram.memory_profile":
        return this.service.memoryProfile(
          typeof args.namespace === "string" ? args.namespace : undefined,
          effectivePrincipal,
        );
      case "engram.memory_entities_list":
        return this.service.memoryEntitiesList(
          typeof args.namespace === "string" ? args.namespace : undefined,
          effectivePrincipal,
        );
      case "engram.memory_questions":
        return this.service.memoryQuestions(
          typeof args.namespace === "string" ? args.namespace : undefined,
          effectivePrincipal,
        );
      case "engram.memory_last_recall":
        return this.service.lastRecallSnapshot(
          typeof args.sessionKey === "string" ? args.sessionKey : undefined,
        );
      case "engram.memory_intent_debug":
        return this.service.intentDebug(
          typeof args.namespace === "string" ? args.namespace : undefined,
        );
      case "engram.memory_qmd_debug":
        return this.service.qmdDebug(
          typeof args.namespace === "string" ? args.namespace : undefined,
        );
      case "engram.memory_graph_explain":
        return this.service.graphExplainLastRecall(
          typeof args.namespace === "string" ? args.namespace : undefined,
        );
      case "engram.graph_snapshot": {
        // Validate the typed inputs at the boundary — silently coercing
        // unknown shapes (e.g. `limit: "200"`) would defeat the access
        // service's tighter parser (CLAUDE.md rule 28 + 51).
        if (args.limit !== undefined && typeof args.limit !== "number") {
          throw new Error("engram.graph_snapshot: limit must be a number");
        }
        if (args.since !== undefined && typeof args.since !== "string") {
          throw new Error("engram.graph_snapshot: since must be a string");
        }
        if (
          args.focusNodeId !== undefined
          && typeof args.focusNodeId !== "string"
        ) {
          throw new Error("engram.graph_snapshot: focusNodeId must be a string");
        }
        let categories: string[] | undefined;
        if (args.categories !== undefined) {
          if (!Array.isArray(args.categories)) {
            throw new Error(
              "engram.graph_snapshot: categories must be an array of strings",
            );
          }
          categories = args.categories.map((value, index) => {
            if (typeof value !== "string") {
              throw new Error(
                `engram.graph_snapshot: categories[${index}] must be a string`,
              );
            }
            return value;
          });
        }
        return this.service.graphSnapshot(
          {
            namespace: typeof args.namespace === "string" ? args.namespace : undefined,
            limit: typeof args.limit === "number" ? args.limit : undefined,
            since: typeof args.since === "string" ? args.since : undefined,
            focusNodeId: typeof args.focusNodeId === "string"
              ? args.focusNodeId
              : undefined,
            ...(categories !== undefined ? { categories } : {}),
          },
          effectivePrincipal,
        );
      }
      case "engram.memory_feedback":
        return this.service.memoryFeedback({
          memoryId: typeof args.memoryId === "string" ? args.memoryId : "",
          vote: args.vote === "down" ? "down" : "up",
          note: typeof args.note === "string" ? args.note : undefined,
        });
      case "engram.memory_promote":
        return this.service.memoryPromote({
          memoryId: typeof args.memoryId === "string" ? args.memoryId : "",
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          principal: effectivePrincipal,
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : undefined,
        });
      case "engram.memory_outcome": {
        // Validate `outcome` up front — silently defaulting unknown values
        // to "success" or "failure" would poison the counters a downstream
        // recall filter (PR 4) will trust.
        const outcome = args.outcome;
        if (outcome !== "success" && outcome !== "failure") {
          throw new Error(
            `engram.memory_outcome: outcome must be "success" or "failure"; got ${JSON.stringify(outcome)}`,
          );
        }
        return this.service.memoryOutcome({
          memoryId: typeof args.memoryId === "string" ? args.memoryId : "",
          outcome,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          principal: effectivePrincipal,
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : undefined,
          timestamp: typeof args.timestamp === "string" ? args.timestamp : undefined,
        });
      }
      case "engram.memory_action_apply":
        return this.service.memoryActionApply({
          action: typeof args.action === "string" ? args.action : "",
          outcome: typeof args.outcome === "string" ? args.outcome : undefined,
          reason: typeof args.reason === "string" ? args.reason : undefined,
          memoryId: typeof args.memoryId === "string" ? args.memoryId : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          principal: effectivePrincipal,
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : undefined,
          content: typeof args.content === "string" ? args.content : undefined,
          category: typeof args.category === "string" ? args.category : undefined,
          linkTargetId: typeof args.linkTargetId === "string" ? args.linkTargetId : undefined,
          linkType: typeof args.linkType === "string" ? args.linkType : undefined,
          linkStrength: typeof args.linkStrength === "number" ? args.linkStrength : undefined,
          artifactType: typeof args.artifactType === "string" ? args.artifactType : undefined,
          execute: typeof args.execute === "boolean" ? args.execute : undefined,
          sourcePrompt: typeof args.sourcePrompt === "string" ? args.sourcePrompt : undefined,
          dryRun: args.dryRun === true,
        });
      case "engram.context_checkpoint":
        return this.service.contextCheckpoint({
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : "",
          context: typeof args.context === "string" ? args.context : "",
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          principal: effectivePrincipal,
        });
      // ── Daily Context Briefing (#370) ───────────────────────────────────
      case "engram.briefing": {
        // Validate the format value upfront — unsupported values (e.g. "xml")
        // must be rejected with a descriptive error rather than silently
        // falling back to the default format.
        const rawFormat = typeof args.format === "string" ? args.format : undefined;
        const formatErr = validateBriefingFormat(rawFormat);
        if (formatErr) throw new Error(formatErr);
        return this.service.briefing({
          since: typeof args.since === "string" ? args.since : undefined,
          focus: typeof args.focus === "string" ? args.focus : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          format: rawFormat as "json" | "markdown" | undefined,
          maxFollowups:
            typeof args.maxFollowups === "number" ? args.maxFollowups : undefined,
          principal: effectivePrincipal,
        });
      }
      // ── Contradiction Review (issue #520) ──────────────────────────────────
      case "engram.review_list":
      case "remnic.review_list": {
        const {
          isDefaultReviewNamespace,
          listPairs,
        } = await import("./contradiction/contradiction-review.js");
        const VALID_REVIEW_FILTERS = new Set(["all", "unresolved", "contradicts", "independent", "duplicates", "needs-user"]);
        const rawFilter = typeof args.filter === "string" ? args.filter : "unresolved";
        if (!VALID_REVIEW_FILTERS.has(rawFilter)) {
          throw new Error(`Invalid filter '${rawFilter}'. Valid: ${[...VALID_REVIEW_FILTERS].join(", ")}`);
        }
        const filter = rawFilter as "all" | "unresolved" | "contradicts" | "independent" | "duplicates" | "needs-user";
        const ns = typeof args.namespace === "string" ? args.namespace : undefined;
        const limit = typeof args.limit === "number" ? args.limit : 50;
        const resolved = await this.service.getReadableStorageForNamespace(ns, effectivePrincipal);
        const reviewNamespace = this.service.configRef.namespacesEnabled ? resolved.namespace : undefined;
        const includeUnscopedForNamespace = Boolean(
          reviewNamespace && isDefaultReviewNamespace(this.service.configRef.defaultNamespace, ns, reviewNamespace),
        );
        return listPairs(this.service.memoryDir, {
          filter,
          namespace: reviewNamespace,
          includeUnscopedForNamespace,
          limit,
        });
      }
      case "engram.review_resolve":
      case "remnic.review_resolve": {
        const pairId = typeof args.pairId === "string" ? args.pairId : "";
        const verb = typeof args.verb === "string" ? args.verb : "";
        if (!pairId) throw new Error("pairId is required");
        if (!verb) throw new Error("verb is required");
        const { isValidResolutionVerb } = await import("./contradiction/resolution.js");
        if (!isValidResolutionVerb(verb)) throw new Error(`Invalid verb: ${verb}. Must be one of: keep-a, keep-b, merge, both-valid, needs-more-context`);
        const { executeResolution } = await import("./contradiction/resolution.js");
        return executeResolution(this.service.memoryDir, this.service.storageRef, pairId, verb, {
          mergedMemoryId: typeof args.mergedMemoryId === "string" ? args.mergedMemoryId : undefined,
          mergedContent: typeof args.mergedContent === "string" ? args.mergedContent : undefined,
          storageForNamespace: async (namespace) => {
            const resolved = await this.service.getWritableStorageForNamespace(namespace, effectivePrincipal);
            return resolved.storage;
          },
        });
      }
      case "engram.contradiction_scan_run":
      case "remnic.contradiction_scan_run": {
        const { runContradictionScan } = await import("./contradiction/contradiction-scan.js");
        return runContradictionScan({
          storage: this.service.storageRef,
          config: this.service.configRef,
          memoryDir: this.service.memoryDir,
          embeddingLookupFactory: this.service.embeddingLookupFactoryRef,
          storageForNamespace: (namespace) =>
            this.service.getWritableStorageForNamespace(namespace, effectivePrincipal),
          localLlm: this.service.localLlmRef,
          fallbackLlm: this.service.fallbackLlmRef,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
        });
      }
      case "engram.memory_summarize_hourly":
      case "remnic.memory_summarize_hourly":
        return this.service.memorySummarizeHourly();
      case "engram.conversation_index_update":
      case "remnic.conversation_index_update": {
        if ("sessionKey" in args && args.sessionKey !== undefined && typeof args.sessionKey !== "string") {
          throw new Error("sessionKey must be a string when provided");
        }
        const sessionKey = typeof args.sessionKey === "string" ? args.sessionKey : undefined;
        return this.service.conversationIndexUpdate({
          sessionKey,
          hours: typeof args.hours === "number" && Number.isFinite(args.hours) ? args.hours : undefined,
          embed: typeof args.embed === "boolean" ? args.embed : undefined,
        });
      }
      case "engram.profiling_report":
      case "remnic.profiling_report": {
        if ("format" in args && args.format !== undefined && typeof args.format !== "string") {
          throw new EngramAccessInputError("format must be a string when provided");
        }
        if ("limit" in args && args.limit !== undefined && typeof args.limit !== "number") {
          throw new EngramAccessInputError("limit must be a number when provided");
        }
        return this.service.profilingReport({
          format: typeof args.format === "string" ? args.format : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        });
      }
      case "engram.graph_edge_decay_run":
      case "remnic.graph_edge_decay_run": {
        // Issue #681 PR 2/3 — gated by config; tool always callable, but
        // the job is a no-op when disabled (and the response indicates it).
        const cfg = this.service.configRef;
        if (!cfg.graphEdgeDecayEnabled) {
          return {
            ranAt: new Date().toISOString(),
            disabled: true,
            reason: "graphEdgeDecayEnabled is false",
          };
        }
        const { runGraphEdgeDecayMaintenanceAcrossNamespaces } = await import(
          "./maintenance/graph-edge-decay.js"
        );
        const dryRun = args.dryRun === true;
        // Codex P2 / gotcha #42: enumerate every namespace storage root
        // so non-default namespaces (memoryDir/namespaces/<ns>) also get
        // confidence decay applied. Returns a list of per-namespace
        // results — each with telemetry or an error string.
        const results = await runGraphEdgeDecayMaintenanceAcrossNamespaces(
          this.service.memoryDir,
          {
            windowMs: cfg.graphEdgeDecayWindowMs,
            perWindow: cfg.graphEdgeDecayPerWindow,
            floor: cfg.graphEdgeDecayFloor,
            visibilityThreshold: cfg.graphEdgeDecayVisibilityThreshold,
            dryRun,
            namespacesEnabled: cfg.namespacesEnabled === true,
            defaultNamespace: cfg.defaultNamespace,
          },
        );
        return { results };
      }
      case "engram.live_connectors_run":
      case "remnic.live_connectors_run":
        return this.service.liveConnectorsRun(
          {
            authenticatedPrincipal: effectivePrincipal,
            force: args.force === true,
          },
          effectivePrincipal,
        );
      // ── Peer Registry dispatchers (issue #679 PR 4/5) ─────────────────
      case "engram.peer_list":
      case "remnic.peer_list":
        return this.service.peerList();
      case "engram.peer_get":
      case "remnic.peer_get": {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("engram.peer_get: id is required");
        return this.service.peerGet(id);
      }
      case "engram.peer_set":
      case "remnic.peer_set": {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("engram.peer_set: id is required");
        // Codex P2 (PR #756 round 2): mirror the HTTP surface — reject
        // non-string `kind`/`displayName`/`notes` rather than silently
        // coercing to `undefined` and letting peerSet fall back to its
        // "human" default. Symmetry across access surfaces (CLAUDE.md
        // rule 39) and no-silent-defaults on bad input (rule 51).
        if (args.kind !== undefined && typeof args.kind !== "string") {
          throw new Error("engram.peer_set: kind must be a string when provided");
        }
        if (args.displayName !== undefined && typeof args.displayName !== "string") {
          throw new Error("engram.peer_set: displayName must be a string when provided");
        }
        if (args.notes !== undefined && typeof args.notes !== "string") {
          throw new Error("engram.peer_set: notes must be a string when provided");
        }
        return this.service.peerSet({
          id,
          kind: typeof args.kind === "string" ? args.kind : undefined,
          displayName: typeof args.displayName === "string" ? args.displayName : undefined,
          notes: typeof args.notes === "string" ? args.notes : undefined,
        });
      }
      case "engram.peer_delete":
      case "remnic.peer_delete": {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("engram.peer_delete: id is required");
        return this.service.peerDelete(id);
      }
      case "engram.peer_profile_get":
      case "remnic.peer_profile_get": {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("engram.peer_profile_get: id is required");
        return this.service.peerProfileGet(id);
      }
      case "engram.peer_forget":
      case "remnic.peer_forget": {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("engram.peer_forget: id is required");
        const confirm = typeof args.confirm === "string" ? args.confirm : "";
        if (confirm !== "yes") {
          throw new Error(
            "engram.peer_forget: confirm must be 'yes' to prevent accidental data loss",
          );
        }
        return this.service.peerForget(id, { confirm: "yes" });
      }
      // ── Operator Console state (issue #688 PR 2/3) ──────────────────────────
      case "engram.console_state":
      case "remnic.console_state":
        return this.service.consoleState(
          typeof args.namespace === "string" ? args.namespace : undefined,
          effectivePrincipal,
        );
      // ── Dreams telemetry (issue #678 PR 3+4) ──────────────────────────────
      case "engram.dreams_status":
      case "remnic.dreams_status": {
        const { normalizeDreamsStatusWindowHours } = await import("./maintenance/dreams-ledger.js");
        let windowHours = 24;
        try {
          windowHours = normalizeDreamsStatusWindowHours(args.windowHours);
        } catch {
          throw new Error(
            `engram.dreams_status: windowHours must be a positive integer (e.g. 24). Got: ${String(args.windowHours)}`,
          );
        }
        if (
          "namespace" in args &&
          args.namespace !== undefined &&
          typeof args.namespace !== "string"
        ) {
          throw new Error("engram.dreams_status: namespace must be a string when provided");
        }
        const namespace =
          typeof args.namespace === "string" ? args.namespace : undefined;
        return this.service.dreamsStatus({
          windowHours,
          namespace,
          principal: effectivePrincipal,
        });
      }
      case "engram.dreams_run":
      case "remnic.dreams_run": {
        const VALID_PHASES = ["lightSleep", "rem", "deepSleep"];
        const phase = typeof args.phase === "string" ? args.phase : "";
        if (!phase || !VALID_PHASES.includes(phase)) {
          throw new Error(
            `engram.dreams_run: phase is required and must be one of: ${VALID_PHASES.join(", ")}`,
          );
        }
        if (
          "dryRun" in args &&
          args.dryRun !== undefined &&
          typeof args.dryRun !== "boolean"
        ) {
          throw new Error("engram.dreams_run: dryRun must be a boolean when provided");
        }
        if (
          "namespace" in args &&
          args.namespace !== undefined &&
          typeof args.namespace !== "string"
        ) {
          throw new Error("engram.dreams_run: namespace must be a string when provided");
        }
        const namespace =
          typeof args.namespace === "string" ? args.namespace : undefined;
        const dryRun = args.dryRun === true;
        return this.service.dreamsRun({
          phase: phase as import("./types.js").DreamsPhase,
          dryRun,
          namespace,
          authenticatedPrincipal: effectivePrincipal,
        });
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }
}
