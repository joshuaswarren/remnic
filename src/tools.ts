import path from "node:path";
import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { Orchestrator } from "@remnic/core/orchestrator";
import type {
  ContinuityImprovementLoop,
  MemoryActionEligibilityContext,
  MemoryActionEligibilitySource,
  MemoryActionType,
  MemoryCategory,
  MemoryFile,
} from "./types.js";
import { indexMemory, indexesExist } from "./temporal-index.js";
import {
  persistExplicitCapture,
  queueExplicitCaptureForReview,
  validateExplicitCaptureInput,
} from "./explicit-capture.js";
import { log } from "./logger.js";
import { WorkStorage } from "@remnic/core/work/storage";
import { exportWorkBoardMarkdown, exportWorkBoardSnapshot, importWorkBoardSnapshot } from "@remnic/core/work/board";
import { wrapWorkLayerContext } from "@remnic/core/work/boundary";
import { VALID_MEMORY_CATEGORIES } from "./config.js";
import { formatProfileTraceAscii } from "./profiling.js";
import { runMemoryGovernance } from "@remnic/core/maintenance/memory-governance";

interface ToolApi {
  registerTool(
    spec: {
      name: string;
      label: string;
      description: string;
      parameters: unknown;
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
      ) => Promise<{
        content: Array<{ type: string; text: string }>;
        details: undefined;
      }>;
    },
    options: { name: string },
  ): void;
}

function toolResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function toolJsonResult(value: unknown, options?: { linkToMemory?: boolean }) {
  const payload = JSON.stringify(value, null, 2);
  return toolResult(wrapWorkLayerContext(payload, { linkToMemory: options?.linkToMemory === true }));
}

function workLayerTextResult(text: string, options?: { linkToMemory?: boolean }) {
  return toolResult(wrapWorkLayerContext(text, { linkToMemory: options?.linkToMemory === true }));
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeToolNamespace(value: unknown): string | undefined {
  return asNonEmptyString(value);
}

function clampUnitInterval(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeProfilingReportLimit(value: unknown): number {
  if (value === undefined) return 5;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return 5;
  }
  return Math.min(Math.max(value, 1), 20);
}

function normalizeMemoryActionEligibilitySource(value: unknown): MemoryActionEligibilitySource {
  switch (value) {
    case "extraction":
    case "consolidation":
    case "replay":
    case "manual":
      return value;
    default:
      return "unknown";
  }
}

function deriveMemoryActionPolicyEligibility(
  memory: Pick<MemoryFile, "frontmatter"> | null | undefined,
): MemoryActionEligibilityContext | undefined {
  if (!memory) return undefined;
  const frontmatter = memory.frontmatter;
  return {
    confidence: clampUnitInterval(frontmatter.confidence, 0),
    lifecycleState:
      frontmatter.status === "archived" ? "archived" : frontmatter.lifecycleState ?? "candidate",
    importance: clampUnitInterval(frontmatter.importance?.score, 0),
    source: normalizeMemoryActionEligibilitySource(frontmatter.source),
  };
}

async function readReferencedMemoryForPolicyEligibility(
  storage: {
    getMemoryById?: (id: string) => Promise<MemoryFile | null>;
    readAllMemories?: () => Promise<MemoryFile[]>;
    readArchivedMemories?: () => Promise<MemoryFile[]>;
  },
  memoryId: string | undefined,
): Promise<MemoryFile | null | undefined> {
  if (!memoryId) return undefined;

  if (typeof storage.getMemoryById === "function") {
    const direct = await storage.getMemoryById(memoryId);
    if (direct) return direct;
  }

  if (typeof storage.readAllMemories === "function") {
    const active = (await storage.readAllMemories()).find((memory) => memory.frontmatter.id === memoryId);
    if (active) return active;
  }

  if (typeof storage.readArchivedMemories === "function") {
    const archived = (await storage.readArchivedMemories()).find((memory) => memory.frontmatter.id === memoryId);
    if (archived) return archived;
  }

  return undefined;
}

const WORK_TASK_STATUSES = new Set(["todo", "in_progress", "blocked", "done", "cancelled"]);
const WORK_TASK_PRIORITIES = new Set(["low", "medium", "high"]);
const WORK_PROJECT_STATUSES = new Set(["active", "on_hold", "completed", "archived"]);
type TaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled";
type TaskPriority = "low" | "medium" | "high";
type ProjectStatus = "active" | "on_hold" | "completed" | "archived";
function asTaskStatus(value: unknown): "todo" | "in_progress" | "blocked" | "done" | "cancelled" | undefined {
  const normalized = asNonEmptyString(value);
  if (!normalized || !WORK_TASK_STATUSES.has(normalized)) return undefined;
  return normalized as "todo" | "in_progress" | "blocked" | "done" | "cancelled";
}

function asTaskPriority(value: unknown): "low" | "medium" | "high" | undefined {
  const normalized = asNonEmptyString(value);
  if (!normalized || !WORK_TASK_PRIORITIES.has(normalized)) return undefined;
  return normalized as "low" | "medium" | "high";
}

function asProjectStatus(value: unknown): "active" | "on_hold" | "completed" | "archived" | undefined {
  const normalized = asNonEmptyString(value);
  if (!normalized || !WORK_PROJECT_STATUSES.has(normalized)) return undefined;
  return normalized as "active" | "on_hold" | "completed" | "archived";
}

function parseEnumParam<T extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string>,
): { ok: true; value: T | undefined } | { ok: false; message: string } {
  if (!Object.prototype.hasOwnProperty.call(params, key) || params[key] === undefined) {
    return { ok: true, value: undefined };
  }
  const normalized = asNonEmptyString(params[key]);
  if (!normalized || !allowed.has(normalized)) {
    return { ok: false, message: `invalid \`${key}\`: expected one of ${[...allowed].join(", ")}.` };
  }
  return { ok: true, value: normalized as T };
}

function asNullablePatchString(params: Record<string, unknown>, key: string): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(params, key)) return undefined;
  const value = params[key];
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const IDENTITY_ANCHOR_TITLE = "# Identity Continuity Anchor";
const IDENTITY_ANCHOR_SECTION_ORDER = [
  "Identity Traits",
  "Communication Preferences",
  "Operating Principles",
  "Continuity Notes",
] as const;

type IdentityAnchorSectionName = typeof IDENTITY_ANCHOR_SECTION_ORDER[number];
type IdentityAnchorSections = Record<IdentityAnchorSectionName, string>;

function parseMarkdownSections(raw: string): {
  header: string;
  sections: Map<string, string>;
  order: string[];
} {
  const lines = raw.replace(/\r/g, "").split("\n");
  const headerLines: string[] = [];
  const sectionLines = new Map<string, string[]>();
  const order: string[] = [];
  let currentSection: string | null = null;

  for (const line of lines) {
    const sectionMatch = line.match(/^##\s+(.+?)\s*$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      if (!sectionLines.has(currentSection)) {
        sectionLines.set(currentSection, []);
        order.push(currentSection);
      }
      continue;
    }
    if (!currentSection) {
      headerLines.push(line);
      continue;
    }
    sectionLines.get(currentSection)?.push(line);
  }

  const sections = new Map<string, string>();
  for (const [name, contentLines] of sectionLines.entries()) {
    sections.set(name, contentLines.join("\n").trim());
  }

  return {
    header: headerLines.join("\n").trim(),
    sections,
    order,
  };
}

function mergeAnchorSection(existing: string | undefined, incoming: string | undefined): string {
  const next = incoming?.trim();
  const prev = existing?.trim() === "- (empty)" ? "" : existing?.trim();
  if (!next) return prev ?? "";
  if (!prev) return next;
  if (prev.includes(next)) return prev;
  if (next.includes(prev)) return next;
  return `${prev}\n\n${next}`;
}

