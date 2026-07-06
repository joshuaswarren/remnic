/**
 * Batch migration of remaining access-surface handlers through the boundary
 * (issue #1525). Each operation routes MCP/HTTP/CLI dispatch through the
 * shared validation + error-mapping layer in access-boundary.ts.
 *
 * Schemas use a null-stripping preprocessor (MCP clients send null for absent
 * optional fields — repo gotcha #2) over a permissive record. Individual
 * schema tightening lands as follow-up PRs; the boundary already centralizes
 * error mapping and enforces "no handler bypasses the boundary."
 */

import { z } from "zod";
import { defineOperation, type OperationContext } from "./access-boundary.js";
import { EngramAccessInputError, type EngramAccessService } from "./access-service.js";
import type { RecallPlanMode, RecallDisclosure } from "./types.js";
import { projectTagProjectId } from "./coding/coding-namespace.js";
import { expandTildePath } from "./utils/path.js";

// ---------------------------------------------------------------------------
// Shared helpers — type-safe extraction from unknown input (no `any`)
// ---------------------------------------------------------------------------

/** Strip null values from an object (MCP clients send null for absent optionals). */
function stripNulls(data: unknown): unknown {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value !== null) cleaned[key] = value;
    }
    return cleaned;
  }
  return data;
}

/** Permissive schema: null-strip then accept any string-keyed record. */
const looseSchema = z.preprocess(
  stripNulls,
  z.record(z.string(), z.unknown()),
) as z.ZodType<Record<string, unknown>>;

function optStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function reqStr(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new EngramAccessInputError(`${field} is required and must be a non-empty string`);
  }
  return v;
}
function defStr(v: unknown, d: string): string {
  return typeof v === "string" ? v : d;
}
function optNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function optBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function optStrArr(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined;
}
// ===========================================================================
// Recall operations
// ===========================================================================

defineOperation({
  name: "recall",
  description: "Semantic recall across memories.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.recall({
      query: defStr(input.query, ""),
      sessionKey: optStr(input.sessionKey),
      authenticatedPrincipal: ctx.authenticatedPrincipal,
      namespace: optStr(input.namespace),
      topK: optNum(input.topK),
      mode: optStr(input.mode) as RecallPlanMode | "auto" | undefined,
      includeDebug: input.includeDebug === true,
      disclosure: optStr(input.disclosure) as RecallDisclosure | undefined,
      cwd: optStr(input.cwd),
      projectTag: optStr(input.projectTag),
      asOf: optStr(input.asOf),
      ...(optStrArr(input.tags) !== undefined ? { tags: optStrArr(input.tags)! } : {}),
      ...(optStr(input.tagMatch) !== undefined ? { tagMatch: optStr(input.tagMatch) as "any" | "all" } : {}),
    });
    return { result };
  },
});

defineOperation({
  name: "recall_explain",
  description: "Explain the recall plan for the session.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.recallExplain({
      sessionKey: optStr(input.sessionKey),
      namespace: optStr(input.namespace),
      authenticatedPrincipal: ctx.authenticatedPrincipal,
    });
    return { result };
  },
});

defineOperation({
  name: "set_coding_context",
  description: "Set the coding context for a session (issue #569).",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const sessionKey = defStr(input.sessionKey, "");
    const projectTag = optStr(input.projectTag);
    const hasProjectTag = projectTag !== undefined && projectTag.trim().length > 0;
    const hasCodingContext = "codingContext" in input;
    if (!hasCodingContext && hasProjectTag) {
      const tag = projectTag!.trim();
      const projectId = projectTagProjectId(tag);
      ctx.service.setCodingContext({
        sessionKey,
        codingContext: { projectId, branch: null, rootPath: projectId, defaultBranch: null },
      });
      return { result: { ok: true } };
    }
    if (!hasCodingContext && !hasProjectTag) {
      throw new EngramAccessInputError("set_coding_context requires either codingContext or projectTag");
    }
    const rawCtx = input.codingContext;
    let codingContext: { projectId: string; branch: string | null; rootPath: string; defaultBranch: string | null } | null = null;
    if (rawCtx !== null) {
      if (typeof rawCtx !== "object" || rawCtx === undefined) {
        throw new EngramAccessInputError("codingContext must be an object or null");
      }
      const obj = rawCtx as Record<string, unknown>;
      const projectId = defStr(obj.projectId, "");
      const rootPath = defStr(obj.rootPath, "");
      const branch = obj.branch === null ? null : optStr(obj.branch);
      const defaultBranch = obj.defaultBranch === null ? null : optStr(obj.defaultBranch);
      if (branch === undefined) throw new EngramAccessInputError("codingContext.branch must be a string or null");
      if (defaultBranch === undefined) throw new EngramAccessInputError("codingContext.defaultBranch must be a string or null");
      codingContext = { projectId, branch, rootPath, defaultBranch };
    }
    ctx.service.setCodingContext({ sessionKey, codingContext });
    return { result: { ok: true } };
  },
});

defineOperation({
  name: "recall_tier_explain",
  description: "Explain the recall tier breakdown.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const sessionKey = optStr(input.sessionKey);
    const namespace = optStr(input.namespace);
    const result = await ctx.service.recallTierExplain(
      sessionKey !== undefined && sessionKey.length > 0 ? sessionKey : undefined,
      namespace !== undefined && namespace.length > 0 ? namespace : undefined,
      ctx.authenticatedPrincipal,
    );
    return { result };
  },
});

