/**
 * Batch migration of remaining access-surface handlers through the boundary
 * (issue #1525 / #1668). Each operation routes MCP/HTTP/CLI dispatch through
 * the shared validation + error-mapping layer in access-boundary.ts.
 *
 * Strict per-tool Zod schemas replace the earlier permissive looseSchema (#1668).
 * Each schema validates known field types; .passthrough() tolerates MCP client
 * context injection (cwd/projectTag/sessionKey) without silent type coercion.
 * The stripNulls preprocessor handles the OpenAI-schema null-for-absent gotcha.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DreamsPhase, RecallDisclosure, RecallPlanMode } from "./types.js";
import type { RemnicChatGptMemoryInspectorInput } from "./mcp-memory-inspector-app.js";
import { defineOperation } from "./access-boundary.js";
import { EngramAccessForbiddenError } from "./access-errors.js";
import {
  type ObserveRequest,
  observeRequestSchema,
  type RecallRequest,
  recallRequestSchema,
  retainedCategoryAlias,
  suggestionSubmitRequestSchema,
} from "./access-schema.js";
import { EngramAccessInputError, type EngramAccessService } from "./access-service.js";
import { enforceNamespaceAllowList, tokenCapabilityStore } from "./access-token-capabilities.js";
import { projectTagProjectId } from "./coding/coding-namespace.js";
import {
  parseNamespacePreflightWriteOp,
  resolveAuthorizedNamespaceWritablePreflight,
  type EngramAccessNamespaceWritableRequest,
} from "./access-namespace-preflight.js";
import { expandTildePath } from "./utils/path.js";
import { resolvePrincipal } from "./namespaces/principal.js";
import {
  parseSharedWriteOutputControls,
  type SharedWriteOutputControls,
} from "./shared-context/write-output-controls.js";
import { getRecallTimingStatus, isRecallTimingsOperator } from "./recall-timings.js";
import { parseDeepRecallMaxSteps } from "./deep-recall-config.js";
import { validateBriefingFormat } from "./briefing.js";
import {
  buildChatGptMemoryInspectorActionRequest,
  buildChatGptMemoryInspectorResult,
} from "./mcp-memory-inspector-app.js";
import { listPairs, isDefaultReviewNamespace, readPair } from "./contradiction/contradiction-review.js";
import { executeResolution, isValidResolutionVerb } from "./contradiction/resolution.js";
import { runContradictionScan } from "./contradiction/contradiction-scan.js";
import { runPreferenceDriftScan } from "./preferences/preference-drift.js";
import { runGraphEdgeDecayMaintenanceAcrossNamespaces } from "./maintenance/graph-edge-decay.js";
import { normalizeDreamsStatusWindowHours } from "./maintenance/dreams-ledger.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

function strictSchema<T extends z.ZodRawShape>(shape: T): z.ZodType<Record<string, unknown>> {
  return z.preprocess(stripNulls, z.object(shape).passthrough()) as unknown as z.ZodType<Record<string, unknown>>;
}

/**
 * stripNulls, but keys listed in `preserve` keep their null values. Used by
 * boundary schemas whose wire contract treats an explicit `null` as a
 * meaningful value (e.g. recall `codingContext: null` clears the session
 * context — it must not be collapsed into "absent").
 */
function stripNullsExcept(data: unknown, preserve: readonly string[]): unknown {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (value !== null || preserve.includes(key)) cleaned[key] = value;
    }
    return cleaned;
  }
  return data;
}


function optStr(v: unknown): string | undefined { return typeof v === "string" ? v : undefined; }
function reqStr(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) throw new EngramAccessInputError(field + " is required and must be a non-empty string");
  return v;
}
function defStr(v: unknown, d: string): string { return typeof v === "string" ? v : d; }
function optNum(v: unknown): number | undefined { return typeof v === "number" && Number.isFinite(v) ? v : undefined; }
function optBool(v: unknown): boolean | undefined { return typeof v === "boolean" ? v : undefined; }
function optStrArr(v: unknown): string[] | undefined { return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined; }

const S = {
  str: z.string().optional(),
  num: z.number().optional(),
  // Accept numbers and numeric strings (MCP clients sometimes send "7" for 7).
  flexNum: z.union([z.number(), z.string()]).optional(),
  bool: z.boolean().optional(),
  strArr: z.array(z.string()).optional(),
};

// === RECALL ===
// Issue #2482: the boundary validates against the SAME canonical zod schema
// the HTTP transport uses (recallRequestSchema). No parallel field list, no
// silent defaults — a missing `query` or a bad enum is a 400 at the boundary.
// `codingContext: null` survives the null-strip (explicit session-context
// clear); every other null is the MCP null-for-absent idiom.
defineOperation({
  name: "recall",
  description: "Semantic recall.",
  schema: z.preprocess((data) => stripNullsExcept(data, ["codingContext"]), recallRequestSchema) as unknown as z.ZodType<RecallRequest>,
  handler: async (input, ctx) => ({
    result: await ctx.service.recall({
      ...input,
      authenticatedPrincipal: ctx.authenticatedPrincipal,
      ...(ctx.sourceConnector ? { sourceConnector: ctx.sourceConnector } : {}),
      ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
    }),
  }),
});
defineOperation({ name: "recall_explain", description: "Explain recall plan.", schema: strictSchema({ sessionKey: S.str, namespace: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.recallExplain({ sessionKey: optStr(input.sessionKey), namespace: optStr(input.namespace), authenticatedPrincipal: ctx.authenticatedPrincipal }) }) });
defineOperation({ name: "set_coding_context", description: "Set coding context.", schema: z.preprocess((data) => stripNullsExcept(data, ["codingContext"]), z.object({ sessionKey: S.str, codingContext: z.union([z.null(), z.object({ projectId: S.str, branch: z.union([z.string(), z.null()]).optional(), rootPath: S.str, defaultBranch: z.union([z.string(), z.null()]).optional() }).passthrough()]).optional(), projectTag: S.str }).passthrough()) as unknown as z.ZodType<Record<string, unknown>>, // codingContext: null = clear context (preserved).
  handler: async (input, ctx) => {
    const sessionKey = defStr(input.sessionKey, "");
    const projectTag = optStr(input.projectTag);
    const hasProjectTag = projectTag !== undefined && projectTag.trim().length > 0;
    const hasCodingContext = "codingContext" in input;
    if (!hasCodingContext && hasProjectTag) { const tag = projectTag!.trim(); const pid = projectTagProjectId(tag); ctx.service.setCodingContext({ sessionKey, codingContext: { projectId: pid, branch: null, rootPath: pid, defaultBranch: null } }); return { result: { ok: true } }; }
    if (!hasCodingContext && !hasProjectTag) throw new EngramAccessInputError("set_coding_context requires either codingContext or projectTag");
    const rawCtx = (input as Record<string, unknown>).codingContext;
    let codingContext: { projectId: string; branch: string | null; rootPath: string; defaultBranch: string | null } | null = null;
    if (rawCtx !== null) { if (typeof rawCtx !== "object") throw new EngramAccessInputError("codingContext must be an object or null"); const o = rawCtx as Record<string, unknown>; const branch = o.branch === null ? null : optStr(o.branch); const dB = o.defaultBranch === null ? null : optStr(o.defaultBranch); if (branch === undefined) throw new EngramAccessInputError("codingContext.branch must be a string or null"); if (dB === undefined) throw new EngramAccessInputError("codingContext.defaultBranch must be a string or null"); codingContext = { projectId: defStr(o.projectId, ""), branch, rootPath: defStr(o.rootPath, ""), defaultBranch: dB }; }
    ctx.service.setCodingContext({ sessionKey, codingContext });
    return { result: { ok: true } };
  },
});
defineOperation({ name: "recall_tier_explain", description: "Explain recall tiers.", schema: strictSchema({ sessionKey: S.str, namespace: S.str }), handler: async (input, ctx) => { const sk = optStr(input.sessionKey); const ns = optStr(input.namespace); return { result: await ctx.service.recallTierExplain(sk && sk.length > 0 ? sk : undefined, ns && ns.length > 0 ? ns : undefined, ctx.authenticatedPrincipal) }; } });
defineOperation({ name: "recall_xray", description: "X-ray recall.", schema: strictSchema({ query: S.str, sessionKey: S.str, namespace: S.str, budget: z.unknown().optional(), disclosure: S.str }),
  handler: async (input, ctx) => {
    let budget: number | undefined;
    if (input.budget !== undefined) { const p = typeof input.budget === "number" ? input.budget : typeof input.budget === "string" ? Number(input.budget) : undefined; if (p === undefined || !Number.isFinite(p) || p <= 0 || !Number.isInteger(p)) throw new EngramAccessInputError("recall_xray: budget expects a positive integer"); budget = p; }
    const dr = optStr(input.disclosure);
    return { result: await ctx.service.recallXray({ query: defStr(input.query, ""), sessionKey: optStr(input.sessionKey), namespace: optStr(input.namespace), budget, authenticatedPrincipal: ctx.authenticatedPrincipal, sourceConnector: ctx.sourceConnector, ...(dr && dr !== "" ? { disclosure: dr as RecallDisclosure } : {}), ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}) }) };
  },
});
defineOperation({ name: "who_knows", description: "Rank entities by demonstrated expertise for a topic (#2057).", schema: strictSchema({ topic: S.str, limit: S.flexNum, namespace: S.str }),
  handler: async (input, ctx) => {
    const topic = defStr(input.topic, "");
    let limit: number | undefined;
    if (input.limit !== undefined) { const p = typeof input.limit === "number" ? input.limit : Number(input.limit); if (!Number.isInteger(p) || p < 1) throw new EngramAccessInputError("who_knows: limit expects a positive integer"); limit = p; }
    return { result: await ctx.service.whoKnows({ topic, ...(limit !== undefined ? { limit } : {}), namespace: optStr(input.namespace), authenticatedPrincipal: ctx.authenticatedPrincipal }) };
  },
});
defineOperation({ name: "promotion_candidates", description: "List agent-subject reuse-signaled promotion candidates (#2372).", schema: strictSchema({ namespace: S.str, targetNamespace: S.str, limit: S.flexNum }),
  handler: async (input, ctx) => {
    let limit: number | undefined;
    if (input.limit !== undefined) { const p = typeof input.limit === "number" ? input.limit : Number(input.limit); if (!Number.isInteger(p) || p < 1 || p > 100) throw new EngramAccessInputError("promotion_candidates: limit expects an integer in [1, 100]"); limit = p; }
    return { result: await ctx.service.promotionCandidates({ ...(limit !== undefined ? { limit } : {}), namespace: optStr(input.namespace), targetNamespace: optStr(input.targetNamespace), authenticatedPrincipal: ctx.authenticatedPrincipal }) };
  },
});
defineOperation({ name: "namespace_writable", description: "Read-only preflight: is a namespace writable for the caller's principal?", allowedByOps: ["namespace_writable", "observe", "memory_store"], schema: strictSchema({ namespace: S.str, sessionKey: S.str, op: S.str, cwd: S.str, projectTag: S.str }), handler: async (input, ctx) => {
  const writeOp = parseNamespacePreflightWriteOp(optStr(input.op));
  const namespace = optStr(input.namespace);
  const request: EngramAccessNamespaceWritableRequest = {
    sessionKey: optStr(input.sessionKey),
    authenticatedPrincipal: ctx.authenticatedPrincipal,
    cwd: optStr(input.cwd),
    projectTag: optStr(input.projectTag),
    ...(namespace ? { namespace } : {}),
  };
  return {
    result: await resolveAuthorizedNamespaceWritablePreflight(
      tokenCapabilityStore.getStore(),
      request,
      ctx.service.configRef.defaultNamespace,
      writeOp,
      (preflightRequest) => ctx.service.namespaceWritablePreflight(preflightRequest),
    ),
  };
} });