function mergeIdentityAnchor(
  existingRaw: string | null,
  updates: Partial<IdentityAnchorSections>,
): string {
  const parsed = parseMarkdownSections(existingRaw ?? "");
  const header = parsed.header.length > 0 ? parsed.header : IDENTITY_ANCHOR_TITLE;
  const sections = new Map(parsed.sections);

  for (const sectionName of IDENTITY_ANCHOR_SECTION_ORDER) {
    const merged = mergeAnchorSection(sections.get(sectionName), updates[sectionName]);
    if (!sections.has(sectionName) && !merged) {
      sections.set(sectionName, "");
      continue;
    }
    sections.set(sectionName, merged);
  }

  const finalOrder: string[] = [];
  for (const sectionName of IDENTITY_ANCHOR_SECTION_ORDER) {
    if (sections.has(sectionName)) finalOrder.push(sectionName);
  }
  for (const sectionName of parsed.order) {
    if (!finalOrder.includes(sectionName) && sections.has(sectionName)) {
      finalOrder.push(sectionName);
    }
  }

  const lines: string[] = [header.trim(), ""];
  for (const sectionName of finalOrder) {
    lines.push(`## ${sectionName}`, "");
    const body = sections.get(sectionName)?.trim();
    if (body && body.length > 0) {
      lines.push(body, "");
    } else {
      lines.push("");
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function formatContinuityIncidentSummary(
  incident: Awaited<ReturnType<Orchestrator["storage"]["appendContinuityIncident"]>>,
  index?: number,
): string {
  const prefix = typeof index === "number" ? `### [${index + 1}] ` : "### ";
  const lines = [
    `${prefix}${incident.id} (${incident.state})`,
    `Opened: ${incident.openedAt}`,
  ];
  if (incident.closedAt) lines.push(`Closed: ${incident.closedAt}`);
  if (incident.triggerWindow) lines.push(`Window: ${incident.triggerWindow}`);
  lines.push("", `Symptom: ${incident.symptom}`);
  if (incident.suspectedCause) lines.push(`Suspected Cause: ${incident.suspectedCause}`);
  if (incident.fixApplied) lines.push(`Fix Applied: ${incident.fixApplied}`);
  if (incident.verificationResult) lines.push(`Verification: ${incident.verificationResult}`);
  if (incident.preventiveRule) lines.push(`Preventive Rule: ${incident.preventiveRule}`);
  if (incident.filePath) lines.push(`Path: ${incident.filePath}`);
  return lines.join("\n");
}

function formatContinuityLoopSummary(loop: ContinuityImprovementLoop): string {
  const lines = [
    `### ${loop.id}`,
    `Cadence: ${loop.cadence}`,
    `Status: ${loop.status}`,
    `Last Reviewed: ${loop.lastReviewed}`,
    `Purpose: ${loop.purpose}`,
    `Kill Condition: ${loop.killCondition}`,
  ];
  if (loop.notes) lines.push(`Notes: ${loop.notes}`);
  return lines.join("\n");
}

export function registerTools(api: ToolApi, orchestrator: Orchestrator): void {
  const useDedicatedOpenClawMemoryTools =
    orchestrator.config.openclawToolsEnabled !== false;
  const actionTypes: MemoryActionType[] = [
    "store_episode",
    "store_note",
    "update_note",
    "create_artifact",
    "summarize_node",
    "discard",
    "link_graph",
  ];
  const actionTypeSet = new Set<string>(actionTypes);

  function promptHashForTelemetry(input?: string): string | undefined {
    if (typeof input !== "string" || input.trim().length === 0) return undefined;
    return createHash("sha256").update(input).digest("hex").slice(0, 16);
  }

  function normalizeMemoryCategory(value: unknown, fallback?: MemoryCategory): MemoryCategory | undefined {
    const normalized = asNonEmptyString(value);
    if (!normalized) return fallback;
    if (!VALID_MEMORY_CATEGORIES.has(normalized as MemoryCategory)) return undefined;
    return normalized as MemoryCategory;
  }

  function isKnownMemoryActionType(value: unknown): value is MemoryActionType {
    return typeof value === "string" && actionTypeSet.has(value);
  }

  function buildActionInputSummary(action: MemoryActionType, params: Record<string, unknown>): string {
    const primary =
      asNonEmptyString(params.memoryId) ??
      asNonEmptyString(params.category) ??
      asNonEmptyString(params.linkTargetId);
    const content = asNonEmptyString(params.content);
    let summary = primary ? `${action} => ${primary}` : action;
    if (content) {
      summary += ` | ${content.slice(0, 120)}`;
    }
    return summary;
  }

  async function executeExplicitCapture(
    params: {
      content: string;
      namespace?: string;
      category?: string;
      tags?: string[];
      entityRef?: string;
      confidence?: number;
      ttl?: string;
      sourceReason?: string;
    },
    maintenanceReason: string,
    source: "memory_store" | "memory_capture",
  ) {
    const {
      content,
      namespace,
      category = "fact",
      tags = [],
      entityRef,
      confidence,
      ttl,
      sourceReason,
    } = params;
    const rawInput = {
      content,
      namespace,
      category,
      tags,
      entityRef,
      confidence,
      ttl,
      sourceReason,
    };

    try {
      const candidate = validateExplicitCaptureInput(
        rawInput,
        source === "memory_store" ? "legacy_tool" : "strict_explicit",
      );
      const result = await persistExplicitCapture(orchestrator, candidate, source);

      if (!result.duplicateOf && orchestrator.config.queryAwareIndexingEnabled && indexesExist(orchestrator.config.memoryDir)) {
        const storage = await orchestrator.getStorage(candidate.namespace);
        const mem = await storage.getMemoryById(result.id).catch(() => null);
        if (mem?.path && mem.frontmatter?.created) {
          indexMemory(orchestrator.config.memoryDir, mem.path, mem.frontmatter.created, mem.frontmatter.tags ?? []);
        }
      }

      orchestrator.requestQmdMaintenanceForTool(maintenanceReason);

      return toolResult(
        result.duplicateOf
          ? `Memory already exists: ${result.duplicateOf}${candidate.namespace ? ` (namespace: ${candidate.namespace})` : ""}\n\nContent: ${candidate.content}`
          : `Memory stored: ${result.id}${candidate.namespace ? ` (namespace: ${candidate.namespace})` : ""}\n\nContent: ${candidate.content}`,
      );
    } catch (error) {
      try {
        const queued = await queueExplicitCaptureForReview(orchestrator, rawInput, source, error);
        orchestrator.requestQmdMaintenanceForTool(`${maintenanceReason}.review`);
        return toolResult(
          queued.duplicateOf
            ? `Memory already queued for review: ${queued.duplicateOf}${namespace ? ` (namespace: ${namespace})` : ""}\n\nContent: ${content}`
            : `Memory queued for review: ${queued.id}${namespace ? ` (namespace: ${namespace})` : ""}\n\nContent: ${content}`,
        );
      } catch (queueError) {
        log.warn(`explicit tool capture rejected: ${error}; review queue fallback failed: ${queueError}`);
        return toolResult(`Memory capture failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (!useDedicatedOpenClawMemoryTools) {
    api.registerTool(
      {
        name: "memory_search",
        label: "Search Memory",
        description: `Search local memory files using QMD's semantic index. Returns matching memories with snippets and relevance scores.

Returns: Matching memory entries ranked by relevance
Cost: Free (local index query)
Speed: Fast

Best for:
- Finding previously learned facts about the user
- Checking what you know about a topic
- Locating past decisions or corrections`,
      parameters: Type.Object({
        query: Type.String({
          description: "Search query — keywords, phrases, or natural language",
        }),
        namespace: Type.Optional(
          Type.String({
            description:
              "Optional namespace filter. When set, only returns results under memoryDir/namespaces/<namespace>/ (default namespace uses legacy root).",
          }),
        ),
        maxResults: Type.Optional(
          Type.Number({
            description: "Maximum results (default: 8)",
            minimum: 1,
            maximum: 50,
          }),
        ),
        collection: Type.Optional(
          Type.String({
            description:
              "QMD collection to search. Omit for memory collection, use 'global' for all collections.",
          }),
        ),
      }),
        async execute(_toolCallId, params) {
        const { query, maxResults, collection, namespace } = params as {
          query: string;
          maxResults?: number;
          collection?: string;
          namespace?: string;
        };

        const namespaceFilter = namespace && namespace.length > 0 ? namespace : undefined;
        const filtered =
          collection === "global" && !namespaceFilter
            ? await orchestrator.qmd.searchGlobal(query, maxResults)
            : await orchestrator.searchAcrossNamespaces({
              query,
              namespaces: namespaceFilter ? [namespaceFilter] : undefined,
              maxResults,
              mode: "search",
            });

        if (filtered.length === 0) {
          return toolResult(`No memories found matching: "${query}"`);
        }

        const formatted = filtered
          .map((r, i) => {
            const snippet = r.snippet
              ? r.snippet.slice(0, 800)
              : "(no preview)";
            return `### [${i + 1}] ${r.path}\nScore: ${r.score.toFixed(3)}\n\n\`\`\`\n${snippet}\n\`\`\``;
          })
          .join("\n\n");

        return toolResult(
          `## Memory Search: "${query}"\n\n${filtered.length} result(s)\n\n${formatted}`,
        );
        },
      },
      { name: "memory_search" },
    );
  }

  api.registerTool(
    {
      name: "continuity_audit_generate",
      label: "Generate Continuity Audit",
      description:
        "Generate a deterministic identity continuity audit report (weekly/monthly) and persist it under identity/audits.",
      parameters: Type.Object({
        period: Type.Optional(
          Type.String({
            enum: ["weekly", "monthly"],
            description: "Audit period. Defaults to weekly.",
          }),
        ),
        key: Type.Optional(
          Type.String({
            description:
              "Optional period key (weekly: YYYY-Www, monthly: YYYY-MM). Defaults to current period.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.config.identityContinuityEnabled) {
          return toolResult(
            "Identity continuity is disabled. Enable `identityContinuityEnabled: true` to generate continuity audits.",
          );
        }
        if (!orchestrator.config.continuityAuditEnabled) {
          return toolResult(
            "Continuity audits are disabled. Enable `continuityAuditEnabled: true` to generate continuity audits.",
          );
        }
        if (!orchestrator.compounding) {
          return toolResult(
            "Compounding engine is disabled. Enable `compoundingEnabled: true` to generate continuity audits.",
          );
        }
        const period = params.period === "monthly" ? "monthly" : "weekly";
        const key = typeof params.key === "string" ? params.key : undefined;
        const audit = await orchestrator.compounding.synthesizeContinuityAudit({
          period,
          key,
        });
        return toolResult(
          `OK\n\nperiod: ${audit.period}\nkey: ${audit.key}\nreport: ${audit.reportPath}`,
        );
      },
    },
    { name: "continuity_audit_generate" },
  );

  api.registerTool(
    {
      name: "continuity_incident_open",
      label: "Open Continuity Incident",
      description: "Create a new continuity incident record in append-only storage.",
      parameters: Type.Object({
        symptom: Type.String({
          description: "Observed continuity failure symptom.",
        }),
        namespace: Type.Optional(
          Type.String({
            description: "Optional namespace override. Defaults to the default namespace.",
          }),
        ),
        triggerWindow: Type.Optional(
          Type.String({
            description: "Optional time window when incident occurred.",
          }),
        ),
        suspectedCause: Type.Optional(
          Type.String({
            description: "Optional suspected root cause.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.config.identityContinuityEnabled) {
          return toolResult(
            "Identity continuity is disabled. Enable `identityContinuityEnabled: true` to open incidents.",
          );
        }
        if (!orchestrator.config.continuityIncidentLoggingEnabled) {
          return toolResult(
            "Continuity incident logging is disabled. Enable `continuityIncidentLoggingEnabled: true` to open incidents.",
          );
        }
        const symptom = typeof params.symptom === "string" ? params.symptom.trim() : "";
        if (!symptom) {
          return toolResult("Missing required field: symptom");
        }
        const storage = await orchestrator.getStorageForNamespace(
          normalizeToolNamespace(params.namespace),
        );
        const created = await storage.appendContinuityIncident({
          symptom,
          triggerWindow: typeof params.triggerWindow === "string" ? params.triggerWindow : undefined,
          suspectedCause: typeof params.suspectedCause === "string" ? params.suspectedCause : undefined,
        });
        log.info(`continuity-incident open id=${created.id}`);
        return toolResult(`Continuity incident opened.\n\n${formatContinuityIncidentSummary(created)}`);
      },
    },
    { name: "continuity_incident_open" },
  );

  api.registerTool(
    {
      name: "continuity_incident_close",
      label: "Close Continuity Incident",
      description: "Close an open continuity incident with required verification details.",
      parameters: Type.Object({
        id: Type.String({
          description: "Incident ID to close.",
        }),
        namespace: Type.Optional(
          Type.String({
            description: "Optional namespace override. Defaults to the default namespace.",
          }),
        ),
        fixApplied: Type.String({
          description: "What fix was applied.",
        }),
        verificationResult: Type.String({
          description: "How closure was verified.",
        }),
        preventiveRule: Type.Optional(
          Type.String({
            description: "Optional preventive follow-up rule.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.config.identityContinuityEnabled) {
          return toolResult(
            "Identity continuity is disabled. Enable `identityContinuityEnabled: true` to close incidents.",
          );
        }
        if (!orchestrator.config.continuityIncidentLoggingEnabled) {
          return toolResult(
            "Continuity incident logging is disabled. Enable `continuityIncidentLoggingEnabled: true` to close incidents.",
          );
        }

        const id = typeof params.id === "string" ? params.id.trim() : "";
        const fixApplied = typeof params.fixApplied === "string" ? params.fixApplied.trim() : "";
        const verificationResult =
          typeof params.verificationResult === "string" ? params.verificationResult.trim() : "";
        const preventiveRule =
          typeof params.preventiveRule === "string" ? params.preventiveRule.trim() : undefined;

        if (!id) return toolResult("Missing required field: id");
        if (!fixApplied) return toolResult("Missing required field: fixApplied");
        if (!verificationResult) return toolResult("Missing required field: verificationResult");

        const storage = await orchestrator.getStorageForNamespace(
          normalizeToolNamespace(params.namespace),
        );
        const closed = await storage.closeContinuityIncident(id, {
          fixApplied,
          verificationResult,
          preventiveRule,
        });
        if (!closed) return toolResult(`Incident not found: ${id}`);
        log.info(`continuity-incident close id=${id}`);
        return toolResult(`Continuity incident closed.\n\n${formatContinuityIncidentSummary(closed)}`);
      },
    },
    { name: "continuity_incident_close" },
  );

  api.registerTool(
    {
      name: "continuity_incident_list",
      label: "List Continuity Incidents",
      description: "List continuity incidents and optionally filter by state.",
      parameters: Type.Object({
        state: Type.Optional(
          Type.String({
            enum: ["open", "closed", "all"],
            description: "Incident state filter (default: open).",
          }),
        ),
        namespace: Type.Optional(
          Type.String({
            description: "Optional namespace override. Defaults to the default namespace.",
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            description: "Max incidents to return (default: 25, max: 200).",
            minimum: 1,
            maximum: 200,
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.config.identityContinuityEnabled) {
          return toolResult(
            "Identity continuity is disabled. Enable `identityContinuityEnabled: true` to list incidents.",
          );
        }
        const state = params.state === "closed" || params.state === "all" ? params.state : "open";
        const limitRaw = typeof params.limit === "number" ? params.limit : 25;
        const limit = Math.max(1, Math.min(200, Math.floor(limitRaw)));
        const storage = await orchestrator.getStorageForNamespace(
          normalizeToolNamespace(params.namespace),
        );
        const filtered = await storage.readContinuityIncidents(limit, state);

        if (filtered.length === 0) {
          return toolResult(`No continuity incidents found for state=${state}.`);
        }

        const body = filtered
          .map((incident, index) => formatContinuityIncidentSummary(incident, index))
          .join("\n\n");
        return toolResult(`## Continuity Incidents (${filtered.length}, state=${state})\n\n${body}`);
      },
    },
    { name: "continuity_incident_list" },
  );

  api.registerTool(
    {
      name: "continuity_loop_add_or_update",
      label: "Add or Update Continuity Loop",
      description: "Add or update a continuity improvement loop entry in identity/improvement-loops.md.",
      parameters: Type.Object({
        id: Type.String({
          description: "Stable loop identifier.",
        }),
        namespace: Type.Optional(
          Type.String({
            description: "Optional namespace override. Defaults to the default namespace.",
          }),
        ),
        cadence: Type.String({
          enum: ["daily", "weekly", "monthly", "quarterly"],
          description: "Review cadence.",
        }),
        purpose: Type.String({
          description: "What this recurring loop improves.",
        }),
        status: Type.String({
          enum: ["active", "paused", "retired"],
          description: "Current lifecycle status for the loop.",
        }),
        killCondition: Type.String({
          description: "Clear condition for retiring this loop.",
        }),
        lastReviewed: Type.Optional(
          Type.String({
            description: "Optional ISO timestamp for last review. Defaults to now.",
          }),
        ),
        notes: Type.Optional(
          Type.String({
            description: "Optional operator notes.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.config.identityContinuityEnabled) {
          return toolResult(
            "Identity continuity is disabled. Enable `identityContinuityEnabled: true` to manage continuity loops.",
          );
        }
        try {
          const storage = await orchestrator.getStorageForNamespace(
            normalizeToolNamespace(params.namespace),
          );
          const loop = await storage.upsertIdentityImprovementLoop({
            id: typeof params.id === "string" ? params.id : "",
            cadence: params.cadence as "daily" | "weekly" | "monthly" | "quarterly",
            purpose: typeof params.purpose === "string" ? params.purpose : "",
            status: params.status as "active" | "paused" | "retired",
            killCondition: typeof params.killCondition === "string" ? params.killCondition : "",
            lastReviewed: typeof params.lastReviewed === "string" ? params.lastReviewed : undefined,
            notes: typeof params.notes === "string" ? params.notes : undefined,
          });
          log.info(`continuity-loop upsert id=${loop.id} status=${loop.status}`);
          return toolResult(`Continuity loop saved.\n\n${formatContinuityLoopSummary(loop)}`);
        } catch (err) {
          return toolResult(`Failed to save continuity loop: ${String(err)}`);
        }
      },
    },
    { name: "continuity_loop_add_or_update" },
  );

  api.registerTool(
    {
      name: "continuity_loop_review",
      label: "Review Continuity Loop",
      description: "Update review metadata (lastReviewed/status/notes) for an existing continuity loop.",
      parameters: Type.Object({
        id: Type.String({
          description: "Loop ID to review.",
        }),
        namespace: Type.Optional(
          Type.String({
            description: "Optional namespace override. Defaults to the default namespace.",
          }),
        ),
        status: Type.Optional(
          Type.String({
            enum: ["active", "paused", "retired"],
            description: "Optional status update.",
          }),
        ),
        notes: Type.Optional(
          Type.String({
            description: "Optional notes update.",
          }),
        ),
        reviewedAt: Type.Optional(
          Type.String({
            description: "Optional ISO timestamp for review event. Defaults to now.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.config.identityContinuityEnabled) {
          return toolResult(
            "Identity continuity is disabled. Enable `identityContinuityEnabled: true` to manage continuity loops.",
          );
        }
        const id = typeof params.id === "string" ? params.id.trim() : "";
        if (!id) return toolResult("Missing required field: id");
        try {
          const storage = await orchestrator.getStorageForNamespace(
            normalizeToolNamespace(params.namespace),
          );
          const reviewed = await storage.reviewIdentityImprovementLoop(id, {
            status: typeof params.status === "string" ? (params.status as "active" | "paused" | "retired") : undefined,
            notes: typeof params.notes === "string" ? params.notes : undefined,
            reviewedAt: typeof params.reviewedAt === "string" ? params.reviewedAt : undefined,
          });
          if (!reviewed) return toolResult(`Continuity loop not found: ${id}`);
          log.info(`continuity-loop review id=${id} status=${reviewed.status}`);
          return toolResult(`Continuity loop reviewed.\n\n${formatContinuityLoopSummary(reviewed)}`);
        } catch (err) {
          return toolResult(`Failed to review continuity loop: ${String(err)}`);
        }
      },
    },
    { name: "continuity_loop_review" },
  );

  api.registerTool(
    {
      name: "identity_anchor_get",
      label: "Get Identity Anchor",
      description:
        "Read the identity continuity anchor document used for recovery-safe identity context.",
      parameters: Type.Object({
        namespace: Type.Optional(
          Type.String({
            description: "Optional namespace override. Defaults to the default namespace.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.config.identityContinuityEnabled) {
          return toolResult(
            "Identity continuity is disabled. Enable `identityContinuityEnabled: true` to use identity anchor tools.",
          );
        }
        const storage = await orchestrator.getStorageForNamespace(
          normalizeToolNamespace(params.namespace),
        );
        const anchor = await storage.readIdentityAnchor();
        if (!anchor) {
          return toolResult(
            "No identity anchor found yet. Use `identity_anchor_update` to create one.",
          );
        }
        return toolResult(`## Identity Anchor\n\n${anchor}`);
      },
    },
    { name: "identity_anchor_get" },
  );

  api.registerTool(
    {
      name: "identity_anchor_update",
      label: "Update Identity Anchor",
      description:
        "Conservatively update identity anchor sections without overwriting existing material.",
      parameters: Type.Object({
        namespace: Type.Optional(
          Type.String({
            description: "Optional namespace override. Defaults to the default namespace.",
          }),
        ),
        identityTraits: Type.Optional(
          Type.String({
            description: "Updates for the 'Identity Traits' section.",
          }),
        ),
        communicationPreferences: Type.Optional(
          Type.String({
            description: "Updates for the 'Communication Preferences' section.",
          }),
        ),
        operatingPrinciples: Type.Optional(
          Type.String({
            description: "Updates for the 'Operating Principles' section.",
          }),
        ),
        continuityNotes: Type.Optional(
          Type.String({
            description: "Updates for the 'Continuity Notes' section.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.config.identityContinuityEnabled) {
          return toolResult(
            "Identity continuity is disabled. Enable `identityContinuityEnabled: true` to use identity anchor tools.",
          );
        }

        const updates: Partial<IdentityAnchorSections> = {
          "Identity Traits": typeof params.identityTraits === "string" ? params.identityTraits : undefined,
          "Communication Preferences":
            typeof params.communicationPreferences === "string" ? params.communicationPreferences : undefined,
          "Operating Principles":
            typeof params.operatingPrinciples === "string" ? params.operatingPrinciples : undefined,
          "Continuity Notes":
            typeof params.continuityNotes === "string" ? params.continuityNotes : undefined,
        };

        const hasUpdate = Object.values(updates).some(
          (value) => typeof value === "string" && value.trim().length > 0,
        );
        if (!hasUpdate) {
          return toolResult(
            "No updates provided. Supply at least one section field to update the identity anchor.",
          );
        }

        const storage = await orchestrator.getStorageForNamespace(
          normalizeToolNamespace(params.namespace),
        );
        const existing = await storage.readIdentityAnchor();
        const merged = mergeIdentityAnchor(existing, updates);
        await storage.writeIdentityAnchor(merged);

        const updatedSections = Object.entries(updates)
          .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
          .map(([name]) => name);
        log.info(
          `identity-anchor update sections=${updatedSections.join(",")} chars=${merged.length}`,
        );

        return toolResult(
          `Identity anchor updated (${updatedSections.length} section${updatedSections.length === 1 ? "" : "s"}).\n\n${merged}`,
        );
      },
    },
    { name: "identity_anchor_update" },
  );

  api.registerTool(
    {
      name: "memory_feedback",
      label: "Memory Feedback",
      description:
        "Thumbs up/down a memory's relevance. Stored locally and used as a soft ranking bias when enabled.",
      parameters: Type.Object({
        memoryId: Type.String({
          description: "Memory ID (filename without .md), e.g. fact-123",
        }),
        vote: Type.String({
          enum: ["up", "down"],
          description: "up or down",
        }),
        note: Type.Optional(
          Type.String({
            description: "Optional note explaining the feedback (stored locally).",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { memoryId, vote, note } = params as {
          memoryId: string;
          vote: "up" | "down";
          note?: string;
        };

        if (!orchestrator.config.feedbackEnabled) {
          return toolResult(
            "Feedback is disabled. Enable `feedbackEnabled: true` in the Engram plugin config to store feedback.",
          );
        }

        await orchestrator.recordMemoryFeedback(memoryId, vote, note);
        return toolResult(
          `Recorded feedback for ${memoryId}: ${vote}${note ? ` (note: ${note})` : ""}`,
        );
      },
    },
    { name: "memory_feedback" },
  );

  api.registerTool(
    {
      name: "memory_last_recall",
      label: "Last Recall Snapshot",
      description:
        "Fetch the last set of memory IDs that were injected into context for a session. Useful when the user says things like 'why did you say that?' or 'that's not right' and you want to identify which memories may have misled the response.",
      parameters: Type.Object({
        sessionKey: Type.Optional(
          Type.String({
            description:
              "Session key to look up. If omitted, returns the most recent snapshot across all sessions (may be wrong under concurrency).",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { sessionKey } = params as { sessionKey?: string };

        const snap = sessionKey
          ? orchestrator.lastRecall.get(sessionKey)
          : orchestrator.lastRecall.getMostRecent();

        if (!snap) {
          return toolResult("No last-recall snapshot found yet.");
        }

        const prefix = sessionKey
          ? `## Last Recall (${snap.sessionKey})`
          : `## Last Recall (most recent: ${snap.sessionKey})\n\nNOTE: You did not provide sessionKey; under concurrency this may not match your current session.`;

        return toolResult(
          [
            prefix,
            "",
            `Recorded at: ${snap.recordedAt}`,
            `Query hash: ${snap.queryHash} (len=${snap.queryLen})`,
            `Identity injection: mode=${snap.identityInjectionMode ?? "none"}, chars=${snap.identityInjectedChars ?? 0}, truncated=${snap.identityInjectionTruncated === true ? "yes" : "no"}`,
            `Memories (${snap.memoryIds.length}):`,
            ...snap.memoryIds.map((id) => `- ${id}`),
          ].join("\n"),
        );
      },
    },
    { name: "memory_last_recall" },
  );

  api.registerTool(
    {
      name: "memory_intent_debug",
      label: "Inspect Intent Debug",
      description:
        "Inspect the last persisted planner/intent snapshot, including recall mode selection, query intent classification, and graph fallback decisions.",
      parameters: Type.Object({
        namespace: Type.Optional(
          Type.String({
            description:
              "Optional namespace to inspect. Defaults to defaultNamespace.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { namespace } = params as {
          namespace?: string;
        };
        const text = await orchestrator.explainLastIntent({
          namespace,
        });
        return toolResult(text);
      },
    },
    { name: "memory_intent_debug" },
  );

  api.registerTool(
    {
      name: "memory_qmd_debug",
      label: "Inspect QMD Recall",
      description:
        "Inspect the last persisted QMD recall snapshot, including any intent hint, explain trace capture, and whether hybrid top-up was skipped or used.",
      parameters: Type.Object({
        namespace: Type.Optional(
          Type.String({
            description:
              "Optional namespace to inspect. Defaults to defaultNamespace.",
          }),
        ),
        maxResults: Type.Optional(
          Type.Number({
            description: "Maximum results to show (default: 10, max: 25).",
            minimum: 1,
            maximum: 25,
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { namespace, maxResults } = params as {
          namespace?: string;
          maxResults?: number;
        };
        const text = await orchestrator.explainLastQmdRecall({
          namespace,
          maxResults,
        });
        return toolResult(text);
      },
    },
    { name: "memory_qmd_debug" },
  );

  api.registerTool(
    {
      name: "memory_graph_explain_last_recall",
      label: "Explain Graph Recall",
      description:
        "Inspect the last graph-mode recall expansion snapshot (seed paths + expanded candidates) to explain why graph memories were included.",
      parameters: Type.Object({
        namespace: Type.Optional(
          Type.String({
            description:
              "Optional namespace to inspect. Defaults to defaultNamespace.",
          }),
        ),
        maxExpanded: Type.Optional(
          Type.Number({
            description: "Maximum expanded paths to show (default: 10, max: 50).",
            minimum: 1,
            maximum: 50,
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { namespace, maxExpanded } = params as {
          namespace?: string;
          maxExpanded?: number;
        };
        const text = await orchestrator.explainLastGraphRecall({
          namespace,
          maxExpanded,
        });
        return toolResult(text);
      },
    },
    { name: "memory_graph_explain_last_recall" },
  );

  api.registerTool(
    {
      name: "memory_feedback_last_recall",
      label: "Feedback Last Recall",
      description:
        "Batch feedback tool for the last recall snapshot. Can mark retrieved memories as 'not useful' (negative examples) so they are softly penalized in future ranking when negative examples are enabled.",
      parameters: Type.Object({
        sessionKey: Type.Optional(
          Type.String({
            description:
              "Session key. If omitted, uses the most recent snapshot across all sessions (may be wrong under concurrency).",
          }),
        ),
        notUsefulMemoryIds: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Memory IDs to mark as not useful. If omitted, you may use usefulMemoryIds + autoMarkOthersNotUseful to mark the rest as not useful.",
          }),
        ),
        usefulMemoryIds: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Memory IDs that were useful. Only used when autoMarkOthersNotUseful=true.",
          }),
        ),
        autoMarkOthersNotUseful: Type.Optional(
          Type.Boolean({
            description:
              "If true, marks all last-recall memory IDs not listed in usefulMemoryIds as not useful. Safer than auto-marking without an explicit useful list.",
          }),
        ),
        note: Type.Optional(
          Type.String({
            description:
              "Optional note explaining why these were not useful (stored locally).",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const {
          sessionKey,
          notUsefulMemoryIds,
          usefulMemoryIds,
          autoMarkOthersNotUseful,
          note,
        } = params as {
          sessionKey?: string;
          notUsefulMemoryIds?: string[];
          usefulMemoryIds?: string[];
          autoMarkOthersNotUseful?: boolean;
          note?: string;
        };

        if (!orchestrator.config.negativeExamplesEnabled) {
          return toolResult(
            "Negative examples are disabled. Enable `negativeExamplesEnabled: true` in the Engram plugin config to store retrieved-but-not-useful feedback and apply penalties.",
          );
        }

        const snap = sessionKey
          ? orchestrator.lastRecall.get(sessionKey)
          : orchestrator.lastRecall.getMostRecent();

        if (!snap) {
          return toolResult("No last-recall snapshot found yet.");
        }

        let toMark: string[] | null = null;

        if (Array.isArray(notUsefulMemoryIds) && notUsefulMemoryIds.length > 0) {
          toMark = notUsefulMemoryIds;
        } else if (autoMarkOthersNotUseful) {
          if (!Array.isArray(usefulMemoryIds) || usefulMemoryIds.length === 0) {
            return toolResult(
              "autoMarkOthersNotUseful=true requires a non-empty usefulMemoryIds list (to avoid accidental mass-negative marking).",
            );
          }
          const useful = new Set(usefulMemoryIds);
          toMark = snap.memoryIds.filter((id) => !useful.has(id));
        }

        if (!toMark || toMark.length === 0) {
          return toolResult(
            "Nothing to record. Provide notUsefulMemoryIds, or provide usefulMemoryIds with autoMarkOthersNotUseful=true.",
          );
        }

        await orchestrator.recordNotUsefulMemories(toMark, note);

        const warn = sessionKey
          ? ""
          : "\n\nNOTE: You did not provide sessionKey; under concurrency this may not match your current session.";

        return toolResult(
          `Recorded ${toMark.length} not-useful memory ID(s) for last recall (${snap.sessionKey}).${warn}`,
        );
      },
    },
    { name: "memory_feedback_last_recall" },
  );

  api.registerTool(
    {
      name: "context_checkpoint",
      label: "Context Checkpoint",
      description:
        "Create or validate a transcript checkpoint and record the corresponding context-compression action event (v8.3).",
      parameters: Type.Object({
        summary: Type.String({
          description: "Short summary of what was checkpointed.",
        }),
        sessionKey: Type.Optional(
          Type.String({
            description: "Session key for the checkpoint source transcript.",
          }),
        ),
        turns: Type.Optional(
          Type.Array(
            Type.Object({
              timestamp: Type.String(),
              role: Type.String({ enum: ["user", "assistant"] }),
              content: Type.String(),
              sessionKey: Type.String(),
              turnId: Type.String(),
            }),
          ),
        ),
        ttlHours: Type.Optional(
          Type.Number({
            description: "Optional checkpoint TTL in hours.",
          }),
        ),
        sourcePrompt: Type.Optional(
          Type.String({
            description: "Optional source prompt text used for hashing in telemetry.",
          }),
        ),
        namespace: Type.Optional(
          Type.String({
            description: "Optional namespace. Defaults to defaultNamespace.",
          }),
        ),
        dryRun: Type.Optional(
          Type.Boolean({
            description: "When true, validate and log without persisting the checkpoint file.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.config.contextCompressionActionsEnabled) {
          return toolResult(
            "Context compression actions are disabled. Enable `contextCompressionActionsEnabled: true` to use this tool.",
          );
        }
        const { summary, sourcePrompt, namespace, sessionKey, turns, ttlHours, dryRun } = params as {
          summary: string;
          sourcePrompt?: string;
          namespace?: string;
          sessionKey?: string;
          turns?: Array<{
            timestamp: string;
            role: "user" | "assistant";
            content: string;
            sessionKey: string;
            turnId: string;
          }>;
          ttlHours?: number;
          dryRun?: boolean;
        };
        const ns =
          typeof namespace === "string" && namespace.length > 0
            ? namespace
            : orchestrator.config.defaultNamespace;
        const structuredCheckpointRequest =
          Object.prototype.hasOwnProperty.call(params, "sessionKey") ||
          Object.prototype.hasOwnProperty.call(params, "turns") ||
          Object.prototype.hasOwnProperty.call(params, "ttlHours") ||
          dryRun === true;
        if (!structuredCheckpointRequest) {
          const wrote = await orchestrator.appendMemoryActionEvent({
            action: "summarize_node",
            outcome: "applied",
            namespace: ns,
            reason: `context_checkpoint:${summary.slice(0, 200)}`,
            promptHash: promptHashForTelemetry(sourcePrompt),
          });
          if (!wrote) {
            return toolResult("Checkpoint recorded best-effort failed (fail-open).");
          }
          return toolResult(`Recorded context checkpoint telemetry in namespace=${ns}.`);
        }
        const validationErrors: string[] = [];
        if (!asNonEmptyString(sessionKey)) validationErrors.push("sessionKey is required");
        if (!Array.isArray(turns) || turns.length === 0) validationErrors.push("turns must be a non-empty array");

        const baseEvent = {
          action: "summarize_node" as const,
          namespace: ns,
          actor: "tool.context_checkpoint",
          subsystem: "tools.context_checkpoint",
          sourceSessionKey: asNonEmptyString(sessionKey),
          inputSummary: summary,
          checkpointTurnCount: Array.isArray(turns) ? turns.length : undefined,
          dryRun: dryRun === true,
          promptHash: promptHashForTelemetry(sourcePrompt),
        };

        if (validationErrors.length > 0) {
          await orchestrator.appendMemoryActionEvent({
            ...baseEvent,
            outcome: "failed",
            status: "rejected",
            reason: `validation: ${validationErrors.join("; ")}`,
          });
          return toolResult(`Validation failed: ${validationErrors.join("; ")}.`);
        }

        const structuredEvent = {
          ...baseEvent,
          outcome: "applied" as const,
        };
        const preview = orchestrator.previewMemoryActionEvent(structuredEvent);
        if (preview.policyDecision !== "allow") {
          const wrote = await orchestrator.appendMemoryActionEvent(structuredEvent);
          const suffix = wrote ? "" : " Telemetry write failed (fail-open).";
          return toolResult(
            `Context checkpoint blocked by policy: action=${preview.action}, namespace=${preview.namespace}, policy=${preview.policyDecision}, rationale=${preview.policyRationale}.${suffix}`,
          );
        }

        const checkpoint = orchestrator.transcript.createCheckpoint(
          sessionKey!,
          turns!,
          typeof ttlHours === "number" ? ttlHours : undefined,
        );

        if (dryRun !== true) {
          await orchestrator.transcript.saveCheckpoint(checkpoint);
        }

        const wrote = await orchestrator.appendMemoryActionEvent({
          ...baseEvent,
          outcome: "applied",
          status: dryRun === true ? "validated" : "applied",
          reason: `context_checkpoint:${summary.slice(0, 200)}`,
          checkpointCapturedAt: checkpoint.capturedAt,
          checkpointTtl: checkpoint.ttl,
        });

        const suffix = wrote ? "" : " Telemetry write failed (fail-open).";
        if (dryRun === true) {
          return toolResult(`Validated context checkpoint for session=${sessionKey} without saving it.${suffix}`);
        }
        return toolResult(`Saved context checkpoint for session=${sessionKey} in namespace=${ns}.${suffix}`);
      },
    },
    { name: "context_checkpoint" },
  );

  api.registerTool(
    {
      name: "memory_action_apply",
      label: "Apply Memory Action",
      description:
        "Record a memory-action application event for policy-learning telemetry (v8.3).",
      parameters: Type.Object({
        action: Type.String({
          enum: actionTypes,
          description: "Memory action type.",
        }),
        category: Type.Optional(
          Type.String({
            description: "Optional memory category for write-style actions.",
          }),
        ),
        content: Type.Optional(
          Type.String({
            description: "Content payload for store, update, artifact, or summarize actions.",
          }),
        ),
        outcome: Type.Optional(
          Type.String({
            enum: ["applied", "skipped", "failed"],
            description: "Outcome status (default: applied).",
          }),
        ),
        reason: Type.Optional(
          Type.String({
            description: "Optional reason/notes for this action outcome.",
          }),
        ),
        memoryId: Type.Optional(
          Type.String({
            description: "Optional memory ID targeted by this action.",
          }),
        ),
        sessionKey: Type.Optional(
          Type.String({
            description: "Optional source session key for audit logging.",
          }),
        ),
        linkTargetId: Type.Optional(
          Type.String({
            description: "Target memory ID for link_graph actions.",
          }),
        ),
        linkType: Type.Optional(
          Type.String({
            description: "Link type for link_graph actions.",
          }),
        ),
        linkStrength: Type.Optional(
          Type.Number({
            description: "Optional edge strength for link_graph actions.",
          }),
        ),
        artifactType: Type.Optional(
          Type.String({
            description: "Optional artifact type for create_artifact.",
          }),
        ),
        execute: Type.Optional(
          Type.Boolean({
            description: "When true, force structured execution mode even for target-only actions like discard.",
          }),
        ),
        sourcePrompt: Type.Optional(
          Type.String({
            description: "Optional source prompt text used for hashing in telemetry.",
          }),
        ),
        namespace: Type.Optional(
          Type.String({
            description: "Optional namespace. Defaults to defaultNamespace.",
          }),
        ),
        dryRun: Type.Optional(
          Type.Boolean({
            description: "When true, validate and report without persisting telemetry.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.config.contextCompressionActionsEnabled) {
          return toolResult(
            "Context compression actions are disabled. Enable `contextCompressionActionsEnabled: true` to use this tool.",
          );
        }
        const {
          action,
          outcome,
          reason,
          memoryId,
          sourcePrompt,
          namespace,
          dryRun,
          category,
          content,
          sessionKey,
          linkTargetId,
          linkType,
          linkStrength,
          artifactType,
          execute,
        } = params as {
          action: MemoryActionType;
          outcome?: "applied" | "skipped" | "failed";
          reason?: string;
          memoryId?: string;
          sourcePrompt?: string;
          namespace?: string;
          dryRun?: boolean;
          category?: string;
          content?: string;
          sessionKey?: string;
          linkTargetId?: string;
          linkType?: string;
          linkStrength?: number;
          artifactType?: string;
          execute?: boolean;
        };
        const ns =
          typeof namespace === "string" && namespace.length > 0
            ? namespace
            : orchestrator.config.defaultNamespace;
        if (!isKnownMemoryActionType(action)) {
          return toolResult(`Validation failed: invalid action ${String(action)}.`);
        }
        const validationErrors: string[] = [];
        const contentValue = asNonEmptyString(content);
        const memoryIdValue = asNonEmptyString(memoryId);
        const linkTargetIdValue = asNonEmptyString(linkTargetId);
        const linkTypeValue = asNonEmptyString(linkType);
        const structuredActionRequest =
          execute === true ||
          Object.prototype.hasOwnProperty.call(params, "content") ||
          Object.prototype.hasOwnProperty.call(params, "category") ||
          Object.prototype.hasOwnProperty.call(params, "linkTargetId") ||
          Object.prototype.hasOwnProperty.call(params, "linkType") ||
          Object.prototype.hasOwnProperty.call(params, "linkStrength") ||
          Object.prototype.hasOwnProperty.call(params, "artifactType");

        const baseEvent = {
          action,
          namespace: ns,
          actor: "tool.memory_action_apply",
          subsystem: "tools.memory_action_apply",
          reason,
          memoryId: memoryIdValue,
          sourceSessionKey: asNonEmptyString(sessionKey),
          inputSummary: buildActionInputSummary(action, params),
          promptHash: promptHashForTelemetry(sourcePrompt),
        };

        if (!structuredActionRequest) {
          const event = {
            ...baseEvent,
            outcome: outcome ?? "applied",
          };
          const preview = orchestrator.previewMemoryActionEvent(event);

          if (dryRun === true) {
            return toolResult(
              `Dry run: memory action would be recorded with action=${preview.action}, outcome=${preview.outcome}, namespace=${preview.namespace}, policy=${preview.policyDecision}.`,
            );
          }

          const wrote = await orchestrator.appendMemoryActionEvent(event);
          if (!wrote) {
            return toolResult("Memory action telemetry write failed (fail-open).");
          }
          return toolResult(
            `Recorded memory action telemetry: action=${preview.action}, outcome=${preview.outcome}, namespace=${preview.namespace}.`,
          );
        }

        switch (action) {
          case "store_episode":
          case "store_note":
          case "summarize_node":
          case "create_artifact":
            if (!contentValue) validationErrors.push("content is required");
            break;
          case "update_note":
            if (!memoryIdValue) validationErrors.push("memoryId is required");
            if (!contentValue) validationErrors.push("content is required");
            break;
          case "discard":
            if (!memoryIdValue) validationErrors.push("memoryId is required");
            break;
          case "link_graph":
            if (!memoryIdValue) validationErrors.push("memoryId is required");
            if (!linkTargetIdValue) validationErrors.push("linkTargetId is required");
            if (!linkTypeValue) validationErrors.push("linkType is required");
            if (
              typeof linkStrength === "number" &&
              (!Number.isFinite(linkStrength) || linkStrength < 0 || linkStrength > 1)
            ) {
              validationErrors.push("linkStrength must be between 0 and 1");
            }
            break;
        }

        if (validationErrors.length > 0) {
          await orchestrator.appendMemoryActionEvent({
            ...baseEvent,
            outcome: "failed",
            status: "rejected",
            dryRun: dryRun === true,
            outputMemoryIds: [],
            reason: `validation: ${validationErrors.join("; ")}`,
          });
          return toolResult(
            `Validation failed: ${validationErrors.join("; ")}.`,
          );
        }

        const normalizedCategory = normalizeMemoryCategory(category, "fact");
        if (category !== undefined && normalizedCategory === undefined) {
          const wrote = await orchestrator.appendMemoryActionEvent({
            ...baseEvent,
            outcome: "failed",
            status: "rejected",
            dryRun: dryRun === true,
            outputMemoryIds: [],
            reason: `validation: invalid category ${String(category)}`,
          });
          const suffix = wrote ? "" : " Telemetry write failed (fail-open).";
          return toolResult(`Validation failed: invalid category ${String(category)}.${suffix}`);
        }

        const storage =
          typeof orchestrator.getStorage === "function"
            ? await orchestrator.getStorage(ns)
            : orchestrator.storage;
        const referencedMemory = await readReferencedMemoryForPolicyEligibility(storage, memoryIdValue);
        const structuredEvent = {
          ...baseEvent,
          outcome: outcome ?? "applied",
          dryRun: dryRun === true,
          outputMemoryIds: [],
          policyEligibility: deriveMemoryActionPolicyEligibility(referencedMemory),
        };

        if (dryRun === true) {
          const preview = orchestrator.previewMemoryActionEvent(structuredEvent);
          const wrote = await orchestrator.appendMemoryActionEvent(structuredEvent);
          const suffix = wrote ? "" : " Telemetry write failed (fail-open).";
          if (preview.policyDecision !== "allow") {
            return toolResult(
              `Memory action blocked by policy during validation: action=${preview.action}, namespace=${preview.namespace}, policy=${preview.policyDecision}, rationale=${preview.policyRationale}.${suffix}`,
            );
          }
          return toolResult(
            `Validated memory action without applying it: action=${preview.action}, namespace=${preview.namespace}, policy=${preview.policyDecision}.${suffix}`,
          );
        }

        const preview = orchestrator.previewMemoryActionEvent(structuredEvent);
        if (preview.policyDecision !== "allow") {
          const wrote = await orchestrator.appendMemoryActionEvent(structuredEvent);
          const suffix = wrote ? "" : " Telemetry write failed (fail-open).";
          return toolResult(
            `Memory action execution blocked by policy: action=${preview.action}, namespace=${preview.namespace}, policy=${preview.policyDecision}, rationale=${preview.policyRationale}.${suffix}`,
          );
        }

        const outputMemoryIds: string[] = [];
        let appliedMessage = "";

        switch (action) {
          case "store_episode": {
            const createdId = await storage.writeMemory(normalizedCategory ?? "fact", contentValue!, {
              actor: "tool.memory_action_apply",
              source: "memory_action_apply",
              memoryKind: "episode",
            });
            outputMemoryIds.push(createdId);
            appliedMessage = `Applied memory action: action=${action}, memoryId=${createdId}, namespace=${ns}.`;
            break;
          }
          case "store_note": {
            const createdId = await storage.writeMemory(normalizedCategory ?? "fact", contentValue!, {
              actor: "tool.memory_action_apply",
              source: "memory_action_apply",
            });
            outputMemoryIds.push(createdId);
            appliedMessage = `Applied memory action: action=${action}, memoryId=${createdId}, namespace=${ns}.`;
            break;
          }
          case "update_note": {
            const updated = await storage.updateMemory(memoryIdValue!, contentValue!, {
              actor: "tool.memory_action_apply",
            });
            if (!updated) {
              const wrote = await orchestrator.appendMemoryActionEvent({
                ...baseEvent,
                outcome: "failed",
                status: "rejected",
                outputMemoryIds: [],
                reason: `execution: unable to update memory ${memoryIdValue}`,
              });
              const suffix = wrote ? "" : " Telemetry write failed (fail-open).";
              return toolResult(`Validation failed: unable to update memory ${memoryIdValue}.${suffix}`);
            }
            outputMemoryIds.push(memoryIdValue!);
            appliedMessage = `Applied memory action: action=${action}, memoryId=${memoryIdValue}, namespace=${ns}.`;
            break;
          }
          case "create_artifact": {
            const createdId = await storage.writeArtifact(contentValue!, {
              actor: "tool.memory_action_apply",
              artifactType: artifactType as any,
              sourceMemoryId: memoryIdValue,
            });
            if (!createdId || createdId.trim().length === 0) {
              const wrote = await orchestrator.appendMemoryActionEvent({
                ...baseEvent,
                outcome: "failed",
                status: "rejected",
                outputMemoryIds: [],
                reason: "execution: unable to create artifact",
              });
              const suffix = wrote ? "" : " Telemetry write failed (fail-open).";
              return toolResult(`Validation failed: unable to create artifact.${suffix}`);
            }
            outputMemoryIds.push(createdId);
            appliedMessage = `Applied memory action: action=${action}, memoryId=${createdId}, namespace=${ns}.`;
            break;
          }
          case "summarize_node": {
            const createdId = await storage.writeMemory(normalizedCategory ?? "fact", contentValue!, {
              actor: "tool.memory_action_apply",
              source: "memory_action_apply",
              sourceMemoryId: memoryIdValue,
            });
            outputMemoryIds.push(createdId);
            appliedMessage = `Applied memory action: action=${action}, memoryId=${createdId}, namespace=${ns}.`;
            break;
          }
          case "discard": {
            const target = referencedMemory;
            if (!target) {
              const wrote = await orchestrator.appendMemoryActionEvent({
                ...baseEvent,
                outcome: "failed",
                status: "rejected",
                outputMemoryIds: [],
                reason: `execution: unable to find memory ${memoryIdValue}`,
              });
              const suffix = wrote ? "" : " Telemetry write failed (fail-open).";
              return toolResult(`Validation failed: unable to find memory ${memoryIdValue}.${suffix}`);
            }
            await storage.writeMemoryFrontmatter(
              target,
              {
                status: "rejected",
                updated: new Date().toISOString(),
              },
              {
                actor: "tool.memory_action_apply",
                reasonCode: "memory_action_apply.discard",
              },
            );
            outputMemoryIds.push(memoryIdValue!);
            appliedMessage = `Applied memory action: action=${action}, memoryId=${memoryIdValue}, namespace=${ns}.`;
            break;
          }
          case "link_graph": {
            const linked = await storage.addLinksToMemory(
              memoryIdValue!,
              [
                {
                  targetId: linkTargetIdValue!,
                  linkType: linkTypeValue as any,
                  strength: typeof linkStrength === "number" ? linkStrength : 1,
                  reason,
                },
              ],
              {
                actor: "tool.memory_action_apply",
                reasonCode: "memory_action_apply.link_graph",
                relatedMemoryIds: [linkTargetIdValue!],
              },
            );
            if (!linked) {
              const wrote = await orchestrator.appendMemoryActionEvent({
                ...baseEvent,
                outcome: "failed",
                status: "rejected",
                outputMemoryIds: [],
                reason: `execution: unable to link memory ${memoryIdValue}`,
              });
              const suffix = wrote ? "" : " Telemetry write failed (fail-open).";
              return toolResult(`Validation failed: unable to link memory ${memoryIdValue}.${suffix}`);
            }
            outputMemoryIds.push(memoryIdValue!);
            appliedMessage = `Applied memory action: action=${action}, memoryId=${memoryIdValue}, namespace=${ns}.`;
            break;
          }
        }

        orchestrator.requestQmdMaintenanceForTool(`memory_action_apply.${action}`);
        const wrote = await orchestrator.appendMemoryActionEvent({
          ...structuredEvent,
          outcome: "applied",
          status: "applied",
          dryRun: false,
          outputMemoryIds,
        });
        if (!wrote) {
          return toolResult(`${appliedMessage} Telemetry write failed (fail-open).`);
        }
        return toolResult(appliedMessage);
      },
    },
    { name: "memory_action_apply" },
  );

  api.registerTool(
    {
      name: "compression_guidelines_optimize",
      label: "Optimize Compression Guidelines",
      description:
        "Run compression guideline optimizer and optionally persist the new guideline/state (v8.11).",
      parameters: Type.Object({
        dryRun: Type.Optional(
          Type.Boolean({
            description: "When true, compute candidate/output but do not persist changes.",
          }),
        ),
        eventLimit: Type.Optional(
          Type.Number({
            description: "Max telemetry events to analyze (default: 500).",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { dryRun, eventLimit } = params as {
          dryRun?: boolean;
          eventLimit?: number;
        };

        const result = await orchestrator.optimizeCompressionGuidelines({
          dryRun: dryRun === true,
          eventLimit,
        });

        if (!result.enabled) {
          return toolResult(
            "Compression guideline learning is disabled. Enable `compressionGuidelineLearningEnabled: true` to run optimizer.",
          );
        }

        return toolResult(
          [
            "Compression guideline optimization complete.",
            `dryRun=${result.dryRun}`,
            `persisted=${result.persisted}`,
            `eventCount=${result.eventCount}`,
            `guidelineVersion: ${result.previousGuidelineVersion ?? "none"} -> ${result.nextGuidelineVersion}`,
            `draftContentHash=${result.draftContentHash ?? "none"}`,
            `changedRules=${result.changedRules}`,
            `semanticRefinementApplied=${result.semanticRefinementApplied}`,
          ].join("\n"),
        );
      },
    },
    { name: "compression_guidelines_optimize" },
  );

  api.registerTool(
    {
      name: "compression_guidelines_activate",
      label: "Activate Compression Guideline Draft",
      description:
        "Promote the staged compression guideline draft to the active guideline/state after review (v8.11).",
      parameters: Type.Object({
        expectedContentHash: Type.Optional(Type.String()),
        expectedGuidelineVersion: Type.Optional(Type.Number()),
      }),
      async execute(_toolCallId, params) {
        const expectedContentHash =
          typeof params.expectedContentHash === "string" ? params.expectedContentHash.trim() : "";
        const expectedGuidelineVersion =
          typeof params.expectedGuidelineVersion === "number" &&
          Number.isFinite(params.expectedGuidelineVersion)
            ? Math.floor(params.expectedGuidelineVersion)
            : undefined;
        const result = await orchestrator.activateCompressionGuidelineDraft({
          ...(expectedContentHash ? { expectedContentHash } : {}),
          ...(typeof expectedGuidelineVersion === "number" ? { expectedGuidelineVersion } : {}),
        });

        if (!result.enabled) {
          return toolResult(
            "Compression guideline learning is disabled. Enable `compressionGuidelineLearningEnabled: true` before activating drafts.",
          );
        }

        if (!result.activated) {
          if (result.reason === "missing_draft") {
            return toolResult("No staged compression guideline draft is available to activate.");
          }
          if (result.reason === "expected_revision_required") {
            return toolResult(
              "Activation requires `expectedContentHash` or `expectedGuidelineVersion` so the reviewed draft identity is pinned.",
            );
          }
          if (result.reason === "content_hash_mismatch" || result.reason === "draft_changed") {
            return toolResult(
              "The staged compression guideline draft changed after review. Re-read the current draft and retry activation with its latest identity.",
            );
          }
          if (result.reason === "guideline_version_mismatch") {
            return toolResult(
              "The staged draft guidelineVersion no longer matches the reviewed revision. Re-read the current draft and retry activation with its latest identity.",
            );
          }

          return toolResult("Compression guideline draft activation was rejected.");
        }

        return toolResult(
          [
            "Compression guideline draft activated.",
            `guidelineVersion=${result.guidelineVersion ?? "unknown"}`,
          ].join("\n"),
        );
      },
    },
    { name: "compression_guidelines_activate" },
  );

  api.registerTool(
    {
      name: "memory_store",
      label: "Store Memory",
      description: `Explicitly store a memory. Use this when the user directly asks you to remember something, or when you identify critical information that the automatic extraction might miss.

Cost: Free (local file write)
Speed: Instant

Best for:
- User says "remember that..." or "note that..."
- Critical corrections or preferences
- Important decisions or facts`,
      parameters: Type.Object({
        content: Type.String({
          description: "The memory to store — a clear, standalone statement",
        }),
        namespace: Type.Optional(
          Type.String({
            description:
              "Namespace to store into (v3.0+). Omit to store into defaultNamespace.",
          }),
        ),
        category: Type.Optional(
          Type.String({
            description:
              'Category: "fact", "preference", "correction", "entity", "decision", "relationship", "principle", "commitment", "moment", "skill", "rule", "procedure", "reasoning_trace" (default: "fact")',
            enum: ["fact", "preference", "correction", "entity", "decision", "relationship", "principle", "commitment", "moment", "skill", "rule", "procedure", "reasoning_trace"],
          }),
        ),
        tags: Type.Optional(
          Type.Array(Type.String(), {
            description: "Tags for categorization",
          }),
        ),
        entityRef: Type.Optional(
          Type.String({
            description:
              "Entity reference (e.g., person-jane-doe, project-my-app)",
          }),
        ),
        confidence: Type.Optional(
          Type.Number({
            description: "Explicit capture confidence (0-1). Defaults to 0.95.",
            minimum: 0,
            maximum: 1,
          }),
        ),
        ttl: Type.Optional(
          Type.String({
            description: "Optional TTL expression to attach to the stored memory.",
          }),
        ),
        sourceReason: Type.Optional(
          Type.String({
            description: "Optional reason code for audit history.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        return executeExplicitCapture(
          params as {
            content: string;
            namespace?: string;
            category?: string;
            tags?: string[];
            entityRef?: string;
            confidence?: number;
            ttl?: string;
            sourceReason?: string;
          },
          "memory_store",
          "memory_store",
        );
      },
    },
    { name: "memory_store" },
  );

  api.registerTool(
    {
      name: "memory_capture",
      label: "Capture Memory",
      description:
        "Store a validated explicit memory note. Preferred tool for explicit capture modes and operator-controlled memory creation.",
      parameters: Type.Object({
        content: Type.String({
          description: "The memory to store — one standalone validated statement.",
        }),
        namespace: Type.Optional(
          Type.String({
            description:
              "Namespace to store into. Omit to store into defaultNamespace.",
          }),
        ),
        category: Type.Optional(
          Type.String({
            description: "Memory category.",
            enum: ["fact", "preference", "correction", "entity", "decision", "relationship", "principle", "commitment", "moment", "skill", "rule", "procedure", "reasoning_trace"],
          }),
        ),
        tags: Type.Optional(
          Type.Array(Type.String(), {
            description: "Tags for categorization",
          }),
        ),
        entityRef: Type.Optional(
          Type.String({
            description:
              "Entity reference (e.g., person-jane-doe, project-my-app)",
          }),
        ),
        confidence: Type.Optional(
          Type.Number({
            description: "Explicit capture confidence (0-1). Defaults to 0.95.",
            minimum: 0,
            maximum: 1,
          }),
        ),
        ttl: Type.Optional(
          Type.String({
            description: "Optional TTL expression to attach to the stored memory.",
          }),
        ),
        sourceReason: Type.Optional(
          Type.String({
            description: "Optional reason code for audit history.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        return executeExplicitCapture(
          params as {
            content: string;
            namespace?: string;
            category?: string;
            tags?: string[];
            entityRef?: string;
            confidence?: number;
            ttl?: string;
            sourceReason?: string;
          },
          "memory_capture",
          "memory_capture",
        );
      },
    },
    { name: "memory_capture" },
  );

  api.registerTool(
    {
      name: "memory_promote",
      label: "Promote Memory To Shared",
      description:
        "Copy a memory into the shared namespace (v3.0+). This is intended for curated promotion of agent-specific learning into a shared brain.",
      parameters: Type.Object({
        memoryId: Type.String({
          description: "Memory ID (filename without .md), e.g. fact-123",
        }),
        fromNamespace: Type.Optional(
          Type.String({
            description: "Source namespace (default: defaultNamespace).",
          }),
        ),
        toNamespace: Type.Optional(
          Type.String({
            description: "Target namespace (default: sharedNamespace).",
          }),
        ),
        note: Type.Optional(
          Type.String({
            description:
              "Optional note explaining why this should be shared (stored as a tag-like annotation).",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.config.namespacesEnabled) {
          return toolResult(
            "Namespaces are disabled. Enable `namespacesEnabled: true` to use memory promotion.",
          );
        }

        const { memoryId, fromNamespace, toNamespace, note } = params as {
          memoryId: string;
          fromNamespace?: string;
          toNamespace?: string;
          note?: string;
        };

        const srcNs = fromNamespace && fromNamespace.length > 0 ? fromNamespace : orchestrator.config.defaultNamespace;
        const dstNs = toNamespace && toNamespace.length > 0 ? toNamespace : orchestrator.config.sharedNamespace;

        const src = await orchestrator.getStorage(srcNs);
        const mem = await src.getMemoryById(memoryId);
        if (!mem) {
          return toolResult(`Memory not found in ${srcNs}: ${memoryId}`);
        }

        const dst = await orchestrator.getStorage(dstNs);
        const newId = await dst.writeMemory(mem.frontmatter.category, mem.content, {
          confidence: mem.frontmatter.confidence,
          tags: Array.from(new Set([...(mem.frontmatter.tags ?? []), "promoted", `promotedFrom:${srcNs}:${memoryId}`, ...(note ? [`note:${note}`] : [])])),
          entityRef: mem.frontmatter.entityRef,
          source: "promote",
          importance: mem.frontmatter.importance,
          supersedes: mem.frontmatter.supersedes,
          links: mem.frontmatter.links,
        });

        // Update temporal + tag indexes for the promoted copy (v8.1).
        // Same guard as memory_store: skip if indexes don't exist yet to avoid
        // blocking the full corpus bootstrap on the next extraction.
        if (orchestrator.config.queryAwareIndexingEnabled && indexesExist(orchestrator.config.memoryDir)) {
          const promoted = await dst.getMemoryById(newId).catch(() => null);
          if (promoted?.path && promoted.frontmatter?.created) {
            indexMemory(orchestrator.config.memoryDir, promoted.path, promoted.frontmatter.created, promoted.frontmatter.tags ?? []);
          }
        }

        return toolResult(`Promoted ${srcNs}:${memoryId} → ${dstNs}:${newId}`);
      },
    },
    { name: "memory_promote" },
  );

  api.registerTool(
    {
      name: "memory_profile",
      label: "View User Profile",
      description: `Read the user's behavioral profile — a living document of their preferences, habits, and personality.

Cost: Free (local file read)
Speed: Instant

Best for:
- Understanding the user holistically
- Checking preferences before making decisions
- "What do you know about me?"`,
      parameters: Type.Object({
        namespace: Type.Optional(
          Type.String({
            description: "Optional namespace override. Defaults to the default namespace.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const namespace = normalizeToolNamespace(params.namespace);
        const storage = await orchestrator.getStorageForNamespace(namespace);
        const profile = await storage.readProfile();
        if (!profile) {
          return toolResult(
            "No profile built yet. The profile builds automatically through conversations.",
          );
        }
        return toolResult(`## User Profile\n\n${profile}`);
      },
    },
    { name: "memory_profile" },
  );

  api.registerTool(
    {
      name: "memory_entities",
      label: "List Known Entities",
      description: `List all tracked entities (people, projects, tools, companies) with their facts.

Cost: Free (local file read)
Speed: Instant

Best for:
- Seeing all known entities
- Looking up facts about a specific entity`,
      parameters: Type.Object({
        name: Type.Optional(
          Type.String({
            description:
              "Specific entity to look up (e.g., person-jane-doe)",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { name } = params as { name?: string };

        if (name) {
          const content = await orchestrator.storage.readEntity(name);
          if (!content) {
            return toolResult(`Entity "${name}" not found.`);
          }
          return toolResult(content);
        }

        const entities = await orchestrator.storage.readEntities();
        if (entities.length === 0) {
          return toolResult(
            "No entities tracked yet. Entities build automatically through conversations.",
          );
        }

        return toolResult(
          `## Known Entities (${entities.length})\n\n${entities.map((e) => `- ${e}`).join("\n")}`,
        );
      },
    },
    { name: "memory_entities" },
  );

  api.registerTool(
    {
      name: "memory_questions",
      label: "View/Manage Questions",
      description: `View open questions the AI is curious about, or resolve answered questions.

Cost: Free (local file read)
Speed: Instant

Best for:
- Seeing what questions have been generated from past conversations
- Resolving questions that have been answered
- "What questions do you have for me?"`,
      parameters: Type.Object({
        action: Type.Optional(
          Type.String({
            description: '"list" (default) to show unresolved questions, "all" to show all, "resolve" to mark one as answered',
            enum: ["list", "all", "resolve"],
          }),
        ),
        questionId: Type.Optional(
          Type.String({
            description: "Question ID to resolve (required when action is 'resolve')",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { action = "list", questionId } = params as {
          action?: string;
          questionId?: string;
        };

        if (action === "resolve") {
          if (!questionId) {
            return toolResult("Error: questionId is required when action is 'resolve'");
          }
          const resolved = await orchestrator.storage.resolveQuestion(questionId);
          return toolResult(resolved ? `Question ${questionId} marked as resolved.` : `Question ${questionId} not found.`);
        }

        const unresolvedOnly = action !== "all";
        const questions = await orchestrator.storage.readQuestions({ unresolvedOnly });

        if (questions.length === 0) {
          return toolResult(unresolvedOnly
            ? "No unresolved questions. Questions are generated automatically during memory extraction."
            : "No questions found.");
        }

        const formatted = questions.map((q, i) =>
          `### [${i + 1}] ${q.id}\nPriority: ${q.priority.toFixed(2)} | Created: ${q.created}${q.resolved ? " | RESOLVED" : ""}\n\n${q.question}\n\n_Context: ${q.context}_`
        ).join("\n\n");

        return toolResult(`## Questions (${questions.length})\n\n${formatted}`);
      },
    },
    { name: "memory_questions" },
  );

  api.registerTool(
    {
      name: "memory_identity",
      label: "View Identity Reflections",
      description: `Read the agent's identity reflections from the workspace IDENTITY.md file.

Cost: Free (local file read)
Speed: Instant

Best for:
- Understanding the agent's self-model and growth
- "What have you learned about yourself?"
- Reviewing identity development over time`,
      parameters: Type.Object({
        namespace: Type.Optional(
          Type.String({
            description: "Optional namespace override. Defaults to the default namespace.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const namespace = normalizeToolNamespace(params.namespace);
        const storage = await orchestrator.getStorageForNamespace(namespace);
        const identity = await storage.readIdentityReflections();
        if (!identity) {
          return toolResult("No identity reflections found. Identity reflections build automatically through conversations when identityEnabled is true.");
        }
        return toolResult(`## Agent Identity\n\n${identity}`);
      },
    },
    { name: "memory_identity" },
  );

  api.registerTool(
    {
      name: "memory_governance_run",
      label: "Run Memory Governance",
      description: `Run Remnic memory governance in a bounded shadow/apply pass.

Cost: Low to medium (local file scan only)
Speed: Fast for bounded windows

Best for:
- Nightly incremental governance sweeps
- Manual shadow runs on recent memory windows
- Small-batch review queue generation without scanning the full corpus at once`,
      parameters: Type.Object({
        namespace: Type.Optional(
          Type.String({
            description: "Optional namespace override. Defaults to the default namespace.",
          }),
        ),
        mode: Type.Optional(
          Type.Union([
            Type.Literal("shadow"),
            Type.Literal("apply"),
          ], {
            description: "Governance mode. Defaults to shadow.",
          }),
        ),
        recentDays: Type.Optional(
          Type.Number({
            description: "Only scan memories updated within the last N days.",
          }),
        ),
        maxMemories: Type.Optional(
          Type.Number({
            description: "Maximum number of memories to scan in this run.",
          }),
        ),
        batchSize: Type.Optional(
          Type.Number({
            description: "File-read batch size for bounded governance runs.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const deepSleep = orchestrator.config.dreamsPhases.deepSleep;
        if (deepSleep.enabled === false && deepSleep.enabledExplicitlySet === true) {
          return toolResult(
            "Memory governance is disabled by `dreams.phases.deepSleep.enabled=false`.",
          );
        }
        const namespace = normalizeToolNamespace(params.namespace);
        const storage = await orchestrator.getStorageForNamespace(namespace);
        const mode = params.mode === "apply" ? "apply" : "shadow";
        const recentDays =
          typeof params.recentDays === "number" && Number.isFinite(params.recentDays)
            ? Math.max(1, Math.floor(params.recentDays))
            : undefined;
        const maxMemories =
          typeof params.maxMemories === "number" && Number.isFinite(params.maxMemories)
            ? Math.max(1, Math.floor(params.maxMemories))
            : undefined;
        const batchSize =
          typeof params.batchSize === "number" && Number.isFinite(params.batchSize)
            ? Math.max(1, Math.floor(params.batchSize))
            : undefined;

        const result = await runMemoryGovernance({
          memoryDir: storage.dir,
          mode,
          recentDays,
          maxMemories,
          batchSize,
        });

        return toolJsonResult({
          runId: result.runId,
          traceId: result.traceId,
          mode: result.mode,
          reviewQueueCount: result.reviewQueue.length,
          proposedActionCount: result.proposedActions.length,
          appliedActionCount: result.appliedActions.length,
          summaryPath: result.summaryPath,
          reportPath: result.reportPath,
        });
      },
    },
    { name: "memory_governance_run" },
  );

  api.registerTool(
    {
      name: "memory_summarize_hourly",
      label: "Generate Hourly Summaries",
      description: `Generate hourly summaries for the previous hour's conversations across all active sessions.

Cost: Low (uses configured summary model)
Speed: Fast

Best for:
- Cron job scheduled hourly summarization
- Manual trigger to summarize recent conversations
- Building conversation summaries for context preservation`,
      parameters: Type.Object({}),
      async execute() {
        try {
          await orchestrator.summarizer.runHourly();
          return toolResult("Hourly summarization completed. Check the summaries directory for results.");
        } catch (err) {
          return toolResult(`Hourly summarization failed: ${err}`);
        }
      },
    },
    { name: "memory_summarize_hourly" },
  );

  api.registerTool(
    {
      name: "conversation_index_update",
      label: "Update Conversation Index",
      description: `Chunk recent transcript history into "conversation chunk" documents and (best-effort) update the semantic index for past-conversation recall.

This is optional and default-off (see config: conversationIndexEnabled).

Best for:
- Cron jobs to keep the conversation index fresh
- Manual rebuild after changing chunk sizes or retention`,
      parameters: Type.Object({
        sessionKey: Type.Optional(
          Type.String({
            description:
              "Session key to index. If omitted, Engram will best-effort scan transcript storage and index all discovered sessionKeys.",
          }),
        ),
        hours: Type.Optional(
          Type.Number({
            description: "How many hours of transcript history to include (default: 24).",
            minimum: 1,
            maximum: 24 * 30,
          }),
        ),
        embed: Type.Optional(
          Type.Boolean({
            description:
              "If true, run QMD embed after update for this invocation. If omitted, uses conversationIndexEmbedOnUpdate config.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.config.conversationIndexEnabled) {
          return toolResult(
            "Conversation indexing is disabled. Enable `conversationIndexEnabled: true` in the Engram plugin config to use this tool.",
          );
        }

        const { sessionKey, hours, embed } = params as { sessionKey?: string; hours?: number; embed?: boolean };
        const h = typeof hours === "number" && Number.isFinite(hours) ? hours : 24;

        if (sessionKey) {
          const res = await orchestrator.updateConversationIndex(sessionKey, h, { embed });
          if (res.skipped && res.reason === "min_interval") {
            const retrySec = Math.max(1, Math.ceil((res.retryAfterMs ?? 0) / 1000));
            return toolResult(
              `Skipped for sessionKey=${sessionKey} due to min interval. Retry in ~${retrySec}s or pass a higher interval config.`,
            );
          }
          return toolResult(
            `Indexed ${res.chunks} chunk(s) for sessionKey=${sessionKey}.${res.embedded ? " Ran embed." : ""}`,
          );
        }

        const sessions = await orchestrator.transcript.listSessionKeys();
        let total = 0;
        let skipped = 0;
        const skippedIds: string[] = [];
        let embeddedRuns = 0;
        for (const sk of sessions) {
          const res = await orchestrator.updateConversationIndex(sk, h, { embed });
          total += res.chunks;
          if (res.skipped) {
            skipped += 1;
            skippedIds.push(sk);
          }
          if (res.embedded) embeddedRuns += 1;
        }
        const skippedSummary =
          skipped > 0
            ? ` Skipped ${skipped} session(s) due to min-interval gating: ${skippedIds.slice(0, 6).join(", ")}${skippedIds.length > 6 ? "..." : ""}.`
            : "";
        const embedSummary = embeddedRuns > 0 ? ` Ran embed for ${embeddedRuns} session update(s).` : "";
        return toolResult(
          `Indexed ${total} total chunk(s) across ${sessions.length} session(s).${skippedSummary}${embedSummary}`,
        );
      },
    },
    { name: "conversation_index_update" },
  );

  api.registerTool(
    {
      name: "work_task",
      label: "Manage Work Tasks",
      description:
        "Manage Engram work-layer tasks (create, get, list, update, transition, delete). Responses are marked as work-layer context and excluded from default memory extraction.",
      parameters: Type.Object({
        action: Type.String({
          enum: ["create", "get", "list", "update", "transition", "delete"],
          description: "Task action to run.",
        }),
        id: Type.Optional(Type.String({ description: "Task ID for get/update/transition/delete." })),
        title: Type.Optional(Type.String({ description: "Task title (create/update)." })),
        description: Type.Optional(Type.String({ description: "Task description (create/update)." })),
        status: Type.Optional(Type.String({ enum: ["todo", "in_progress", "blocked", "done", "cancelled"] })),
        priority: Type.Optional(Type.String({ enum: ["low", "medium", "high"] })),
        owner: Type.Optional(Type.String()),
        assignee: Type.Optional(Type.String()),
        projectId: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
        dueAt: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params) {
        const p = params as Record<string, unknown>;
        const action = String(p.action ?? "");
        const storage = new WorkStorage(orchestrator.config.memoryDir);
        try {
          await storage.ensureDirectories();
          if (action === "create") {
            if (typeof p.title !== "string" || p.title.trim().length === 0) {
              return workLayerTextResult("work_task.create requires non-empty `title`.");
            }
            const status = parseEnumParam<TaskStatus>(p, "status", WORK_TASK_STATUSES);
            if (!status.ok) return workLayerTextResult(`work_task.create received ${status.message}`);
            const priority = parseEnumParam<TaskPriority>(p, "priority", WORK_TASK_PRIORITIES);
            if (!priority.ok) return workLayerTextResult(`work_task.create received ${priority.message}`);
            const created = await storage.createTask({
              title: p.title,
              description: typeof p.description === "string" ? p.description : undefined,
              status: status.value,
              priority: priority.value,
              owner: asNonEmptyString(p.owner),
              assignee: asNonEmptyString(p.assignee),
              projectId: asNonEmptyString(p.projectId),
              tags: Array.isArray(p.tags) ? p.tags.filter((x): x is string => typeof x === "string") : undefined,
              dueAt: asNonEmptyString(p.dueAt),
            });
            return toolJsonResult({ action, task: created });
          }

          if (action === "get") {
            const taskId = asNonEmptyString(p.id);
            if (!taskId) {
              return workLayerTextResult("work_task.get requires `id`.");
            }
            const task = await storage.getTask(taskId);
            return toolJsonResult({ action, task });
          }

          if (action === "list") {
            const status = parseEnumParam<TaskStatus>(p, "status", WORK_TASK_STATUSES);
            if (!status.ok) return workLayerTextResult(`work_task.list received ${status.message}`);
            const tasks = await storage.listTasks({
              status: status.value,
              owner: asNonEmptyString(p.owner),
              assignee: asNonEmptyString(p.assignee),
              projectId: asNonEmptyString(p.projectId),
            });
            return toolJsonResult({ action, count: tasks.length, tasks });
          }

          if (action === "update") {
            const taskId = asNonEmptyString(p.id);
            if (!taskId) {
              return workLayerTextResult("work_task.update requires `id`.");
            }
            const patch: Record<string, unknown> = {};
            if (typeof p.title === "string") patch.title = p.title;
            if (typeof p.description === "string") patch.description = p.description;
            const status = parseEnumParam<TaskStatus>(p, "status", WORK_TASK_STATUSES);
            if (!status.ok) return workLayerTextResult(`work_task.update received ${status.message}`);
            if (status.value) patch.status = status.value;
            const priority = parseEnumParam<TaskPriority>(p, "priority", WORK_TASK_PRIORITIES);
            if (!priority.ok) return workLayerTextResult(`work_task.update received ${priority.message}`);
            if (priority.value) patch.priority = priority.value;
            const owner = asNullablePatchString(p, "owner");
            if (owner !== undefined) patch.owner = owner;
            const assignee = asNullablePatchString(p, "assignee");
            if (assignee !== undefined) patch.assignee = assignee;
            const projectIdPatch = asNullablePatchString(p, "projectId");
            if (projectIdPatch !== undefined) patch.projectId = projectIdPatch;
            if (Array.isArray(p.tags)) patch.tags = p.tags.filter((x): x is string => typeof x === "string");
            const dueAt = asNullablePatchString(p, "dueAt");
            if (dueAt !== undefined) patch.dueAt = dueAt;
            const updated = await storage.updateTask(taskId, patch as any);
            return toolJsonResult({ action, task: updated });
          }

          if (action === "transition") {
            const taskId = asNonEmptyString(p.id);
            const rawStatus = asNonEmptyString(p.status);
            if (!taskId || !rawStatus) {
              return workLayerTextResult("work_task.transition requires `id` and `status`.");
            }
            const status = asTaskStatus(rawStatus);
            if (!status) {
              return workLayerTextResult("work_task.transition received invalid `status`.");
            }
            const task = await storage.transitionTask(taskId, status);
            return toolJsonResult({ action, task });
          }

          if (action === "delete") {
            const taskId = asNonEmptyString(p.id);
            if (!taskId) {
              return workLayerTextResult("work_task.delete requires `id`.");
            }
            const deleted = await storage.deleteTask(taskId);
            return toolJsonResult({ action, deleted });
          }

          return workLayerTextResult(`Unsupported work_task action: ${action}`);
        } catch (err) {
          return workLayerTextResult(`work_task error: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
    { name: "work_task" },
  );

  api.registerTool(
    {
      name: "work_project",
      label: "Manage Work Projects",
      description:
        "Manage Engram work-layer projects (create, get, list, update, delete, link_task). Responses are marked as work-layer context and excluded from default memory extraction.",
      parameters: Type.Object({
        action: Type.String({
          enum: ["create", "get", "list", "update", "delete", "link_task"],
          description: "Project action to run.",
        }),
        id: Type.Optional(Type.String({ description: "Project ID for get/update/delete." })),
        name: Type.Optional(Type.String({ description: "Project name (create/update)." })),
        description: Type.Optional(Type.String({ description: "Project description (create/update)." })),
        status: Type.Optional(Type.String({ enum: ["active", "on_hold", "completed", "archived"] })),
        owner: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
        taskId: Type.Optional(Type.String({ description: "Task ID for link_task action." })),
        projectId: Type.Optional(Type.String({ description: "Project ID for link_task action." })),
      }),
      async execute(_toolCallId, params) {
        const p = params as Record<string, unknown>;
        const action = String(p.action ?? "");
        const storage = new WorkStorage(orchestrator.config.memoryDir);
        try {
          await storage.ensureDirectories();
          if (action === "create") {
            if (typeof p.name !== "string" || p.name.trim().length === 0) {
              return workLayerTextResult("work_project.create requires non-empty `name`.");
            }
            const status = parseEnumParam<ProjectStatus>(p, "status", WORK_PROJECT_STATUSES);
            if (!status.ok) return workLayerTextResult(`work_project.create received ${status.message}`);
            const project = await storage.createProject({
              name: p.name,
              description: typeof p.description === "string" ? p.description : undefined,
              status: status.value,
              owner: asNonEmptyString(p.owner),
              tags: Array.isArray(p.tags) ? p.tags.filter((x): x is string => typeof x === "string") : undefined,
            });
            return toolJsonResult({ action, project });
          }

          if (action === "get") {
            const projectId = asNonEmptyString(p.id);
            if (!projectId) {
              return workLayerTextResult("work_project.get requires `id`.");
            }
            const project = await storage.getProject(projectId);
            return toolJsonResult({ action, project });
          }

          if (action === "list") {
            const projects = await storage.listProjects();
            return toolJsonResult({ action, count: projects.length, projects });
          }

          if (action === "update") {
            const projectId = asNonEmptyString(p.id);
            if (!projectId) {
              return workLayerTextResult("work_project.update requires `id`.");
            }
            const patch: Record<string, unknown> = {};
            if (typeof p.name === "string") patch.name = p.name;
            if (typeof p.description === "string") patch.description = p.description;
            const status = parseEnumParam<ProjectStatus>(p, "status", WORK_PROJECT_STATUSES);
            if (!status.ok) return workLayerTextResult(`work_project.update received ${status.message}`);
            if (status.value) patch.status = status.value;
            const owner = asNullablePatchString(p, "owner");
            if (owner !== undefined) patch.owner = owner;
            if (Array.isArray(p.tags)) patch.tags = p.tags.filter((x): x is string => typeof x === "string");
            const project = await storage.updateProject(projectId, patch as any);
            return toolJsonResult({ action, project });
          }

          if (action === "delete") {
            const projectId = asNonEmptyString(p.id);
            if (!projectId) {
              return workLayerTextResult("work_project.delete requires `id`.");
            }
            const deleted = await storage.deleteProject(projectId);
            return toolJsonResult({ action, deleted });
          }

          if (action === "link_task") {
            const taskId = asNonEmptyString(p.taskId);
            const projectId = asNonEmptyString(p.projectId);
            if (!taskId || !projectId) {
              return workLayerTextResult("work_project.link_task requires `taskId` and `projectId`.");
            }
            const linked = await storage.linkTaskToProject(taskId, projectId);
            return toolJsonResult({ action, linked });
          }

          return workLayerTextResult(`Unsupported work_project action: ${action}`);
        } catch (err) {
          return workLayerTextResult(`work_project error: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
    { name: "work_project" },
  );

  api.registerTool(
    {
      name: "work_board",
      label: "Work Board Import/Export",
      description:
        "Export/import work-layer board snapshots and markdown. Outputs are marked as work-layer context and excluded from default memory extraction unless explicitly linked.",
      parameters: Type.Object({
        action: Type.String({
          enum: ["export_markdown", "export_snapshot", "import_snapshot"],
          description: "Board action to run.",
        }),
        projectId: Type.Optional(Type.String({ description: "Optional project filter/id." })),
        snapshotJson: Type.Optional(Type.String({ description: "Snapshot JSON payload for import_snapshot." })),
        linkToMemory: Type.Optional(
          Type.Boolean({
            description:
              "If true, wrap output as linkable work context so extraction can retain it as long-term memory.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const p = params as Record<string, unknown>;
        const action = String(p.action ?? "");
        const projectId = asNonEmptyString(p.projectId);
        const linkToMemory = p.linkToMemory === true;
        try {
          await new WorkStorage(orchestrator.config.memoryDir).ensureDirectories();
          if (action === "export_markdown") {
            const markdown = await exportWorkBoardMarkdown({ memoryDir: orchestrator.config.memoryDir, projectId });
            return toolResult(wrapWorkLayerContext(markdown, { linkToMemory }));
          }
          if (action === "export_snapshot") {
            const snapshot = await exportWorkBoardSnapshot({ memoryDir: orchestrator.config.memoryDir, projectId });
            return toolJsonResult(snapshot, { linkToMemory });
          }
          if (action === "import_snapshot") {
            if (typeof p.snapshotJson !== "string" || p.snapshotJson.trim().length === 0) {
              return workLayerTextResult("work_board.import_snapshot requires `snapshotJson`.", { linkToMemory });
            }
            const snapshot = JSON.parse(p.snapshotJson);
            const result = await importWorkBoardSnapshot({
              memoryDir: orchestrator.config.memoryDir,
              snapshot,
              projectId: asNonEmptyString(p.projectId),
            });
            return toolJsonResult({ action, result }, { linkToMemory });
          }
          return workLayerTextResult(`Unsupported work_board action: ${action}`, { linkToMemory });
        } catch (err) {
          return workLayerTextResult(`work_board error: ${err instanceof Error ? err.message : String(err)}`, {
            linkToMemory,
          });
        }
      },
    },
    { name: "work_board" },
  );

  api.registerTool(
    {
      name: "shared_context_write_output",
      label: "Write Shared Agent Output",
      description:
        "Write an agent work product into the shared-context directory (v4.0). Other agents can read these files to coordinate without explicit message passing.",
      parameters: Type.Object({
        agentId: Type.String({ description: "Agent ID producing this output (e.g., generalist, oracle, flash)." }),
        title: Type.String({ description: "Short title for the output." }),
        content: Type.String({ description: "Markdown content to write." }),
      }),
      async execute(_toolCallId, params) {
        const { agentId, title, content } = params as { agentId: string; title: string; content: string };
        if (!orchestrator.sharedContext) {
          return toolResult(
            "Shared context is disabled. Enable `sharedContextEnabled: true` to use shared-context tools.",
          );
        }
        const fp = await orchestrator.sharedContext.writeAgentOutput({ agentId, title, content });
        return toolResult(`Wrote shared agent output: ${fp}`);
      },
    },
    { name: "shared_context_write_output" },
  );

  api.registerTool(
    {
      name: "shared_feedback_record",
      label: "Record Shared Feedback",
      description:
        "Append an approval/rejection decision into shared-context feedback inbox (v4.0/v5.0). Intended to power compounding learning.",
      parameters: Type.Object({
        agent: Type.String({ description: "Agent name that produced the recommendation/output." }),
        decision: Type.String({
          enum: ["approved", "approved_with_feedback", "rejected"],
          description: "Decision outcome.",
        }),
        reason: Type.String({ description: "Why the decision was made (short but specific)." }),
        date: Type.Optional(Type.String({ description: "ISO timestamp. Defaults to now." })),
        learning: Type.Optional(Type.String({ description: "Optional distilled learning/pattern." })),
        outcome: Type.Optional(Type.String({ description: "Optional downstream outcome (day-one supported; may be empty initially)." })),
        severity: Type.Optional(Type.String({
          enum: ["low", "medium", "high"],
          description: "Optional severity rating for the mistake/outcome.",
        })),
        confidence: Type.Optional(Type.Number({ description: "Optional confidence score from 0 to 1." })),
        workflow: Type.Optional(Type.String({ description: "Optional workflow or playbook name associated with the feedback." })),
        tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags for rubric grouping and recall matching." })),
        evidenceWindowStart: Type.Optional(Type.String({ description: "Optional start timestamp for the evidence window." })),
        evidenceWindowEnd: Type.Optional(Type.String({ description: "Optional end timestamp for the evidence window." })),
        refs: Type.Optional(Type.Array(Type.String(), { description: "Optional references (URLs, IDs, filenames)." })),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.sharedContext) {
          return toolResult(
            "Shared context is disabled. Enable `sharedContextEnabled: true` to record shared feedback.",
          );
        }
        const p = params as any;
        const entry = {
          agent: String(p.agent ?? ""),
          decision: p.decision as "approved" | "approved_with_feedback" | "rejected",
          reason: String(p.reason ?? ""),
          date: typeof p.date === "string" && p.date.length > 0 ? p.date : new Date().toISOString(),
          learning: typeof p.learning === "string" ? p.learning : undefined,
          outcome: typeof p.outcome === "string" ? p.outcome : undefined,
          severity: p.severity === "low" || p.severity === "medium" || p.severity === "high" ? p.severity : undefined,
          confidence: typeof p.confidence === "number" && Number.isFinite(p.confidence) ? p.confidence : undefined,
          workflow: typeof p.workflow === "string" ? p.workflow : undefined,
          tags: Array.isArray(p.tags) ? p.tags.map(String) : undefined,
          evidenceWindowStart: typeof p.evidenceWindowStart === "string" ? p.evidenceWindowStart : undefined,
          evidenceWindowEnd: typeof p.evidenceWindowEnd === "string" ? p.evidenceWindowEnd : undefined,
          refs: Array.isArray(p.refs) ? p.refs.map(String) : undefined,
        };
        await orchestrator.sharedContext.appendFeedback(entry);
        return toolResult("OK");
      },
    },
    { name: "shared_feedback_record" },
  );

  api.registerTool(
    {
      name: "shared_priorities_append",
      label: "Append Priorities Inbox",
      description:
        "Append text into shared-context priorities inbox. A curator run should merge this into priorities.md.",
      parameters: Type.Object({
        agentId: Type.String({ description: "Agent ID appending priorities." }),
        text: Type.String({ description: "Priority notes to append (markdown)." }),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.sharedContext) {
          return toolResult(
            "Shared context is disabled. Enable `sharedContextEnabled: true` to write priorities inbox.",
          );
        }
        const { agentId, text } = params as { agentId: string; text: string };
        await orchestrator.sharedContext.appendPrioritiesInbox({ agentId, text });
        return toolResult("OK");
      },
    },
    { name: "shared_priorities_append" },
  );

  api.registerTool(
    {
      name: "shared_context_cross_signals_run",
      label: "Run Cross-Signal Synthesis",
      description:
        "Generate today's shared-context cross-signal markdown + JSON artifacts on demand, without requiring a full roundtable curation pass.",
      parameters: Type.Object({
        date: Type.Optional(Type.String({ description: "YYYY-MM-DD. Defaults to today." })),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.sharedContext) {
          return toolResult(
            "Shared context is disabled. Enable `sharedContextEnabled: true` to synthesize cross-signals.",
          );
        }
        const { date } = params as { date?: string };
        const result = await orchestrator.sharedContext.synthesizeCrossSignals({ date });
        return toolResult(
          [
            `Cross-signals markdown: ${result.crossSignalsMarkdownPath}`,
            `Cross-signals JSON: ${result.crossSignalsPath}`,
            `Source outputs analyzed: ${result.report.sourceCount}`,
            `Feedback entries analyzed: ${result.report.feedbackCount}`,
            `Overlap count: ${result.overlapCount}`,
          ].join("\n"),
        );
      },
    },
    { name: "shared_context_cross_signals_run" },
  );

  api.registerTool(
    {
      name: "shared_context_curate_daily",
      label: "Curate Daily Roundtable",
      description:
        "Curator tool: generate today's roundtable summary in shared-context/roundtable (deterministic baseline).",
      parameters: Type.Object({
        date: Type.Optional(Type.String({ description: "YYYY-MM-DD. Defaults to today." })),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.sharedContext) {
          return toolResult(
            "Shared context is disabled. Enable `sharedContextEnabled: true` to curate roundtables.",
          );
        }
        const { date } = params as { date?: string };
        const result = await orchestrator.sharedContext.curateDaily({ date });
        return toolResult(
          [
            `Roundtable: ${result.roundtablePath}`,
            `Cross-signals markdown: ${result.crossSignalsMarkdownPath}`,
            `Cross-signals JSON: ${result.crossSignalsPath}`,
            `Overlap count: ${result.overlapCount}`,
          ].join("\n"),
        );
      },
    },
    { name: "shared_context_curate_daily" },
  );

  api.registerTool(
    {
      name: "compounding_weekly_synthesize",
      label: "Synthesize Weekly Learning",
      description:
        "Generate weekly compounding outputs (v5.0): weekly markdown + JSON reports, stable mistake registry, and rubric artifacts. Designed to work from day one (writes even if no feedback exists yet).",
      parameters: Type.Object({
        weekId: Type.Optional(
          Type.String({
            description:
              "ISO week ID like YYYY-Www. Omit to use current week.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.compounding) {
          return toolResult(
            "Compounding engine is disabled. Enable `compoundingEnabled: true` to use this tool.",
          );
        }
        const { weekId } = params as { weekId?: string };
        const res = await orchestrator.compounding.synthesizeWeekly({ weekId });
        return toolResult(
          `OK\n\nweekId: ${res.weekId}\nreport: ${res.reportPath}\nreportJson: ${res.reportJsonPath}\nrubrics: ${res.rubricsPath}\nrubricsIndex: ${res.rubricsIndexPath}\nmistakes: ${res.mistakesCount} patterns\npromotionCandidates: ${res.promotionCandidateCount}`,
        );
      },
    },
    { name: "compounding_weekly_synthesize" },
  );

  api.registerTool(
    {
      name: "compounding_promote_candidate",
      label: "Promote Compounding Candidate",
      description:
        "Persist one advisory compounding promotion candidate into durable rule/principle memory. Never auto-promotes; this is an explicit operator action.",
      parameters: Type.Object({
        weekId: Type.String({
          description: "ISO week ID like YYYY-Www matching the synthesized weekly artifact.",
        }),
        candidateId: Type.String({
          description: "Promotion candidate id from the weekly compounding report or JSON artifact.",
        }),
        dryRun: Type.Optional(Type.Boolean({
          description: "If true, preview the promoted guidance without writing memory.",
        })),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.compounding) {
          return toolResult(
            "Compounding engine is disabled. Enable `compoundingEnabled: true` to use this tool.",
          );
        }
        const { weekId, candidateId, dryRun } = params as {
          weekId: string;
          candidateId: string;
          dryRun?: boolean;
        };
        const result = await orchestrator.compounding.promoteCandidate({ weekId, candidateId, dryRun });
        return toolResult(JSON.stringify(result, null, 2));
      },
    },
    { name: "compounding_promote_candidate" },
  );

  // ── Profiling Report ──────────────────────────────────────────────────
  api.registerTool(
    {
      name: "remnic_profiling_report",
      label: "Profiling Report",
      description: `Returns timing and performance data for Engram's recall and extraction pipelines.

Requires profilingEnabled: true in plugin config.

Shows per-step timing with parallel vs sequential structure, bottleneck identification, and aggregate stats.

Returns: Performance trace data with timing breakdown`,
      parameters: Type.Object({
        format: Type.Optional(
          Type.String({
            description: 'Output format: "ascii" for human-readable or "json" for structured data',
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            description: "Number of recent traces to include (1-20, default 5)",
            minimum: 1,
            maximum: 20,
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const profiler = orchestrator.profiler;
        if (!profiler.isEnabled) {
          return toolResult(
            "Profiling is disabled. Set profilingEnabled: true in your plugin config to enable.",
          );
        }

        const format = asNonEmptyString(params.format) ?? "ascii";
        const limit = normalizeProfilingReportLimit(params.limit);
        const traces = profiler.getRecentTraces(limit);
        const stats = profiler.getStats();
        const bottleneck = profiler.identifyBottleneck();

        if (format === "json") {
          return toolResult(JSON.stringify({ traces, stats, bottleneck }, null, 2));
        }

        // ASCII format
        const lines: string[] = [];
        lines.push("Engram Profiling Report");
        lines.push("=".repeat(60));
        lines.push("");

        // Stats summary — stats is { byKind: Record<string, …>, bySpan: Record<string, …> }
        type BucketEntry = { count: number; avgMs: number; p50Ms: number; p95Ms: number; maxMs: number };
        const allBuckets: Array<[string, Record<string, BucketEntry>]> = [
          ["byKind", stats.byKind],
          ["bySpan", stats.bySpan],
        ];
        const hasStats = allBuckets.some(([, entries]) => Object.keys(entries).length > 0);
        if (hasStats) {
          lines.push("Aggregate Stats (all retained traces):");
          for (const [bucket, entries] of allBuckets) {
            for (const [key, s] of Object.entries(entries)) {
              lines.push(
                `  ${bucket}/${key}: avg=${s.avgMs}ms p50=${s.p50Ms}ms p95=${s.p95Ms}ms max=${s.maxMs}ms (n=${s.count})`,
              );
            }
          }
          lines.push("");
        }

        if (bottleneck) {
          lines.push(`Bottleneck: ${bottleneck}`);
          lines.push("");
        }

        if (traces.length === 0) {
          lines.push("No traces recorded yet. Trigger a recall or extraction to see timing data.");
        } else {
          for (const trace of traces) {
            lines.push(formatProfileTraceAscii(trace));
            lines.push("");
          }
        }

        return toolResult(lines.join("\n"));
      },
    },
    { name: "remnic_profiling_report" },
  );
  api.registerTool(
    {
      name: "engram_profiling_report",
      label: "Profiling Report",
      description: `Legacy alias for remnic_profiling_report.`,
      parameters: Type.Object({
        format: Type.Optional(
          Type.String({
            description: 'Output format: "ascii" for human-readable or "json" for structured data',
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            description: "Number of recent traces to include (1-20, default 5)",
            minimum: 1,
            maximum: 20,
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const profiler = orchestrator.profiler;
        if (!profiler.isEnabled) {
          return toolResult(
            "Profiling is disabled. Set profilingEnabled: true in your plugin config to enable.",
          );
        }

        const format = asNonEmptyString(params.format) ?? "ascii";
        const limit = normalizeProfilingReportLimit(params.limit);
        const traces = profiler.getRecentTraces(limit);
        const stats = profiler.getStats();
        const bottleneck = profiler.identifyBottleneck();

        if (format === "json") {
          return toolResult(JSON.stringify({ traces, stats, bottleneck }, null, 2));
        }

        const lines: string[] = [];
        lines.push("Engram Profiling Report");
        lines.push("=".repeat(60));
        lines.push("");

        type BucketEntry = { count: number; avgMs: number; p50Ms: number; p95Ms: number; maxMs: number };
        const allBuckets: Array<[string, Record<string, BucketEntry>]> = [
          ["byKind", stats.byKind],
          ["bySpan", stats.bySpan],
        ];
        const hasStats = allBuckets.some(([, entries]) => Object.keys(entries).length > 0);
        if (hasStats) {
          lines.push("Aggregate Stats (all retained traces):");
          for (const [bucket, entries] of allBuckets) {
            for (const [key, s] of Object.entries(entries)) {
              lines.push(
                `  ${bucket}/${key}: avg=${s.avgMs}ms p50=${s.p50Ms}ms p95=${s.p95Ms}ms max=${s.maxMs}ms (n=${s.count})`,
              );
            }
          }
          lines.push("");
        }

        if (bottleneck) {
          lines.push(`Bottleneck: ${bottleneck}`);
          lines.push("");
        }

        if (traces.length === 0) {
          lines.push("No traces recorded yet. Trigger a recall or extraction to see timing data.");
        } else {
          for (const trace of traces) {
            lines.push(formatProfileTraceAscii(trace));
            lines.push("");
          }
        }

        return toolResult(lines.join("\n"));
      },
    },
    { name: "engram_profiling_report" },
  );
}