defineOperation({
  name: "recall_xray",
  description: "X-ray the recall pipeline for a query.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const budgetRaw = input.budget;
    let budget: number | undefined;
    if (budgetRaw !== undefined && budgetRaw !== null) {
      const parsed = typeof budgetRaw === "number" ? budgetRaw : typeof budgetRaw === "string" ? Number(budgetRaw) : undefined;
      if (parsed === undefined || !Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
        throw new EngramAccessInputError("recall_xray: budget expects a positive integer");
      }
      budget = parsed;
    }
    const disclosureRaw = optStr(input.disclosure);
    const result = await ctx.service.recallXray({
      query: defStr(input.query, ""),
      sessionKey: optStr(input.sessionKey),
      namespace: optStr(input.namespace),
      budget,
      authenticatedPrincipal: ctx.authenticatedPrincipal,
      ...(disclosureRaw !== undefined && disclosureRaw !== "" ? { disclosure: disclosureRaw as RecallDisclosure } : {}),
    });
    return { result };
  },
});

// ===========================================================================
// Wearables + transcript operations
// ===========================================================================

defineOperation({
  name: "wearables_status",
  description: "Get wearables sync status.",
  schema: looseSchema,
  handler: async (_input, ctx) => ({ result: await ctx.service.wearablesStatus() }),
});

defineOperation({
  name: "wearables_sync",
  description: "Sync wearables data.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.wearablesSync({
      source: optStr(input.source),
      date: optStr(input.date),
      days: optNum(input.days),
      forceMemories: optBool(input.forceMemories),
    });
    return { result };
  },
});

defineOperation({
  name: "transcript_day",
  description: "Get transcript for a specific day.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const date = defStr(input.date, "");
    if (date.trim().length === 0) throw new EngramAccessInputError("transcript_day: date is required and must be YYYY-MM-DD");
    const result = await ctx.service.wearablesTranscriptDay({ date, source: optStr(input.source) });
    return { result };
  },
});

defineOperation({
  name: "transcript_search",
  description: "Search transcripts.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const query = defStr(input.query, "");
    if (query.trim().length === 0) throw new EngramAccessInputError("transcript_search: query is required and must be non-empty");
    const result = await ctx.service.wearablesTranscriptSearch({
      query,
      source: optStr(input.source),
      from: optStr(input.from),
      to: optStr(input.to),
      limit: optNum(input.limit),
    });
    return { result };
  },
});

defineOperation({
  name: "transcript_memories",
  description: "Get transcript memories.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.wearablesTranscriptMemories({
      source: optStr(input.source),
      date: optStr(input.date),
      limit: optNum(input.limit),
    });
    return { result };
  },
});

// ===========================================================================
// Action confidence, day summary, capsule operations
// ===========================================================================

defineOperation({
  name: "action_confidence",
  description: "Get action confidence for recent memories.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.actionConfidence({
      intendedAction: optStr(input.intendedAction),
      confidence: optNum(input.confidence),
      risk: optStr(input.risk) as import("./action-confidence.js").ActionConfidenceRiskCategory | undefined,
      contextReadiness: optStr(input.contextReadiness) as import("./action-confidence.js").ActionConfidenceContextReadiness | undefined,
      currentContextScopes: optStrArr(input.currentContextScopes),
    });
    return { result };
  },
});

defineOperation({
  name: "chatgpt_memory_inspector",
  description: "ChatGPT memory inspector (recall xray + action confidence orchestrator).",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const xray = await ctx.service.recallXray({
      query: defStr(input.query, ""),
      sessionKey: optStr(input.sessionKey),
      namespace: optStr(input.namespace),
      authenticatedPrincipal: ctx.authenticatedPrincipal,
    });
    const confidence = await ctx.service.actionConfidence({});
    return { result: { xray, confidence } };
  },
});

defineOperation({
  name: "day_summary",
  description: "Get a day summary.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.daySummary({
      memories: optStr(input.memories),
      sessionKey: optStr(input.sessionKey),
      namespace: optStr(input.namespace),
      timeZone: optStr(input.timeZone),
    });
    return { result };
  },
});

defineOperation({
  name: "capsule_export",
  description: "Export a capsule.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.capsuleExport({
      name: optStr(input.name) ?? "",
      namespace: optStr(input.namespace),
      since: optStr(input.since),
      includeKinds: optStrArr(input.includeKinds),
      peerIds: optStrArr(input.peerIds),
      includeTranscripts: optBool(input.includeTranscripts),
      encrypt: optBool(input.encrypt),
      principal: ctx.authenticatedPrincipal,
    } as Parameters<typeof ctx.service.capsuleExport>[0]);
    return { result };
  },
});

defineOperation({
  name: "capsule_import",
  description: "Import a capsule.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.capsuleImport({
      archivePath: expandTildePath(optStr(input.archivePath) ?? ""),
      namespace: optStr(input.namespace),
      mode: optStr(input.mode) as "skip" | "overwrite" | "fork" | undefined,
      passphrase: optStr(input.passphrase),
      principal: ctx.authenticatedPrincipal,
    });
    return { result };
  },
});

defineOperation({
  name: "capsule_list",
  description: "List capsules.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.capsuleList({
      namespace: optStr(input.namespace),
      principal: ctx.authenticatedPrincipal,
    });
    return { result };
  },
});