// === WEARABLES ===
defineOperation({ name: "wearables_status", description: "Wearables status.", schema: strictSchema({ namespace: S.str, sessionKey: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.wearablesStatus({ authenticatedPrincipal: ctx.authenticatedPrincipal, namespace: optStr(input.namespace), sessionKey: optStr(input.sessionKey) }) }) });
defineOperation({ name: "wearables_sync", description: "Sync wearables.", schema: strictSchema({ source: S.str, date: S.str, days: S.flexNum, forceMemories: S.bool, namespace: S.str, sessionKey: S.str }), handler: async (input, ctx) => { const summaries = await ctx.service.wearablesSync({ source: optStr(input.source), date: optStr(input.date), days: typeof input.days === "number" ? input.days : typeof input.days === "string" && Number.isFinite(Number(input.days)) ? Number(input.days) : undefined, forceMemories: optBool(input.forceMemories), authenticatedPrincipal: ctx.authenticatedPrincipal, namespace: optStr(input.namespace), sessionKey: optStr(input.sessionKey) }); return { result: { summaries } }; } });
defineOperation({ name: "transcript_day", description: "Transcript for a day.", schema: strictSchema({ date: S.str, source: S.str, namespace: S.str, sessionKey: S.str }), handler: async (input, ctx) => { const d = defStr(input.date, ""); if (d.trim().length === 0) throw new EngramAccessInputError("transcript_day: date is required (YYYY-MM-DD)"); const transcripts = await ctx.service.wearablesTranscriptDay({ date: d, source: optStr(input.source), authenticatedPrincipal: ctx.authenticatedPrincipal, namespace: optStr(input.namespace), sessionKey: optStr(input.sessionKey) }); return { result: { transcripts } }; } });
defineOperation({ name: "transcript_search", description: "Search transcripts.", schema: strictSchema({ query: S.str, source: S.str, from: S.str, to: S.str, limit: S.flexNum, namespace: S.str, sessionKey: S.str }), handler: async (input, ctx) => { const q = defStr(input.query, ""); if (q.trim().length === 0) throw new EngramAccessInputError("transcript_search: query is required"); const results = await ctx.service.wearablesTranscriptSearch({ query: q, source: optStr(input.source), from: optStr(input.from), to: optStr(input.to), limit: typeof input.limit === "number" ? input.limit : typeof input.limit === "string" && Number.isFinite(Number(input.limit)) ? Number(input.limit) : undefined, authenticatedPrincipal: ctx.authenticatedPrincipal, namespace: optStr(input.namespace), sessionKey: optStr(input.sessionKey) }); return { result: { results } }; } });
defineOperation({ name: "transcript_memories", description: "Transcript memories.", schema: strictSchema({ source: S.str, date: S.str, limit: S.flexNum, namespace: S.str, sessionKey: S.str }), handler: async (input, ctx) => { const memories = await ctx.service.wearablesTranscriptMemories({ source: optStr(input.source), date: optStr(input.date), limit: typeof input.limit === "number" ? input.limit : typeof input.limit === "string" && Number.isFinite(Number(input.limit)) ? Number(input.limit) : undefined, authenticatedPrincipal: ctx.authenticatedPrincipal, namespace: optStr(input.namespace), sessionKey: optStr(input.sessionKey) }); return { result: { memories } }; } });