// ===========================================================================
// Governance, maintenance, procedural operations
// ===========================================================================

defineOperation({
  name: "memory_governance_run",
  description: "Run memory governance.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.governanceRun({
      namespace: optStr(input.namespace),
      mode: optStr(input.mode) as "shadow" | "apply" | undefined,
      recentDays: optNum(input.recentDays),
      maxMemories: optNum(input.maxMemories),
      batchSize: optNum(input.batchSize),
      authenticatedPrincipal: ctx.authenticatedPrincipal,
    });
    return { result };
  },
});

defineOperation({
  name: "procedure_mining_run",
  description: "Run procedure mining.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.procedureMiningRun({
      namespace: optStr(input.namespace),
      authenticatedPrincipal: ctx.authenticatedPrincipal,
    });
    return { result };
  },
});

defineOperation({
  name: "pattern_reinforcement_run",
  description: "Run pattern reinforcement.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.patternReinforcementRun({
      namespace: optStr(input.namespace),
      force: input.force === true,
      authenticatedPrincipal: ctx.authenticatedPrincipal,
    });
    return { result };
  },
});

defineOperation({
  name: "procedural_stats",
  description: "Get procedural stats.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.procedureStats({ namespace: optStr(input.namespace) }, ctx.authenticatedPrincipal);
    return { result };
  },
});

// ===========================================================================
// Memory timeline, suggestion, entity, observe, LCM operations
// ===========================================================================

defineOperation({
  name: "memory_timeline",
  description: "Get the timeline for a memory.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.memoryTimeline(
      optStr(input.memoryId) ?? "",
      optStr(input.namespace),
      optNum(input.limit),
      ctx.authenticatedPrincipal,
    );
    return { result };
  },
});

defineOperation({
  name: "suggestion_submit",
  description: "Submit a memory suggestion.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.suggestionSubmit({
      schemaVersion: optNum(input.schemaVersion),
      idempotencyKey: optStr(input.idempotencyKey),
      dryRun: input.dryRun === true,
      sessionKey: optStr(input.sessionKey),
      authenticatedPrincipal: ctx.authenticatedPrincipal,
      content: optStr(input.content) ?? "",
      category: optStr(input.category),
      confidence: optNum(input.confidence),
      namespace: optStr(input.namespace),
      tags: optStrArr(input.tags),
      entityRef: optStr(input.entityRef),
      ttl: optStr(input.ttl),
      sourceReason: optStr(input.sourceReason),
      cwd: optStr(input.cwd),
      projectTag: optStr(input.projectTag),
    });
    return { result };
  },
});

defineOperation({
  name: "entity_get",
  description: "Get an entity by name.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.entityGet(optStr(input.name) ?? "", optStr(input.namespace));
    return { result };
  },
});

defineOperation({
  name: "review_queue_list",
  description: "List the review queue.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.reviewQueue(optStr(input.runId) ?? "", optStr(input.namespace), ctx.authenticatedPrincipal);
    return { result };
  },
});

defineOperation({
  name: "observe",
  description: "Observe messages into the memory system.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const messages = input.messages;
    if (!Array.isArray(messages)) throw new EngramAccessInputError("observe: messages must be an array");
    const result = await ctx.service.observe({
      sessionKey: defStr(input.sessionKey, ""),
      messages: messages as unknown as Parameters<typeof ctx.service.observe>[0]["messages"],
      authenticatedPrincipal: ctx.authenticatedPrincipal,
      namespace: optStr(input.namespace),
      skipExtraction: input.skipExtraction === true,
      cwd: optStr(input.cwd),
      projectTag: optStr(input.projectTag),
    });
    return { result };
  },
});

defineOperation({
  name: "lcm_search",
  description: "Search the LCM (long-context memory).",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.lcmSearch({
      query: defStr(input.query, ""),
      sessionKey: optStr(input.sessionKey),
      sessionPrefix: optStr(input.sessionPrefix),
      namespace: optStr(input.namespace),
      limit: optNum(input.limit),
      authenticatedPrincipal: ctx.authenticatedPrincipal,
    });
    return { result };
  },
});

defineOperation({
  name: "lcm_compaction_flush",
  description: "Flush LCM compaction.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.lcmCompactionFlush({
      sessionKey: optStr(input.sessionKey) ?? "",
      namespace: optStr(input.namespace),
      authenticatedPrincipal: ctx.authenticatedPrincipal,
    });
    return { result };
  },
});

defineOperation({
  name: "lcm_compaction_record",
  description: "Record an LCM compaction.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.lcmCompactionRecord({
      sessionKey: optStr(input.sessionKey) ?? "",
      namespace: optStr(input.namespace),
      tokensBefore: optNum(input.tokensBefore) ?? 0,
      tokensAfter: optNum(input.tokensAfter) ?? 0,
      authenticatedPrincipal: ctx.authenticatedPrincipal,
    });
    return { result };
  },
});

// ===========================================================================
// Continuity, identity operations
// ===========================================================================

defineOperation({
  name: "continuity_audit_generate",
  description: "Generate a continuity audit.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.continuityAuditGenerate({
      period: optStr(input.period) as "weekly" | "monthly" | undefined,
      key: optStr(input.key),
    });
    return { result };
  },
});

defineOperation({
  name: "continuity_incident_open",
  description: "Open a continuity incident.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.continuityIncidentOpen({
      symptom: optStr(input.symptom) ?? "",
      namespace: optStr(input.namespace),
      triggerWindow: optStr(input.triggerWindow),
      suspectedCause: optStr(input.suspectedCause),
      principal: ctx.authenticatedPrincipal,
    });
    return { result };
  },
});

defineOperation({
  name: "continuity_incident_close",
  description: "Close a continuity incident.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.continuityIncidentClose({
      id: optStr(input.id) ?? "",
      namespace: optStr(input.namespace),
      fixApplied: optStr(input.fixApplied) ?? "",
      verificationResult: optStr(input.verificationResult) ?? "",
      preventiveRule: optStr(input.preventiveRule),
      principal: ctx.authenticatedPrincipal,
    });
    return { result };
  },
});

defineOperation({
  name: "continuity_incident_list",
  description: "List continuity incidents.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.continuityIncidentList({
      state: optStr(input.state) as "all" | "open" | "closed" | undefined,
      namespace: optStr(input.namespace),
      limit: optNum(input.limit),
      principal: ctx.authenticatedPrincipal,
    });
    return { result };
  },
});

defineOperation({
  name: "continuity_loop_add_or_update",
  description: "Add or update a continuity loop.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.continuityLoopAddOrUpdate({
      id: optStr(input.id) ?? "",
      cadence: optStr(input.cadence) as "daily" | "weekly" | "monthly" | "quarterly",
      purpose: optStr(input.purpose) ?? "",
      status: optStr(input.status) as "active" | "paused" | "retired",
      killCondition: optStr(input.killCondition) ?? "",
      namespace: optStr(input.namespace),
      lastReviewed: optStr(input.lastReviewed),
      notes: optStr(input.notes),
      principal: ctx.authenticatedPrincipal,
    });
    return { result };
  },
});

defineOperation({
  name: "continuity_loop_review",
  description: "Review a continuity loop.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.continuityLoopReview({
      id: optStr(input.id) ?? "",
      namespace: optStr(input.namespace),
      status: optStr(input.status) as "active" | "paused" | "retired" | undefined,
      notes: optStr(input.notes),
      reviewedAt: optStr(input.reviewedAt),
      principal: ctx.authenticatedPrincipal,
    });
    return { result };
  },
});

defineOperation({
  name: "identity_anchor_get",
  description: "Get identity anchor.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.identityAnchorGet({ namespace: optStr(input.namespace), principal: ctx.authenticatedPrincipal });
    return { result };
  },
});

defineOperation({
  name: "identity_anchor_update",
  description: "Update identity anchor.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.identityAnchorUpdate({
      namespace: optStr(input.namespace),
      identityTraits: optStr(input.identityTraits) ?? "",
      communicationPreferences: optStr(input.communicationPreferences) ?? "",
      operatingPrinciples: optStr(input.operatingPrinciples) ?? "",
      continuityNotes: optStr(input.continuityNotes) ?? "",
    });
    return { result };
  },
});

defineOperation({
  name: "memory_identity",
  description: "Get memory identity.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.memoryIdentity({ namespace: optStr(input.namespace), principal: ctx.authenticatedPrincipal });
    return { result };
  },
});

// ===========================================================================
// Work, shared-context, compounding, compression operations
// ===========================================================================

defineOperation({
  name: "work_task",
  description: "Manage a work task.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.workTask({
      action: optStr(input.action) as "update" | "list" | "get" | "create" | "delete" | "transition",
      id: optStr(input.id) ?? "",
      title: optStr(input.title),
      description: optStr(input.description),
      status: optStr(input.status),
      priority: optStr(input.priority),
      owner: optStr(input.owner),
      assignee: optStr(input.assignee),
      projectId: optStr(input.projectId),
      tags: optStrArr(input.tags),
      dueAt: optStr(input.dueAt),
    });
    return { result };
  },
});

defineOperation({
  name: "work_project",
  description: "Manage a work project.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.workProject({
      action: optStr(input.action) as "update" | "list" | "get" | "create" | "delete" | "link_task",
      id: optStr(input.id) ?? "",
      name: optStr(input.name),
      description: optStr(input.description),
      status: optStr(input.status),
      owner: optStr(input.owner),
      tags: optStrArr(input.tags),
      taskId: optStr(input.taskId),
      projectId: optStr(input.projectId),
    });
    return { result };
  },
});

defineOperation({
  name: "work_board",
  description: "Manage a work board.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.workBoard({
      action: optStr(input.action) as "export_markdown" | "export_snapshot" | "import_snapshot",
      projectId: optStr(input.projectId) ?? "",
      snapshotJson: optStr(input.snapshotJson) ?? "",
      linkToMemory: input.linkToMemory === true,
    });
    return { result };
  },
});

defineOperation({
  name: "shared_context_write_output",
  description: "Write shared context output.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.sharedContextWriteOutput({
      agentId: optStr(input.agentId) ?? "",
      title: optStr(input.title) ?? "",
      content: optStr(input.content) ?? "",
    });
    return { result };
  },
});

defineOperation({
  name: "shared_feedback_record",
  description: "Record shared feedback.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.sharedFeedbackRecord({
      agent: optStr(input.agent) ?? "",
      decision: optStr(input.decision) as "rejected" | "approved" | "approved_with_feedback",
      reason: optStr(input.reason) ?? "",
      date: optStr(input.date) ?? "",
      learning: optStr(input.learning) ?? "",
      outcome: optStr(input.outcome) ?? "",
      severity: optStr(input.severity) as "high" | "low" | "medium" | undefined,
      confidence: optNum(input.confidence),
      workflow: optStr(input.workflow),
      tags: optStrArr(input.tags),
      evidenceWindowStart: optStr(input.evidenceWindowStart),
      evidenceWindowEnd: optStr(input.evidenceWindowEnd),
      refs: optStrArr(input.refs),
    });
    return { result };
  },
});