// === MEETINGS (issue #1900) ===
defineOperation({ name: "meetings_list", description: "List stored meeting records (all days, or one day).", schema: strictSchema({ date: S.str, namespace: S.str, sessionKey: S.str }), handler: async (input, ctx) => { const d = optStr(input.date); return { result: await ctx.service.meetingsList(d && d.length > 0 ? d : undefined, { authenticatedPrincipal: ctx.authenticatedPrincipal, namespace: optStr(input.namespace), sessionKey: optStr(input.sessionKey) }) }; } });
defineOperation({ name: "meetings_get", description: "Get a stored meeting record by id.", schema: strictSchema({ id: S.str, namespace: S.str, sessionKey: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.meetingsGet(reqStr(input.id, "id"), { authenticatedPrincipal: ctx.authenticatedPrincipal, namespace: optStr(input.namespace), sessionKey: optStr(input.sessionKey) }) }) });
defineOperation({ name: "meetings_build", description: "Detect + fuse + store a day's meetings.", schema: strictSchema({ date: S.str, namespace: S.str, sessionKey: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.meetingsBuild(reqStr(input.date, "date"), { authenticatedPrincipal: ctx.authenticatedPrincipal, namespace: optStr(input.namespace), sessionKey: optStr(input.sessionKey) }) }) });
// === DEEP RECALL (issue #2332) — budgeted REFINE/EXPAND/STOP retrieval ===
defineOperation({ name: "deep_recall", description: "Budgeted multi-hop deep recall over the anchor graph.", schema: strictSchema({ query: S.str, maxSteps: S.flexNum, namespace: S.str, sessionKey: S.str }), handler: async (input, ctx) => {
  const q = defStr(input.query, "");
  if (q.trim().length === 0) throw new EngramAccessInputError("deep_recall: query is required");
  // Strict boundary parse (issue #2915): `"abc"` must NOT silently become the
  // configured default and `""` must NOT become 0 — both are rejected.
  let maxSteps: number | undefined;
  try {
    maxSteps = parseDeepRecallMaxSteps(input.maxSteps);
  } catch (err) {
    throw new EngramAccessInputError(`deep_recall: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { result: await ctx.service.deepRecall({ query: q, maxSteps, authenticatedPrincipal: ctx.authenticatedPrincipal, namespace: optStr(input.namespace), sessionKey: optStr(input.sessionKey), ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}) }) };
} });

// === ACTION CONFIDENCE + INSPECTOR + CAPSULE ===
defineOperation({ name: "action_confidence", description: "Action confidence.", schema: strictSchema({ intendedAction: S.str, confidence: S.num, risk: S.str, contextReadiness: S.str, currentContextScopes: S.strArr, userRules: z.array(z.unknown()).optional(), retrievedMemories: z.array(z.unknown()).optional() }), handler: async (input, ctx) => { const req: Record<string, unknown> = {}; if (input.intendedAction !== undefined) req.intendedAction = optStr(input.intendedAction); if (input.confidence !== undefined) req.confidence = optNum(input.confidence); if (input.risk !== undefined) req.risk = optStr(input.risk) as "low" | "medium" | "high" | "irreversible" | "restricted" | undefined; if (input.contextReadiness !== undefined) req.contextReadiness = optStr(input.contextReadiness) as "none" | "partial" | "sufficient" | undefined; if (input.currentContextScopes !== undefined) req.currentContextScopes = optStrArr(input.currentContextScopes); if (input.userRules !== undefined) req.userRules = input.userRules; if (input.retrievedMemories !== undefined) req.retrievedMemories = input.retrievedMemories; return { result: await ctx.service.actionConfidence(req) }; } });
defineOperation({ name: "chatgpt_memory_inspector", description: "Memory inspector.", schema: strictSchema({ query: S.str, sessionKey: S.str, namespace: S.str, currentContextScopes: S.strArr, allowUnverifiedPreview: S.bool }),
  handler: async (input, ctx) => {
    const q = defStr(input.query, "");
    if (q.trim().length === 0) throw new EngramAccessInputError("chatgpt_memory_inspector requires a non-empty query string");
    const ii: RemnicChatGptMemoryInspectorInput = { query: q.trim() };
    if (typeof input.sessionKey === "string" && input.sessionKey.trim().length > 0) ii.sessionKey = input.sessionKey;
    if (typeof input.namespace === "string" && input.namespace.trim().length > 0) ii.namespace = input.namespace;
    if (input.currentContextScopes !== undefined) ii.currentContextScopes = input.currentContextScopes as string[];
    if (input.allowUnverifiedPreview !== undefined) ii.allowUnverifiedPreview = input.allowUnverifiedPreview as boolean;
    const rsk = ii.sessionKey ?? (ctx.authenticatedPrincipal ? "remnic:chatgpt-memory-inspector:" + randomUUID() : undefined);
    const xr = await ctx.service.recallXray({ query: ii.query, sessionKey: rsk, namespace: ii.namespace, currentContextScopes: ii.currentContextScopes, authenticatedPrincipal: ctx.authenticatedPrincipal, ...(ctx.sourceConnector ? { sourceConnector: ctx.sourceConnector } : {}), mode: "full", disclosure: "chunk", includeRecall: true, ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}) });
    const x = xr.snapshotFound === true ? (xr.snapshot ?? null) : null;
    const r = xr.recall ?? { query: ii.query, namespace: ii.namespace ?? x?.namespace ?? "global", context: "", count: 0, memoryIds: [], results: [], fallbackUsed: false, sourcesUsed: [], disclosure: "chunk" as const };
    const ac = await ctx.service.actionConfidence(buildChatGptMemoryInspectorActionRequest(ii, r, x));
    return { result: buildChatGptMemoryInspectorResult(ii, r, x, ac) };
  },
});
defineOperation({ name: "day_summary", description: "Day summary.", schema: strictSchema({ memories: S.str, sessionKey: S.str, namespace: S.str, timeZone: S.str, cwd: S.str, projectTag: S.str }), handler: async (input, ctx) => { const req: Record<string, unknown> = {}; if (input.memories !== undefined) req.memories = optStr(input.memories); if (input.sessionKey !== undefined) req.sessionKey = optStr(input.sessionKey); if (input.namespace !== undefined) req.namespace = optStr(input.namespace); if (input.timeZone !== undefined) req.timeZone = optStr(input.timeZone); const summary = await ctx.service.daySummary(req); return { result: summary ?? {} }; } });
defineOperation({ name: "capsule_export", description: "Export capsule.", schema: strictSchema({ name: S.str, namespace: S.str, since: S.str, includeKinds: S.strArr, peerIds: S.strArr, includeTranscripts: S.bool, encrypt: S.bool, cwd: S.str, projectTag: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.capsuleExport({ name: optStr(input.name) ?? "", namespace: optStr(input.namespace), since: optStr(input.since), includeKinds: optStrArr(input.includeKinds), peerIds: optStrArr(input.peerIds), includeTranscripts: optBool(input.includeTranscripts as unknown), encrypt: optBool(input.encrypt as unknown), principal: ctx.authenticatedPrincipal } as unknown as Parameters<EngramAccessService["capsuleExport"]>[0]) }) });
defineOperation({ name: "capsule_import", description: "Import capsule.", schema: strictSchema({ archivePath: S.str, namespace: S.str, mode: S.str, passphrase: S.str, cwd: S.str, projectTag: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.capsuleImport({ archivePath: expandTildePath(optStr(input.archivePath) ?? ""), namespace: optStr(input.namespace), mode: optStr(input.mode) as "skip" | "overwrite" | "fork" | undefined, passphrase: optStr(input.passphrase), principal: ctx.authenticatedPrincipal }) }) });
defineOperation({ name: "capsule_list", description: "List capsules.", schema: strictSchema({ namespace: S.str, sessionKey: S.str, cwd: S.str, projectTag: S.str }), handler: async (input, ctx) => {
  const rp = ctx.authenticatedPrincipal ?? (typeof input.sessionKey === "string" && input.sessionKey.length > 0 && ctx.service.configRef ? resolvePrincipal(input.sessionKey, ctx.service.configRef) : undefined);
  return { result: await ctx.service.capsuleList({ namespace: optStr(input.namespace), principal: rp }) };
} });

// === GOVERNANCE ===
defineOperation({ name: "memory_governance_run", description: "Run governance.", schema: strictSchema({ namespace: S.str, mode: S.str, recentDays: S.num, maxMemories: S.num, batchSize: S.num }), handler: async (input, ctx) => ({ result: await ctx.service.governanceRun({ namespace: optStr(input.namespace), mode: optStr(input.mode) === "apply" ? "apply" : "shadow", recentDays: optNum(input.recentDays), maxMemories: optNum(input.maxMemories), batchSize: optNum(input.batchSize), authenticatedPrincipal: ctx.authenticatedPrincipal }, ctx.authenticatedPrincipal) }) });
defineOperation({ name: "entity_synthesis_run", description: "Bulk-drain the entity synthesis queue (issue #2136).", schema: strictSchema({ namespace: S.str, maxEntities: S.num }), handler: async (input, ctx) => ({ result: await ctx.service.entitySynthesisRun({ namespace: optStr(input.namespace), maxEntities: input.maxEntities === undefined ? undefined : (input.maxEntities as number), authenticatedPrincipal: ctx.authenticatedPrincipal }, ctx.authenticatedPrincipal) }) });
defineOperation({ name: "procedure_mining_run", description: "Run procedure mining.", schema: strictSchema({ namespace: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.procedureMiningRun({ namespace: optStr(input.namespace), authenticatedPrincipal: ctx.authenticatedPrincipal }, ctx.authenticatedPrincipal) }) });
defineOperation({ name: "pattern_reinforcement_run", description: "Run pattern reinforcement.", schema: strictSchema({ namespace: S.str, force: S.bool }), handler: async (input, ctx) => ({ result: await ctx.service.patternReinforcementRun({ namespace: optStr(input.namespace), force: input.force === true, authenticatedPrincipal: ctx.authenticatedPrincipal }, ctx.authenticatedPrincipal) }) });
defineOperation({ name: "procedural_stats", description: "Procedural stats.", schema: strictSchema({ namespace: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.procedureStats({ namespace: optStr(input.namespace) }, ctx.authenticatedPrincipal) }) });
defineOperation({ name: "procedure_library_maintenance", description: "Run procedure library maintenance (issue #2370): shadow-first merge / repair-flag / retire from outcome telemetry. apply=true plus procedural.maintenance.enabled required for writes.", schema: strictSchema({ namespace: S.str, apply: S.bool, dryRun: S.bool }), handler: async (input, ctx) => ({ result: await ctx.service.procedureLibraryMaintenance({ namespace: optStr(input.namespace), apply: input.apply === true, dryRun: input.dryRun === true, authenticatedPrincipal: ctx.authenticatedPrincipal }, ctx.authenticatedPrincipal) }) });

// === MEMORY/ENTITY/OBSERVE/LCM ===
defineOperation({ name: "memory_timeline", description: "Memory timeline.", schema: strictSchema({ memoryId: S.str, namespace: S.str, limit: S.num }), handler: async (input, ctx) => ({ result: await ctx.service.memoryTimeline(optStr(input.memoryId) ?? "", optStr(input.namespace), optNum(input.limit) ?? 200, ctx.authenticatedPrincipal) }) });
// Issue #2482/#2829: suggestion_submit validates through the canonical
// suggestionSubmitRequestSchema — the SAME schema the HTTP transport and the
// MCP wire parse use, category alias transform included. The raw spelling
// survives on `ctx.rawInput` for the coercion note.
defineOperation({
  name: "suggestion_submit",
  description: "Submit suggestion.",
  schema: z.preprocess((data) => stripNullsExcept(data, ["codingContext"]), suggestionSubmitRequestSchema),
  handler: async (input, ctx) => {
    const rawCategory = retainedCategoryAlias(ctx.rawInput);
    return {
      result: await ctx.service.suggestionSubmit({
        ...input,
        authenticatedPrincipal: ctx.authenticatedPrincipal,
        ...(ctx.sourceConnector ? { sourceConnector: ctx.sourceConnector } : {}),
        ...(rawCategory ? { rawCategory } : {}),
      }),
    };
  },
});
defineOperation({ name: "entity_get", description: "Get entity.", schema: strictSchema({ name: S.str, namespace: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.entityGet(optStr(input.name) ?? "", optStr(input.namespace)) }) });
defineOperation({ name: "review_queue_list", description: "List review queue.", schema: strictSchema({ runId: S.str, namespace: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.reviewQueue(optStr(input.runId) ?? "", optStr(input.namespace), ctx.authenticatedPrincipal) }) });
// Issue #2482: observe validates through the canonical observeRequestSchema
// (same as HTTP/MCP wire validation). Nullable wire fields (parts /
// sourceFormat) map to undefined for the service's cleaned message form.
defineOperation({
  name: "observe",
  description: "Observe messages.",
  schema: z.preprocess(stripNulls, observeRequestSchema) as unknown as z.ZodType<ObserveRequest>,
  handler: async (input, ctx) => ({
    result: await ctx.service.observe(
      {
        sessionKey: input.sessionKey,
        messages: input.messages.map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.parts ? { parts: message.parts } : {}),
          ...(message.rawContent !== undefined ? { rawContent: message.rawContent } : {}),
          ...(message.sourceFormat ? { sourceFormat: message.sourceFormat } : {}),
        })),
        skipExtraction: input.skipExtraction === true,
        idempotencyKey: input.idempotencyKey,
        namespace: input.namespace,
        authenticatedPrincipal: ctx.authenticatedPrincipal,
        cwd: input.cwd,
        projectTag: input.projectTag,
        ...(ctx.sourceConnector ? { sourceConnector: ctx.sourceConnector } : {}),
      },
      ctx.hooks?.enforceWriteQuota ? { enforceWriteQuota: ctx.hooks.enforceWriteQuota } : undefined,
    ),
  }),
});
defineOperation({ name: "lcm_search", description: "Search LCM.", schema: strictSchema({ query: S.str, sessionKey: S.str, sessionPrefix: S.str, namespace: S.str, limit: S.num }), handler: async (input, ctx) => ({ result: await ctx.service.lcmSearch({ query: defStr(input.query, ""), sessionKey: optStr(input.sessionKey), sessionPrefix: optStr(input.sessionPrefix), namespace: optStr(input.namespace), limit: optNum(input.limit), authenticatedPrincipal: ctx.authenticatedPrincipal }) }) });
defineOperation({ name: "lcm_compaction_flush", description: "Flush LCM compaction.", schema: strictSchema({ sessionKey: S.str, namespace: S.str, cwd: S.str, projectTag: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.lcmCompactionFlush({ sessionKey: optStr(input.sessionKey) ?? "", namespace: optStr(input.namespace), cwd: optStr(input.cwd), projectTag: optStr(input.projectTag), authenticatedPrincipal: ctx.authenticatedPrincipal }) }) });
defineOperation({ name: "extraction_force_flush", description: "Force-drain a session extraction buffer.", schema: strictSchema({ sessionKey: S.str, namespace: S.str, cwd: S.str, projectTag: S.str, deadlineMs: S.num }), handler: async (input, ctx) => ({ result: await ctx.service.extractionForceFlush({ sessionKey: optStr(input.sessionKey) ?? "", namespace: optStr(input.namespace), cwd: optStr(input.cwd), projectTag: optStr(input.projectTag), deadlineMs: optNum(input.deadlineMs), authenticatedPrincipal: ctx.authenticatedPrincipal, onCommitted: ctx.hooks?.recordWriteCommit, ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}) }) }) });
defineOperation({ name: "lcm_compaction_record", description: "Record LCM compaction.", schema: strictSchema({ sessionKey: S.str, namespace: S.str, tokensBefore: S.num, tokensAfter: S.num }), handler: async (input, ctx) => ({ result: await ctx.service.lcmCompactionRecord({ sessionKey: optStr(input.sessionKey) ?? "", namespace: optStr(input.namespace), tokensBefore: optNum(input.tokensBefore) ?? 0, tokensAfter: optNum(input.tokensAfter) ?? 0, authenticatedPrincipal: ctx.authenticatedPrincipal }) }) });

// === CONTINUITY/IDENTITY ===
defineOperation({ name: "continuity_audit_generate", description: "Continuity audit.", fleetWide: true, schema: strictSchema({ period: S.str, key: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.continuityAuditGenerate({ period: optStr(input.period) === "monthly" ? "monthly" : optStr(input.period) === "weekly" ? "weekly" : undefined, key: optStr(input.key) }) }) });
defineOperation({ name: "continuity_incident_open", description: "Open incident.", schema: strictSchema({ symptom: S.str, namespace: S.str, triggerWindow: S.str, suspectedCause: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.continuityIncidentOpen({ symptom: optStr(input.symptom) ?? "", namespace: optStr(input.namespace), triggerWindow: optStr(input.triggerWindow), suspectedCause: optStr(input.suspectedCause), principal: ctx.authenticatedPrincipal }) }) });
defineOperation({ name: "continuity_incident_close", description: "Close incident.", schema: strictSchema({ id: S.str, namespace: S.str, fixApplied: S.str, verificationResult: S.str, preventiveRule: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.continuityIncidentClose({ id: optStr(input.id) ?? "", namespace: optStr(input.namespace), fixApplied: optStr(input.fixApplied) ?? "", verificationResult: optStr(input.verificationResult) ?? "", preventiveRule: optStr(input.preventiveRule), principal: ctx.authenticatedPrincipal }) }) });
defineOperation({ name: "continuity_incident_list", description: "List incidents.", schema: strictSchema({ state: S.str, namespace: S.str, limit: S.num }), handler: async (input, ctx) => { const st = optStr(input.state); return { result: await ctx.service.continuityIncidentList({ state: st === "closed" ? "closed" : st === "all" ? "all" : st === "open" ? "open" : undefined, namespace: optStr(input.namespace), limit: optNum(input.limit), principal: ctx.authenticatedPrincipal }) }; } });
defineOperation({ name: "continuity_loop_add_or_update", description: "Add/update loop.", schema: strictSchema({ id: S.str, cadence: S.str, purpose: S.str, status: S.str, killCondition: S.str, namespace: S.str, lastReviewed: S.str, notes: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.continuityLoopAddOrUpdate({ id: optStr(input.id) ?? "", cadence: (optStr(input.cadence) as "daily" | "weekly" | "monthly" | "quarterly") ?? "weekly", purpose: optStr(input.purpose) ?? "", status: (optStr(input.status) as "active" | "paused" | "retired") ?? "active", killCondition: optStr(input.killCondition) ?? "", namespace: optStr(input.namespace), principal: ctx.authenticatedPrincipal, lastReviewed: optStr(input.lastReviewed), notes: optStr(input.notes) }) }) });
defineOperation({ name: "continuity_loop_review", description: "Review loop.", schema: strictSchema({ id: S.str, namespace: S.str, status: S.str, notes: S.str, reviewedAt: S.str }), handler: async (input, ctx) => { const st = optStr(input.status); return { result: await ctx.service.continuityLoopReview({ id: optStr(input.id) ?? "", namespace: optStr(input.namespace), principal: ctx.authenticatedPrincipal, status: st === "active" || st === "paused" || st === "retired" ? st as "active" | "paused" | "retired" : undefined, notes: optStr(input.notes), reviewedAt: optStr(input.reviewedAt) }) }; } });
defineOperation({ name: "identity_anchor_get", description: "Get identity anchor.", schema: strictSchema({ namespace: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.identityAnchorGet({ namespace: optStr(input.namespace), principal: ctx.authenticatedPrincipal }) }) });
defineOperation({ name: "identity_anchor_update", description: "Update identity anchor.", schema: strictSchema({ namespace: S.str, identityTraits: S.str, communicationPreferences: S.str, operatingPrinciples: S.str, continuityNotes: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.identityAnchorUpdate({ namespace: optStr(input.namespace), principal: ctx.authenticatedPrincipal, identityTraits: optStr(input.identityTraits), communicationPreferences: optStr(input.communicationPreferences), operatingPrinciples: optStr(input.operatingPrinciples), continuityNotes: optStr(input.continuityNotes) }) }) });
defineOperation({ name: "memory_identity", description: "Memory identity.", schema: strictSchema({ namespace: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.memoryIdentity({ namespace: optStr(input.namespace), principal: ctx.authenticatedPrincipal }) }) });

// === WORK/SHARED ===
defineOperation({ name: "work_task", description: "Manage work task.", schema: strictSchema({ action: S.str, id: S.str, title: S.str, description: S.str, status: S.str, priority: S.str, owner: S.str, assignee: S.str, projectId: S.str, tags: S.strArr, dueAt: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.workTask({ action: (optStr(input.action) as "update" | "list" | "get" | "create" | "delete" | "transition") ?? "list", id: optStr(input.id), title: optStr(input.title), description: optStr(input.description), status: optStr(input.status), priority: optStr(input.priority), owner: optStr(input.owner), assignee: optStr(input.assignee), projectId: optStr(input.projectId), tags: optStrArr(input.tags), dueAt: optStr(input.dueAt) }) }) });
defineOperation({ name: "work_project", description: "Manage work project.", schema: strictSchema({ action: S.str, id: S.str, name: S.str, description: S.str, status: S.str, owner: S.str, tags: S.strArr, taskId: S.str, projectId: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.workProject({ action: (optStr(input.action) as "update" | "list" | "get" | "create" | "delete" | "link_task") ?? "list", id: optStr(input.id), name: optStr(input.name), description: optStr(input.description), status: optStr(input.status), owner: optStr(input.owner), tags: optStrArr(input.tags), taskId: optStr(input.taskId), projectId: optStr(input.projectId) }) }) });
defineOperation({ name: "work_board", description: "Manage work board.", schema: strictSchema({ action: S.str, projectId: S.str, snapshotJson: S.str, linkToMemory: S.bool }), handler: async (input, ctx) => ({ result: await ctx.service.workBoard({ action: (optStr(input.action) as "export_markdown" | "export_snapshot" | "import_snapshot") ?? "export_markdown", projectId: optStr(input.projectId) ?? "", snapshotJson: optStr(input.snapshotJson) ?? "", linkToMemory: input.linkToMemory === true }) }) });
// Issue #2920: the envelope controls (authority/expiresAt/supersedes) are
// parsed by the ONE canonical surface module shared with the OpenClaw tool
// (write-output-controls.ts); semantics stay in composeWriteEnvelope. A
// client-supplied principal/namespace is rejected here — identity and
// scoping are server-resolved (ctx.authenticatedPrincipal).
defineOperation({
  name: "shared_context_write_output",
  description: "Write shared output.",
  schema: strictSchema({ agentId: S.str, title: S.str, content: S.str, authority: S.str, expiresAt: S.str, supersedes: S.str }),
  handler: async (input, ctx) => {
    let controls: SharedWriteOutputControls;
    try {
      controls = parseSharedWriteOutputControls(input);
    } catch (error) {
      throw new EngramAccessInputError(error instanceof Error ? error.message : String(error));
    }
    return {
      result: await ctx.service.sharedContextWriteOutput({
        agentId: optStr(input.agentId) ?? "",
        title: optStr(input.title) ?? "",
        content: optStr(input.content) ?? "",
        ...controls,
        principal: ctx.authenticatedPrincipal,
      }),
    };
  },
});
defineOperation({ name: "shared_feedback_record", description: "Record shared feedback.", schema: strictSchema({ agent: S.str, decision: S.str, reason: S.str, date: S.str, learning: S.str, outcome: S.str, severity: S.str, confidence: S.num, workflow: S.str, tags: S.strArr, evidenceWindowStart: S.str, evidenceWindowEnd: S.str, refs: S.strArr }), handler: async (input, ctx) => { const sv = optStr(input.severity); return { result: await ctx.service.sharedFeedbackRecord({ agent: optStr(input.agent) ?? "", decision: (optStr(input.decision) as "rejected" | "approved" | "approved_with_feedback") ?? "approved", reason: optStr(input.reason) ?? "", date: optStr(input.date), learning: optStr(input.learning), outcome: optStr(input.outcome), severity: sv === "low" || sv === "medium" || sv === "high" ? sv as "low" | "medium" | "high" : undefined, confidence: optNum(input.confidence), workflow: optStr(input.workflow), tags: optStrArr(input.tags), evidenceWindowStart: optStr(input.evidenceWindowStart), evidenceWindowEnd: optStr(input.evidenceWindowEnd), refs: optStrArr(input.refs) }) }; } });
defineOperation({ name: "shared_priorities_append", description: "Append priorities.", schema: strictSchema({ agentId: S.str, text: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.sharedPrioritiesAppend({ agentId: optStr(input.agentId) ?? "", text: optStr(input.text) ?? "" }) }) });
defineOperation({ name: "shared_context_cross_signals_run", description: "Run cross signals.", fleetWide: true, schema: strictSchema({ date: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.sharedContextCrossSignalsRun({ date: optStr(input.date) }) }) });
defineOperation({ name: "shared_context_curate_daily", description: "Curate daily.", fleetWide: true, schema: strictSchema({ date: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.sharedContextCurateDaily({ date: optStr(input.date) }) }) });
defineOperation({ name: "compounding_weekly_synthesize", description: "Weekly synthesize.", fleetWide: true, schema: strictSchema({ weekId: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.compoundingWeeklySynthesize({ weekId: optStr(input.weekId) }) }) });
defineOperation({ name: "compounding_promote_candidate", description: "Promote candidate.", fleetWide: true, schema: strictSchema({ weekId: S.str, candidateId: S.str, dryRun: S.bool }), handler: async (input, ctx) => ({ result: await ctx.service.compoundingPromoteCandidate({ weekId: optStr(input.weekId) ?? "", candidateId: optStr(input.candidateId) ?? "", dryRun: input.dryRun === true }) }) });
defineOperation({ name: "compression_guidelines_optimize", description: "Optimize guidelines.", fleetWide: true, schema: strictSchema({ dryRun: S.bool, eventLimit: S.num }), handler: async (input, ctx) => ({ result: await ctx.service.compressionGuidelinesOptimize({ dryRun: input.dryRun === true, eventLimit: optNum(input.eventLimit) }) }) });
defineOperation({ name: "compression_guidelines_activate", description: "Activate guidelines.", fleetWide: true, schema: strictSchema({ expectedContentHash: S.str, expectedGuidelineVersion: S.num }), handler: async (input, ctx) => ({ result: await ctx.service.compressionGuidelinesActivate({ expectedContentHash: optStr(input.expectedContentHash), expectedGuidelineVersion: optNum(input.expectedGuidelineVersion) }) }) });

// === MEMORY DEBUG/GRAPH/FEEDBACK ===
defineOperation({ name: "memory_profile", description: "Memory profile.", schema: strictSchema({ namespace: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.memoryProfile(optStr(input.namespace), ctx.authenticatedPrincipal) }) });
defineOperation({ name: "memory_entities_list", description: "List entities.", schema: strictSchema({ namespace: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.memoryEntitiesList(optStr(input.namespace), ctx.authenticatedPrincipal) }) });
defineOperation({ name: "memory_questions", description: "Memory questions.", schema: strictSchema({ namespace: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.memoryQuestions(optStr(input.namespace), ctx.authenticatedPrincipal) }) });
defineOperation({ name: "memory_last_recall", description: "Last recall.", schema: strictSchema({ sessionKey: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.lastRecallSnapshot(optStr(input.sessionKey)) }) });
defineOperation({ name: "memory_intent_debug", description: "Debug intent.", schema: strictSchema({ namespace: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.intentDebug(optStr(input.namespace)) }) });
defineOperation({ name: "memory_qmd_debug", description: "Debug QMD.", schema: strictSchema({ namespace: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.qmdDebug(optStr(input.namespace)) }) });
defineOperation({ name: "memory_graph_explain", description: "Explain graph.", schema: strictSchema({ namespace: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.graphExplainLastRecall(optStr(input.namespace)) }) });
defineOperation({ name: "graph_snapshot", description: "Graph snapshot.", schema: strictSchema({ namespace: S.str, limit: S.num, since: S.str, focusNodeId: S.str, categories: S.strArr }), handler: async (input, ctx) => ({ result: await ctx.service.graphSnapshot({ namespace: optStr(input.namespace), limit: optNum(input.limit), since: optStr(input.since), focusNodeId: optStr(input.focusNodeId), categories: optStrArr(input.categories) }, ctx.authenticatedPrincipal) }) });
defineOperation({ name: "memory_feedback", description: "Record feedback.", schema: strictSchema({ memoryId: S.str, vote: S.str, note: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.memoryFeedback({ memoryId: optStr(input.memoryId) ?? "", vote: optStr(input.vote) === "down" ? "down" : "up", note: optStr(input.note) }) }) });
defineOperation({ name: "memory_promote", description: "Promote memory.", schema: strictSchema({ memoryId: S.str, namespace: S.str, sessionKey: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.memoryPromote({ memoryId: optStr(input.memoryId) ?? "", namespace: optStr(input.namespace), sessionKey: optStr(input.sessionKey), principal: ctx.authenticatedPrincipal }) }) });
defineOperation({ name: "memory_outcome", description: "Record outcome.", schema: strictSchema({ memoryId: S.str, outcome: S.str, namespace: S.str, sessionKey: S.str, timestamp: S.str }), handler: async (input, ctx) => { const o = optStr(input.outcome); if (o !== "success" && o !== "failure") throw new EngramAccessInputError("memory_outcome: outcome must be \"success\" or \"failure\"; got " + JSON.stringify(o)); return { result: await ctx.service.memoryOutcome({ memoryId: optStr(input.memoryId) ?? "", outcome: o, namespace: optStr(input.namespace), sessionKey: optStr(input.sessionKey), timestamp: optStr(input.timestamp), principal: ctx.authenticatedPrincipal }) }; } });
defineOperation({ name: "memory_action_apply", description: "Apply action.", schema: strictSchema({ action: S.str, outcome: S.str, reason: S.str, memoryId: S.str, namespace: S.str, sessionKey: S.str, content: S.str, category: S.str, linkTargetId: S.str, linkType: S.str, linkStrength: S.num, artifactType: S.str, execute: S.bool, sourcePrompt: S.str, dryRun: S.bool }), handler: async (input, ctx) => ({ result: await ctx.service.memoryActionApply({ action: optStr(input.action) ?? "", outcome: optStr(input.outcome), reason: optStr(input.reason), memoryId: optStr(input.memoryId) ?? "", namespace: optStr(input.namespace), sessionKey: optStr(input.sessionKey), content: optStr(input.content), category: optStr(input.category), linkTargetId: optStr(input.linkTargetId), linkType: optStr(input.linkType), linkStrength: optNum(input.linkStrength), artifactType: optStr(input.artifactType), execute: optBool(input.execute), sourcePrompt: optStr(input.sourcePrompt), dryRun: input.dryRun === true, principal: ctx.authenticatedPrincipal }) }) });
defineOperation({ name: "context_checkpoint", description: "Context checkpoint.", schema: strictSchema({ sessionKey: S.str, context: S.str, namespace: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.contextCheckpoint({ sessionKey: optStr(input.sessionKey) ?? "", context: optStr(input.context) ?? "", namespace: optStr(input.namespace), principal: ctx.authenticatedPrincipal }) }) });
defineOperation({ name: "briefing", description: "Daily briefing.", schema: strictSchema({ since: S.str, focus: S.str, namespace: S.str, format: S.str, maxFollowups: S.num }), handler: async (input, ctx) => { const rf = optStr(input.format); const fe = validateBriefingFormat(rf); if (fe) throw new EngramAccessInputError(fe); return { result: await ctx.service.briefing({ since: optStr(input.since), focus: optStr(input.focus), namespace: optStr(input.namespace), format: rf as "json" | "markdown" | undefined, maxFollowups: optNum(input.maxFollowups), principal: ctx.authenticatedPrincipal }) }; } });

// === CONTRADICTION/REVIEW ===
defineOperation({ name: "review_list", description: "List review pairs.", schema: strictSchema({ filter: S.str, namespace: S.str, limit: S.num }),
  handler: async (input, ctx) => {
    const VF = new Set(["all", "unresolved", "contradicts", "independent", "duplicates", "needs-user"]);
    const rf = optStr(input.filter) ?? "unresolved";
    if (!VF.has(rf)) throw new EngramAccessInputError("Invalid filter '" + rf + "'. Valid: " + [...VF].join(", "));
    const ns = optStr(input.namespace);
    const resolved = await ctx.service.getReadableStorageForNamespace(ns, ctx.authenticatedPrincipal);
    const rn = ctx.service.configRef.namespacesEnabled ? resolved.namespace : undefined;
    const iun = Boolean(rn && isDefaultReviewNamespace(ctx.service.configRef.defaultNamespace, ns, rn));
    return { result: await listPairs(ctx.service.memoryDir, { filter: rf as "all" | "unresolved" | "contradicts" | "independent" | "duplicates" | "needs-user", namespace: rn, includeUnscopedForNamespace: iun, limit: optNum(input.limit) ?? 50 }) };
  },
});
defineOperation({ name: "review_resolve", description: "Resolve pair.", schema: strictSchema({ pairId: S.str, verb: S.str, mergedMemoryId: S.str, mergedContent: S.str }),
  handler: async (input, ctx) => {
    const pid = defStr(input.pairId, ""); const vb = defStr(input.verb, "");
    if (!pid) throw new EngramAccessInputError("pairId is required");
    if (!vb) throw new EngramAccessInputError("verb is required");
    if (!isValidResolutionVerb(vb)) throw new EngramAccessInputError("Invalid verb: " + vb);
    // Per-token namespace enforcement (issue #1850 round 9): review_resolve
    // selects its target BY pairId, so the affected namespace comes from the
    // record — NOT a request param that the MCP-over-HTTP tools/call gate
    // (toolAcceptsNamespace) already enforces (this tool's schema carries no
    // `namespace` property). A namespace-scoped bearer must not mutate a
    // contradiction pair in a namespace outside its allow-list. Load the pair
    // to learn its namespace, enforce the token's scope via the SAME
    // effective-namespace chokepoint the HTTP review/resolve route uses
    // (enforceNamespaceAllowList maps undefined → default, so a scoped token
    // whose allow-list INCLUDES the default can resolve a legacy pair), and
    // fail closed BEFORE dispatching the (mutating) resolution. A missing pair
    // falls through to executeResolution's existing not-found result. No-op for
    // unrestricted/legacy tokens. Mirrors access-http.ts review/resolve exactly.
    const targetPair = readPair(ctx.service.memoryDir, pid);
    if (targetPair) {
      enforceNamespaceAllowList(
        tokenCapabilityStore.getStore(),
        targetPair.namespace,
        ctx.service.configRef?.defaultNamespace,
      );
    }
    return { result: await executeResolution(ctx.service.memoryDir, ctx.service.storageRef, pid, vb, { mergedMemoryId: optStr(input.mergedMemoryId), mergedContent: optStr(input.mergedContent), storageForNamespace: async (namespace) => { const r = await ctx.service.getWritableStorageForNamespace(namespace, ctx.authenticatedPrincipal); return r.storage; }, onMergedMemoryWritten: () => {} }) };
  },
});
defineOperation({ name: "contradiction_scan_run", description: "Run scan.", schema: strictSchema({ namespace: S.str }), handler: async (input, ctx) => ({ result: await runContradictionScan({ storage: ctx.service.storageRef, config: ctx.service.configRef, memoryDir: ctx.service.memoryDir, embeddingLookupFactory: ctx.service.embeddingLookupFactoryRef, storageForNamespace: (ns) => ctx.service.getWritableStorageForNamespace(ns ?? undefined, ctx.authenticatedPrincipal), localLlm: ctx.service.localLlmRef, fallbackLlm: ctx.service.fallbackLlmRef, namespace: optStr(input.namespace) }) }) });
defineOperation({ name: "preference_drift_scan", description: "Run preference drift scan.", schema: strictSchema({ namespace: S.str, apply: S.bool }), handler: async (input, ctx) => ({ result: await runPreferenceDriftScan({ storage: ctx.service.storageRef, config: ctx.service.configRef, memoryDir: ctx.service.memoryDir, embeddingLookupFactory: ctx.service.embeddingLookupFactoryRef, storageForNamespace: (ns) => ctx.service.getWritableStorageForNamespace(ns ?? undefined, ctx.authenticatedPrincipal), localLlm: ctx.service.localLlmRef, fallbackLlm: ctx.service.fallbackLlmRef, namespace: optStr(input.namespace), apply: input.apply === true }) }) });
defineOperation({ name: "graph_edge_decay_run", description: "Run edge decay.", fleetWide: true, schema: strictSchema({ dryRun: S.bool }), handler: async (input, ctx) => { const cfg = ctx.service.configRef; if (!cfg.graphEdgeDecayEnabled) return { result: { ranAt: new Date().toISOString(), disabled: true, reason: "graphEdgeDecayEnabled is false" } }; return { result: { results: await runGraphEdgeDecayMaintenanceAcrossNamespaces(ctx.service.memoryDir, { windowMs: cfg.graphEdgeDecayWindowMs, perWindow: cfg.graphEdgeDecayPerWindow, floor: cfg.graphEdgeDecayFloor, visibilityThreshold: cfg.graphEdgeDecayVisibilityThreshold, dryRun: input.dryRun === true, namespacesEnabled: cfg.namespacesEnabled === true, defaultNamespace: cfg.defaultNamespace }) } }; } });

// === SUMMARIZE/PROFILING/PEERS/CONSOLE/DREAMS ===
defineOperation({ name: "memory_summarize_hourly", description: "Hourly summarize.", fleetWide: true, schema: strictSchema({}), handler: async (_i, ctx) => ({ result: await ctx.service.memorySummarizeHourly() }) });
defineOperation({ name: "conversation_index_update", description: "Update conv index.", fleetWide: true, schema: strictSchema({ sessionKey: S.str, hours: S.num, embed: S.bool }), handler: async (input, ctx) => { if (input.sessionKey !== undefined && typeof input.sessionKey !== "string") throw new EngramAccessInputError("sessionKey must be a string when provided"); return { result: await ctx.service.conversationIndexUpdate({ sessionKey: optStr(input.sessionKey), hours: optNum(input.hours), embed: optBool(input.embed) }) }; } });
defineOperation({ name: "profiling_report", description: "Profiling report.", schema: strictSchema({ format: S.str, limit: S.num }), handler: async (input, ctx) => { if (input.format !== undefined && typeof input.format !== "string") throw new EngramAccessInputError("format must be a string when provided"); if (input.limit !== undefined && typeof input.limit !== "number") throw new EngramAccessInputError("limit must be a number when provided"); return { result: await ctx.service.profilingReport({ format: optStr(input.format), limit: optNum(input.limit) }) }; } });
defineOperation({ name: "live_connectors_run", description: "Run connectors.", fleetWide: true, schema: strictSchema({ force: S.bool }), handler: async (input, ctx) => ({ result: await ctx.service.liveConnectorsRun({ authenticatedPrincipal: ctx.authenticatedPrincipal, force: input.force === true }, ctx.authenticatedPrincipal) }) });
defineOperation({ name: "peer_list", description: "List peers.", schema: strictSchema({}), handler: async (_i, ctx) => ({ result: await ctx.service.peerList() }) });
defineOperation({ name: "peer_get", description: "Get peer.", schema: strictSchema({ id: S.str }), handler: async (input, ctx) => { const id = defStr(input.id, ""); if (!id) throw new EngramAccessInputError("peer_get: id is required"); return { result: await ctx.service.peerGet(id) }; } });
defineOperation({ name: "peer_set", description: "Set peer.", schema: strictSchema({ id: S.str, kind: S.str, displayName: S.str, notes: S.str }), handler: async (input, ctx) => { const id = defStr(input.id, ""); if (!id) throw new EngramAccessInputError("peer_set: id is required"); if (input.kind !== undefined && typeof input.kind !== "string") throw new EngramAccessInputError("peer_set: kind must be a string when provided"); if (input.displayName !== undefined && typeof input.displayName !== "string") throw new EngramAccessInputError("peer_set: displayName must be a string when provided"); if (input.notes !== undefined && typeof input.notes !== "string") throw new EngramAccessInputError("peer_set: notes must be a string when provided"); return { result: await ctx.service.peerSet({ id, kind: optStr(input.kind), displayName: optStr(input.displayName), notes: optStr(input.notes) }) }; } });
defineOperation({ name: "peer_delete", description: "Delete peer.", schema: strictSchema({ id: S.str }), handler: async (input, ctx) => { const id = defStr(input.id, ""); if (!id) throw new EngramAccessInputError("peer_delete: id is required"); return { result: await ctx.service.peerDelete(id) }; } });
defineOperation({ name: "peer_profile_get", description: "Get peer profile.", schema: strictSchema({ id: S.str }), handler: async (input, ctx) => { const id = defStr(input.id, ""); if (!id) throw new EngramAccessInputError("peer_profile_get: id is required"); return { result: await ctx.service.peerProfileGet(id) }; } });
defineOperation({ name: "peer_forget", description: "Forget peer.", schema: strictSchema({ id: S.str, confirm: S.str }), handler: async (input, ctx) => { const id = defStr(input.id, ""); if (!id) throw new EngramAccessInputError("peer_forget: id is required"); const c = optStr(input.confirm) ?? ""; if (c !== "yes") throw new EngramAccessInputError("peer_forget: confirm must be 'yes' to prevent accidental data loss"); return { result: await ctx.service.peerForget(id, { confirm: "yes" }) }; } });
defineOperation({ name: "console_state", description: "Console state.", schema: strictSchema({ namespace: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.consoleState(optStr(input.namespace), ctx.authenticatedPrincipal) }) });
defineOperation({ name: "dreams_status", description: "Dreams status.", schema: strictSchema({ windowHours: S.num, namespace: S.str }), handler: async (input, ctx) => { let wh = 24; try { wh = normalizeDreamsStatusWindowHours(input.windowHours); } catch { throw new EngramAccessInputError("dreams_status: windowHours must be a positive integer. Got: " + String(input.windowHours)); } return { result: await ctx.service.dreamsStatus({ windowHours: wh, namespace: optStr(input.namespace), principal: ctx.authenticatedPrincipal }) }; } });
defineOperation({ name: "dreams_run", description: "Run dreams.", schema: strictSchema({ phase: S.str, dryRun: S.bool, namespace: S.str }), handler: async (input, ctx) => { const VP = ["lightSleep", "rem", "deepSleep"]; const ph = optStr(input.phase) ?? ""; if (!ph || !VP.includes(ph)) throw new EngramAccessInputError("dreams_run: phase must be one of: " + VP.join(", ")); if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") throw new EngramAccessInputError("dreams_run: dryRun must be boolean"); return { result: await ctx.service.dreamsRun({ phase: ph as DreamsPhase, dryRun: input.dryRun === true, namespace: optStr(input.namespace), authenticatedPrincipal: ctx.authenticatedPrincipal }) }; } });

defineOperation({ name: "correction_pending", description: "List pending corrections (HTTP GET).", schema: strictSchema({ namespace: S.str, sessionKey: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.correctionListPending({ namespace: optStr(input.namespace), sessionKey: optStr(input.sessionKey), principal: ctx.authenticatedPrincipal }) }) });

// === HTTP-ONLY ===
defineOperation({ name: "offline_sync_snapshot", description: "Offline sync snapshot.", schema: strictSchema({}), handler: async (_i, ctx) => ({ result: await ctx.service.offlineSyncSnapshot() }) });
defineOperation({ name: "offline_sync_files", description: "Offline sync files.", schema: strictSchema({ paths: S.strArr, namespace: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.offlineSyncFiles({ paths: optStrArr(input.paths) ?? [], namespace: optStr(input.namespace), principal: ctx.authenticatedPrincipal }) }) });
defineOperation({ name: "offline_sync_file_content", description: "Read file content.", schema: strictSchema({ path: S.str, namespace: S.str, offset: S.num, length: S.num }), handler: async (input, ctx) => ({ result: await ctx.service.offlineSyncFileContent({ path: optStr(input.path) ?? "", namespace: optStr(input.namespace), principal: ctx.authenticatedPrincipal, offset: optNum(input.offset), length: optNum(input.length) }) }) });
defineOperation({ name: "offline_sync_apply_file_content", description: "Apply file content.", schema: strictSchema({ sourceId: S.str, path: S.str, sha256: S.str, bytes: S.num, mtimeMs: S.num, offset: S.num, baseSha256: S.str, content: S.str, namespace: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.offlineSyncApplyFileContent({ sourceId: optStr(input.sourceId) ?? "", path: optStr(input.path) ?? "", sha256: optStr(input.sha256) ?? "", bytes: optNum(input.bytes) ?? 0, mtimeMs: optNum(input.mtimeMs) ?? 0, offset: optNum(input.offset), baseSha256: optStr(input.baseSha256), content: Buffer.from(defStr(input.content, ""), "base64"), namespace: optStr(input.namespace), principal: ctx.authenticatedPrincipal }) }) });
defineOperation({ name: "offline_sync_apply", description: "Apply sync.", schema: strictSchema({ changeset: z.unknown().optional(), namespace: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.offlineSyncApply({ changeset: input.changeset, namespace: optStr(input.namespace), principal: ctx.authenticatedPrincipal }) }) });
defineOperation({ name: "lcm_status", description: "LCM status.", schema: strictSchema({}), handler: async (_i, ctx) => ({ result: await ctx.service.lcmStatus() }) });
defineOperation({ name: "memory_list", description: "List memories.", schema: strictSchema({}), handler: async (_i, ctx) => ({ result: await ctx.service.memoryBrowse() }) });
defineOperation({
  name: "recall_timings",
  description: "List recent recall timings.",
  schema: strictSchema({}),
  handler: async (_input, ctx) => {
    if (
      !isRecallTimingsOperator(
        ctx.service.configRef,
        ctx.authenticatedPrincipal,
        ctx.operatorPrincipal,
      )
    ) {
      throw new EngramAccessForbiddenError("recall timings require the configured operator principal");
    }
    return { result: getRecallTimingStatus(ctx.service.configRef) };
  },
});
defineOperation({ name: "entity_list", description: "List entities.", schema: strictSchema({}), handler: async (_i, ctx) => ({ result: await ctx.service.entityList() }) });
defineOperation({ name: "maintenance_status", description: "Maintenance status.", schema: strictSchema({}), handler: async (_i, ctx) => ({ result: await ctx.service.maintenance() }) });
defineOperation({ name: "quality_status", description: "Quality status.", schema: strictSchema({}), handler: async (_i, ctx) => ({ result: await ctx.service.quality() }) });
defineOperation({ name: "trust_zones_status", description: "Trust-zone status.", schema: strictSchema({}), handler: async (_i, ctx) => ({ result: await ctx.service.trustZoneStatus() }) });
defineOperation({ name: "trust_zones_records", description: "Browse trust-zone records.", schema: strictSchema({ namespace: S.str, limit: S.num, offset: S.num }), handler: async (input, ctx) => ({ result: await ctx.service.trustZoneBrowse({ namespace: optStr(input.namespace), limit: optNum(input.limit), offset: optNum(input.offset) }, ctx.authenticatedPrincipal) }) });
defineOperation({ name: "review_disposition", description: "Review disposition.", schema: strictSchema({ memoryId: S.str, status: S.str, reasonCode: S.str, namespace: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.reviewDisposition({ memoryId: optStr(input.memoryId) ?? "", status: (optStr(input.status) ?? "archived") as never, reasonCode: optStr(input.reasonCode) ?? "", namespace: optStr(input.namespace), authenticatedPrincipal: ctx.authenticatedPrincipal }) }) });
defineOperation({ name: "review_deck_list", description: "List review deck.", schema: strictSchema({ namespace: S.str, cursor: S.str, limit: S.num }), handler: async (input, ctx) => ({ result: await ctx.service.reviewDeckList({ namespace: optStr(input.namespace), principal: ctx.authenticatedPrincipal, cursor: optStr(input.cursor), limit: optNum(input.limit) ?? 1 }) }) });
defineOperation({ name: "review_deck_action", description: "Apply review deck action.", schema: strictSchema({ itemId: S.str, revision: S.str, action: S.str, correctionText: S.str, idempotencyKey: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.reviewDeckAction({ schemaVersion: 1, itemId: reqStr(input.itemId, "itemId"), revision: reqStr(input.revision, "revision"), action: reqStr(input.action, "action") as "keep", idempotencyKey: reqStr(input.idempotencyKey, "idempotencyKey"), ...(optStr(input.correctionText) ? { correctionText: optStr(input.correctionText)! } : {}) } as never, { principal: ctx.authenticatedPrincipal, signal: ctx.abortSignal }) }) });
defineOperation({ name: "review_deck_undo", description: "Undo review deck action.", schema: strictSchema({ receiptId: S.str, expectedRevision: S.str, idempotencyKey: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.reviewDeckUndo({ schemaVersion: 1, receiptId: reqStr(input.receiptId, "receiptId"), expectedRevision: reqStr(input.expectedRevision, "expectedRevision"), idempotencyKey: reqStr(input.idempotencyKey, "idempotencyKey") }, { principal: ctx.authenticatedPrincipal, signal: ctx.abortSignal }) }) });
defineOperation({ name: "trust_zones_promote", description: "Promote trust-zone.", schema: strictSchema({ recordId: S.str, targetZone: S.str, promotionReason: S.str, dryRun: S.bool, namespace: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.trustZonePromote({ recordId: optStr(input.recordId) ?? "", targetZone: (optStr(input.targetZone) ?? "working") as never, promotionReason: optStr(input.promotionReason) ?? "", dryRun: input.dryRun === true, namespace: optStr(input.namespace), authenticatedPrincipal: ctx.authenticatedPrincipal }) }) });
defineOperation({ name: "trust_zones_demo_seed", description: "Demo seed.", schema: strictSchema({ scenario: S.str, dryRun: S.bool, namespace: S.str }), handler: async (input, ctx) => ({ result: await ctx.service.trustZoneDemoSeed({ scenario: optStr(input.scenario), dryRun: input.dryRun === true, namespace: optStr(input.namespace), authenticatedPrincipal: ctx.authenticatedPrincipal }) }) });
defineOperation({ name: "citations_observed", description: "Record citations.", schema: strictSchema({}), handler: async (_i, _ctx) => ({ result: { ok: true } }) });
defineOperation({ name: "contradiction_detail", description: "Contradiction detail.", schema: strictSchema({ id: S.str, namespace: S.str }), handler: async (input, ctx) => ({ result: await listPairs(ctx.service.memoryDir, { filter: "all" as const, namespace: optStr(input.namespace), includeUnscopedForNamespace: false, limit: 1 }) }) });
defineOperation({ name: "offline_sync_snapshot_stream", description: "SSE stream.", schema: strictSchema({}), handler: async (_i, ctx) => ({ result: await ctx.service.offlineSyncSnapshotStream() }) });
defineOperation({ name: "graph_events", description: "SSE graph events.", schema: strictSchema({}), handler: async (_i, _ctx) => ({ result: { stream: "sse" } }) });
defineOperation({ name: "chat_message", description: "Chat message.", schema: strictSchema({ message: S.str, chatSessionId: S.str }), handler: async (_i, _ctx) => ({ result: { ok: true } }) });
defineOperation({ name: "chat_events", description: "SSE chat events.", schema: strictSchema({}), handler: async (_i, _ctx) => ({ result: { stream: "sse" } }) });
defineOperation({ name: "adapters_status", description: "Adapter registry metadata (issue #1850 round 5). Marker op: the HTTP transport builds the response from its own adapterRegistry, but the op still must be registered so it appears in listRegisteredOperations and enforceTokenOp can gate it for scoped tokens.", schema: strictSchema({}), handler: async (_i, _ctx) => ({ result: { ok: true } }) });