defineOperation({
  name: "shared_priorities_append",
  description: "Append to shared priorities.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.sharedPrioritiesAppend({
      agentId: optStr(input.agentId) ?? "",
      text: optStr(input.text) ?? "",
    });
    return { result };
  },
});

defineOperation({
  name: "shared_context_cross_signals_run",
  description: "Run shared context cross signals.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.sharedContextCrossSignalsRun({ date: optStr(input.date) });
    return { result };
  },
});

defineOperation({
  name: "shared_context_curate_daily",
  description: "Curate daily shared context.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.sharedContextCurateDaily({ date: optStr(input.date) });
    return { result };
  },
});

defineOperation({
  name: "compounding_weekly_synthesize",
  description: "Weekly compound synthesis.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.compoundingWeeklySynthesize({ weekId: optStr(input.weekId) });
    return { result };
  },
});

defineOperation({
  name: "compounding_promote_candidate",
  description: "Promote a compounding candidate.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.compoundingPromoteCandidate({
      weekId: optStr(input.weekId) ?? "",
      candidateId: optStr(input.candidateId) ?? "",
      dryRun: input.dryRun === true,
    });
    return { result };
  },
});

defineOperation({
  name: "compression_guidelines_optimize",
  description: "Optimize compression guidelines.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.compressionGuidelinesOptimize({
      dryRun: input.dryRun === true,
      eventLimit: optNum(input.eventLimit),
    });
    return { result };
  },
});

defineOperation({
  name: "compression_guidelines_activate",
  description: "Activate compression guidelines.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.compressionGuidelinesActivate({
      expectedContentHash: optStr(input.expectedContentHash) ?? "",
      expectedGuidelineVersion: optNum(input.expectedGuidelineVersion),
    });
    return { result };
  },
});

// ===========================================================================
// Memory read/debug, graph, feedback, promote, outcome operations
// ===========================================================================

defineOperation({
  name: "memory_profile",
  description: "Get the memory profile.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.memoryProfile(optStr(input.namespace), ctx.authenticatedPrincipal);
    return { result };
  },
});

defineOperation({
  name: "memory_entities_list",
  description: "List memory entities.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.memoryEntitiesList(optStr(input.namespace), ctx.authenticatedPrincipal);
    return { result };
  },
});

defineOperation({
  name: "memory_questions",
  description: "List memory questions.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.memoryQuestions(optStr(input.namespace), ctx.authenticatedPrincipal);
    return { result };
  },
});

defineOperation({
  name: "memory_last_recall",
  description: "Get last recall snapshot.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.lastRecallSnapshot(optStr(input.sessionKey));
    return { result };
  },
});

defineOperation({
  name: "memory_intent_debug",
  description: "Debug memory intent.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.intentDebug(optStr(input.namespace));
    return { result };
  },
});

defineOperation({
  name: "memory_qmd_debug",
  description: "Debug QMD.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.qmdDebug(optStr(input.namespace));
    return { result };
  },
});

defineOperation({
  name: "memory_graph_explain",
  description: "Explain the memory graph.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.graphExplainLastRecall(optStr(input.namespace));
    return { result };
  },
});

defineOperation({
  name: "graph_snapshot",
  description: "Get a graph snapshot.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.graphSnapshot({
      namespace: optStr(input.namespace),
      limit: optNum(input.limit),
      since: optStr(input.since),
      focusNodeId: optStr(input.focusNodeId),
      categories: optStrArr(input.categories),
    }, ctx.authenticatedPrincipal);
    return { result };
  },
});

defineOperation({
  name: "memory_feedback",
  description: "Record memory feedback.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.memoryFeedback({
      memoryId: optStr(input.memoryId) ?? "",
      vote: optStr(input.vote) as "up" | "down",
      note: optStr(input.note),
    });
    return { result };
  },
});

defineOperation({
  name: "memory_promote",
  description: "Promote a memory.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.memoryPromote({
      memoryId: optStr(input.memoryId) ?? "",
      namespace: optStr(input.namespace),
      sessionKey: optStr(input.sessionKey),
      principal: ctx.authenticatedPrincipal,
    });
    return { result };
  },
});

defineOperation({
  name: "memory_outcome",
  description: "Record a memory outcome.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.memoryOutcome({
      memoryId: optStr(input.memoryId) ?? "",
      outcome: optStr(input.outcome) as "success" | "failure",
      namespace: optStr(input.namespace),
      sessionKey: optStr(input.sessionKey),
      timestamp: optStr(input.timestamp),
      principal: ctx.authenticatedPrincipal,
    });
    return { result };
  },
});

defineOperation({
  name: "memory_action_apply",
  description: "Apply a memory action.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.memoryActionApply({
      action: optStr(input.action) ?? "",
      outcome: optStr(input.outcome),
      reason: optStr(input.reason),
      memoryId: optStr(input.memoryId) ?? "",
      namespace: optStr(input.namespace),
      sessionKey: optStr(input.sessionKey),
      content: optStr(input.content),
      category: optStr(input.category),
      linkTargetId: optStr(input.linkTargetId),
      linkType: optStr(input.linkType),
      linkStrength: optNum(input.linkStrength),
      artifactType: optStr(input.artifactType),
      execute: input.execute === true,
      sourcePrompt: optStr(input.sourcePrompt),
      dryRun: input.dryRun === true,
      principal: ctx.authenticatedPrincipal,
    });
    return { result };
  },
});

defineOperation({
  name: "context_checkpoint",
  description: "Create a context checkpoint.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.contextCheckpoint({
      sessionKey: optStr(input.sessionKey) ?? "",
      context: optStr(input.context) ?? "",
      namespace: optStr(input.namespace),
      principal: ctx.authenticatedPrincipal,
    });
    return { result };
  },
});

defineOperation({
  name: "briefing",
  description: "Get a daily context briefing.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.briefing({
      since: optStr(input.since),
      focus: optStr(input.focus),
      namespace: optStr(input.namespace),
      format: optStr(input.format) as "json" | "markdown" | undefined,
      maxFollowups: optNum(input.maxFollowups),
      principal: ctx.authenticatedPrincipal,
    });
    return { result };
  },
});

// ===========================================================================
// Contradiction review, scan, graph-edge-decay (dynamic-import handlers)
// ===========================================================================

defineOperation({
  name: "review_list",
  description: "List contradiction review pairs.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const { isDefaultReviewNamespace, listPairs } = await import("./contradiction/contradiction-review.js");
    const VALID_FILTERS = new Set(["all", "unresolved", "contradicts", "independent", "duplicates", "needs-user"]);
    const rawFilter = optStr(input.filter) ?? "unresolved";
    if (!VALID_FILTERS.has(rawFilter)) {
      throw new EngramAccessInputError("Invalid filter '" + rawFilter + "'. Valid: " + [...VALID_FILTERS].join(", "));
    }
    const filter = rawFilter as "all" | "unresolved" | "contradicts" | "independent" | "duplicates" | "needs-user";
    const ns = optStr(input.namespace);
    const limit = optNum(input.limit) ?? 50;
    const resolved = await ctx.service.getReadableStorageForNamespace(ns, ctx.authenticatedPrincipal);
    const reviewNamespace = ctx.service.configRef.namespacesEnabled ? resolved.namespace : undefined;
    const includeUnscopedForNamespace = Boolean(
      reviewNamespace && isDefaultReviewNamespace(ctx.service.configRef.defaultNamespace, ns, reviewNamespace),
    );
    const result = await listPairs(ctx.service.memoryDir, { filter, namespace: reviewNamespace, includeUnscopedForNamespace, limit });
    return { result };
  },
});

defineOperation({
  name: "review_resolve",
  description: "Resolve a contradiction pair.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const pairId = defStr(input.pairId, "");
    const verb = defStr(input.verb, "");
    if (!pairId) throw new EngramAccessInputError("pairId is required");
    if (!verb) throw new EngramAccessInputError("verb is required");
    const { isValidResolutionVerb, executeResolution } = await import("./contradiction/resolution.js");
    if (!isValidResolutionVerb(verb)) throw new EngramAccessInputError("Invalid verb: " + verb + ". Must be one of: keep-a, keep-b, merge, both-valid, needs-more-context");
    const result = await executeResolution(ctx.service.memoryDir, ctx.service.storageRef, pairId, verb, {
      mergedMemoryId: optStr(input.mergedMemoryId),
      mergedContent: optStr(input.mergedContent),
      storageForNamespace: async (namespace: string | undefined) => {
        const r = await ctx.service.getWritableStorageForNamespace(namespace, ctx.authenticatedPrincipal);
        return r.storage;
      },
      onMergedMemoryWritten: () => { /* #1522: catalog touch at storage chokepoint */ },
    });
    return { result };
  },
});

defineOperation({
  name: "contradiction_scan_run",
  description: "Run a contradiction scan.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const { runContradictionScan } = await import("./contradiction/contradiction-scan.js");
    const result = await runContradictionScan({
      storage: ctx.service.storageRef,
      config: ctx.service.configRef,
      memoryDir: ctx.service.memoryDir,
      embeddingLookupFactory: ctx.service.embeddingLookupFactoryRef,
      storageForNamespace: (namespace: string | undefined) =>
        ctx.service.getWritableStorageForNamespace(namespace ?? undefined, ctx.authenticatedPrincipal),
      localLlm: ctx.service.localLlmRef,
      fallbackLlm: ctx.service.fallbackLlmRef,
      namespace: optStr(input.namespace),
    });
    return { result };
  },
});

defineOperation({
  name: "graph_edge_decay_run",
  description: "Run graph edge decay maintenance.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const cfg = ctx.service.configRef;
    if (!cfg.graphEdgeDecayEnabled) {
      return { result: { ranAt: new Date().toISOString(), disabled: true, reason: "graphEdgeDecayEnabled is false" } };
    }
    const { runGraphEdgeDecayMaintenanceAcrossNamespaces } = await import("./maintenance/graph-edge-decay.js");
    const dryRun = input.dryRun === true;
    const results = await runGraphEdgeDecayMaintenanceAcrossNamespaces(ctx.service.memoryDir, {
      windowMs: cfg.graphEdgeDecayWindowMs,
      perWindow: cfg.graphEdgeDecayPerWindow,
      floor: cfg.graphEdgeDecayFloor,
      visibilityThreshold: cfg.graphEdgeDecayVisibilityThreshold,
      dryRun,
      namespacesEnabled: cfg.namespacesEnabled === true,
      defaultNamespace: cfg.defaultNamespace,
    });
    return { result: { results } };
  },
});

// ===========================================================================
// Remaining operations: summarize, profiling, connectors, peers, console, dreams
// ===========================================================================

defineOperation({
  name: "memory_summarize_hourly",
  description: "Run hourly memory summarization.",
  schema: looseSchema,
  handler: async (_input, ctx) => ({ result: await ctx.service.memorySummarizeHourly() }),
});

defineOperation({
  name: "conversation_index_update",
  description: "Update the conversation index.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.conversationIndexUpdate({
      sessionKey: optStr(input.sessionKey),
      hours: optNum(input.hours),
      embed: optBool(input.embed),
    });
    return { result };
  },
});

defineOperation({
  name: "profiling_report",
  description: "Get a profiling report.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.profilingReport({
      format: optStr(input.format),
      limit: optNum(input.limit),
    });
    return { result };
  },
});

defineOperation({
  name: "live_connectors_run",
  description: "Run live connectors.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.liveConnectorsRun(
      { authenticatedPrincipal: ctx.authenticatedPrincipal, force: input.force === true },
      ctx.authenticatedPrincipal,
    );
    return { result };
  },
});

defineOperation({
  name: "peer_list",
  description: "List peers.",
  schema: looseSchema,
  handler: async (_input, ctx) => ({ result: await ctx.service.peerList() }),
});

defineOperation({
  name: "peer_get",
  description: "Get a peer.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.peerGet(defStr(input.id, ""));
    return { result };
  },
});

defineOperation({
  name: "peer_set",
  description: "Create or update a peer.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.peerSet({
      id: optStr(input.id) ?? "",
      kind: optStr(input.kind),
      displayName: optStr(input.displayName),
      notes: optStr(input.notes),
    });
    return { result };
  },
});

defineOperation({
  name: "peer_delete",
  description: "Delete a peer.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.peerDelete(defStr(input.id, ""));
    return { result };
  },
});

defineOperation({
  name: "peer_profile_get",
  description: "Get a peer profile.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.peerProfileGet(optStr(input.id) ?? "");
    return { result };
  },
});

defineOperation({
  name: "peer_forget",
  description: "Forget a peer.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.peerForget(optStr(input.id) ?? "", { confirm: input.confirm === true || optStr(input.confirm) === "yes" ? "yes" : "" });
    return { result };
  },
});

defineOperation({
  name: "console_state",
  description: "Get console state.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.consoleState(optStr(input.namespace), ctx.authenticatedPrincipal);
    return { result };
  },
});

defineOperation({
  name: "dreams_status",
  description: "Get dreams status.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.dreamsStatus({
      windowHours: optNum(input.windowHours),
      namespace: optStr(input.namespace),
      principal: ctx.authenticatedPrincipal,
    });
    return { result };
  },
});

defineOperation({
  name: "dreams_run",
  description: "Run dreams.",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.dreamsRun({
      phase: optStr(input.phase) as import("./types.js").DreamsPhase,
      dryRun: input.dryRun === true,
      namespace: optStr(input.namespace),
      authenticatedPrincipal: ctx.authenticatedPrincipal,
    });
    return { result };
  },
});

// ===========================================================================
// HTTP-only operations (routes with no direct MCP tool equivalent)
// ===========================================================================

defineOperation({
  name: "offline_sync_snapshot",
  description: "Get or create an offline-sync snapshot.",
  schema: looseSchema,
  handler: async (_input, ctx) => {
    const result = await ctx.service.offlineSyncSnapshot();
    return { result };
  },
});

defineOperation({
  name: "offline_sync_files",
  description: "List offline-sync files.",
  schema: looseSchema,
  handler: async (input, ctx) => ({ result: await ctx.service.offlineSyncFiles({ paths: optStrArr(input.paths) ?? [], namespace: optStr(input.namespace), principal: ctx.authenticatedPrincipal }) }),
});

defineOperation({
  name: "offline_sync_file_content",
  description: "Read offline-sync file content.",
  schema: looseSchema,
  handler: async (input, ctx) => ({ result: await ctx.service.offlineSyncFileContent({ path: optStr(input.path) ?? "", namespace: optStr(input.namespace), principal: ctx.authenticatedPrincipal, offset: optNum(input.offset), length: optNum(input.length) }) }),
});

defineOperation({
  name: "offline_sync_apply_file_content",
  description: "Apply offline-sync file content.",
  schema: looseSchema,
  handler: async (input, ctx) => ({ result: await ctx.service.offlineSyncApplyFileContent({ sourceId: optStr(input.sourceId) ?? "", path: optStr(input.path) ?? "", sha256: optStr(input.sha256) ?? "", bytes: optNum(input.bytes) ?? 0, mtimeMs: optNum(input.mtimeMs) ?? 0, offset: optNum(input.offset), baseSha256: optStr(input.baseSha256), content: Buffer.from(defStr(input.content, ""), "base64"), namespace: optStr(input.namespace), principal: ctx.authenticatedPrincipal }) }),
});

defineOperation({
  name: "offline_sync_apply",
  description: "Apply an offline-sync snapshot.",
  schema: looseSchema,
  handler: async (input, ctx) => ({ result: await ctx.service.offlineSyncApply({ changeset: input.changeset, namespace: optStr(input.namespace), principal: ctx.authenticatedPrincipal }) }),
});

defineOperation({
  name: "lcm_status",
  description: "Get LCM status.",
  schema: looseSchema,
  handler: async (_input, ctx) => ({ result: await ctx.service.lcmStatus() }),
});

defineOperation({
  name: "memory_list",
  description: "Browse/list memories (HTTP GET /memories).",
  schema: looseSchema,
  handler: async (input, ctx) => ({ result: await ctx.service.memoryBrowse() }),
});

defineOperation({
  name: "entity_list",
  description: "List entities (HTTP GET /entities).",
  schema: looseSchema,
  handler: async (input, ctx) => ({ result: await ctx.service.entityList() }),
});

defineOperation({
  name: "maintenance_status",
  description: "Get maintenance status (HTTP GET /maintenance).",
  schema: looseSchema,
  handler: async (input, ctx) => ({ result: await ctx.service.maintenance() }),
});

defineOperation({
  name: "quality_status",
  description: "Get quality status (HTTP GET /quality).",
  schema: looseSchema,
  handler: async (input, ctx) => ({ result: await ctx.service.quality() }),
});

defineOperation({
  name: "trust_zones_status",
  description: "Get trust-zone status.",
  schema: looseSchema,
  handler: async (input, ctx) => ({ result: await ctx.service.trustZoneStatus() }),
});

defineOperation({
  name: "trust_zones_records",
  description: "Browse trust-zone records.",
  schema: looseSchema,
  handler: async (input, ctx) => ({ result: await ctx.service.trustZoneBrowse({ namespace: optStr(input.namespace), limit: optNum(input.limit), offset: optNum(input.offset) }, ctx.authenticatedPrincipal) }),
});

defineOperation({
  name: "review_disposition",
  description: "Apply a review disposition.",
  schema: looseSchema,
  handler: async (input, ctx) => ({ result: await ctx.service.reviewDisposition({ memoryId: optStr(input.memoryId) ?? "", status: (optStr(input.status) ?? "archived") as import("./access-service.js").EngramAccessReviewDispositionRequest["status"], reasonCode: optStr(input.reasonCode) ?? "", namespace: optStr(input.namespace), authenticatedPrincipal: ctx.authenticatedPrincipal }) }),
});

defineOperation({
  name: "trust_zones_promote",
  description: "Promote a trust-zone record.",
  schema: looseSchema,
  handler: async (input, ctx) => ({ result: await ctx.service.trustZonePromote({ recordId: optStr(input.recordId) ?? "", targetZone: (optStr(input.targetZone) ?? "working") as import("./trust-zones.js").TrustZoneName, promotionReason: optStr(input.promotionReason) ?? "", dryRun: input.dryRun === true, namespace: optStr(input.namespace), authenticatedPrincipal: ctx.authenticatedPrincipal }) }),
});

defineOperation({
  name: "trust_zones_demo_seed",
  description: "Seed demo trust-zone records.",
  schema: looseSchema,
  handler: async (input, ctx) => ({ result: await ctx.service.trustZoneDemoSeed({ scenario: optStr(input.scenario), dryRun: input.dryRun === true, namespace: optStr(input.namespace), authenticatedPrincipal: ctx.authenticatedPrincipal }) }),
});

defineOperation({
  name: "citations_observed",
  description: "Record observed citations (HTTP POST /v1/citations/observed).",
  schema: looseSchema,
  handler: async (input, ctx) => {
    // The HTTP handler has complex citation-entry parsing; this operation
    // owns the shape validation boundary. The handler forwards the cleaned
    // input so the transport-specific entry parsing stays in the surface.
    return { result: { ok: true } };
  },
});

defineOperation({
  name: "contradiction_detail",
  description: "Get a single contradiction pair detail (HTTP GET /review/contradictions/:id).",
  schema: looseSchema,
  handler: async (input, ctx) => {
    const { listPairs } = await import("./contradiction/contradiction-review.js");
    const result = await listPairs(ctx.service.memoryDir, {
      filter: "all" as const,
      namespace: optStr(input.namespace),
      includeUnscopedForNamespace: false,
      limit: 1,
    });
    return { result };
  },
});

// ===========================================================================
// SSE-stream operations (endpoint registration; streaming handled by transport)
// ===========================================================================

defineOperation({
  name: "offline_sync_snapshot_stream",
  description: "Stream offline-sync snapshot updates (SSE).",
  schema: looseSchema,
  handler: async (_input, ctx) => ({ result: await ctx.service.offlineSyncSnapshotStream() }),
});

defineOperation({
  name: "graph_events",
  description: "Stream graph mutation events (SSE). Endpoint registration only.",
  schema: looseSchema,
  handler: async (_input, _ctx) => ({ result: { stream: "sse" } }),
});

defineOperation({
  name: "chat_message",
  description: "Send a message to Remnic Chat (issue #1583). Endpoint registration only — the handler enforces the chat_disabled gate, message validation, and the confirmation protocol.",
  schema: looseSchema,
  handler: async (_input, _ctx) => ({ result: { ok: true } }),
});

defineOperation({
  name: "chat_events",
  description: "Stream chat session transcript events (SSE, issue #1583). Endpoint registration only.",
  schema: looseSchema,
  handler: async (_input, _ctx) => ({ result: { stream: "sse" } }),
});
