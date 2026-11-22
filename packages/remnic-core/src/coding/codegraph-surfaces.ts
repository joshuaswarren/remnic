/**
 * Codegraph parity surface contract + handler (issue #1554).
 *
 * Mirrors the decision-surfaces.ts / architecture-surfaces.ts pattern: one
 * shared implementation behind the MCP, HTTP, and CLI surfaces. All three
 * transports dispatch through the `codegraph_*` boundary operations, which
 * call {@link handleCodegraphTool} via the service delegate.
 *
 * Gate (rule 39): `codingKnowledge.enabled + codegraphTools + runtime
 * availability` -- one predicate (`codegraphSurfaceVisible`), checked
 * identically on every surface. The tools/list visibility gate uses the
 * config-only predicate; the call-time gate re-checks config AND runtime
 * availability AND (for tools that touch a per-session project) a coding
 * context.
 *
 * Reuse, don't fork (rule 22): `manage_adr` reuses Track A's decision
 * records (`coding/decision-records.ts`); `get_architecture` composes
 * Track A's architecture card with live graph stats. Zero duplicated ADR
 * or architecture-card logic.
 */
import type { PluginConfig, CodingContext } from "../types.js";
import { codingContextLocalRoot } from "../access-coding-context-resolution.js";
import {
  codegraphRuntimeAvailable,
  codegraphSurfaceVisible,
  getCodegraphStore,
  listCodegraphProjects,
  deleteCodegraphProject,
  CodegraphRuntimeError,
  type CodegraphStore,
  type CodegraphSchemaStatsResult,
} from "./codegraph-runtime.js";
import {
  DECISION_SUBCOMMANDS,
  handleCodingDecision,
  type DecisionSurfaceContext,
  type DecisionSurfaceRequest,
  type DecisionSurfaceResponse,
} from "./decision-surfaces.js";
import { isCodingKnowledgeFeatureEnabled } from "./coding-knowledge-config.js";

// ──────────────────────────────────────────────────────────────────────────

export const CODEGRAPH_TOOL_NAMES = [
  "index",
  "list_projects",
  "delete_project",
  "index_status",
  "search_graph",
  "trace_path",
  "detect_changes",
  "query_graph",
  "get_schema",
  "get_snippet",
  "get_architecture",
  "search_code",
  "manage_adr",
  "ingest_traces",
] as const;

export type CodegraphToolName = (typeof CODEGRAPH_TOOL_NAMES)[number];

const TOOL_NAME_SET: ReadonlySet<string> = new Set(CODEGRAPH_TOOL_NAMES as readonly string[]);

export function isCodegraphToolName(value: unknown): value is CodegraphToolName {
  return typeof value === "string" && TOOL_NAME_SET.has(value);
}

export function formatCodegraphToolNames(): string {
  return CODEGRAPH_TOOL_NAMES.join(", ");
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

/**
 * Canonical surface request — one shape for all three transports. `tool`
 * selects which codegraph operation runs; `sessionKey`/`principal`/`project`
 * scope the per-project GraphStore lookup; remaining fields are
 * tool-specific and validated by the handler.
 */
export interface CodegraphSurfaceRequest {
  readonly tool: CodegraphToolName;
  readonly sessionKey?: string;
  readonly principal?: string;
  /** Explicit project id; defaults to the session's coding-context projectId. */
  readonly project?: string;
  readonly query?: string;
  readonly limit?: number;
  readonly start?: string;
  readonly direction?: string;
  readonly depth?: number;
  readonly qualifiedName?: string;
  readonly path?: string;
  // query_graph (structured; Cypher passthrough is rejected)
  readonly structuredQuery?: Record<string, unknown>;
  readonly head?: string;
  readonly repoRoot?: string;
  readonly mode?: string;
  readonly confirm?: boolean;
  readonly subcommand?: string;
  readonly id?: string;
  readonly title?: string;
  readonly status?: string;
  readonly context?: string;
  readonly decision?: string;
  readonly consequences?: string;
  readonly entityRefs?: string[];
  readonly supersedesId?: string;
  readonly traces?: unknown[];
}

export type CodegraphSurfaceResponse =
  | { tool: CodegraphToolName; ok: true; result: unknown }
  | { tool: CodegraphToolName; ok: false; code: string; message: string };

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

/** Outcome of a reindex run (mirrors @remnic/coding-graph ReindexResult). */
export type CodegraphReindexOutcome =
  | { ok: true; mode: string; filesIngested: number; head: string | null }
  | { ok: false; code: string; message: string };

export type CodegraphIndexStatusOutcome =
  | { ok: true; status: Record<string, unknown> }
  | { ok: false; code: string; message: string };

/** Outcome of a detect_changes / blast-radius computation. */
export type CodegraphDetectChangesOutcome =
  | { ok: true; affected: readonly unknown[] }
  | { ok: false; code: string; message: string };

/** Outcome of trace ingestion (persisted edges). */
export type CodegraphIngestTracesOutcome =
  | { ok: true; accepted: number; persisted: number }
  | { ok: false; code: string; message: string };

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

const TRACE_DIRECTIONS = ["inbound", "outbound", "both"] as const;
const TRACE_DIRECTION_SET: ReadonlySet<string> = new Set(TRACE_DIRECTIONS as readonly string[]);

const INDEX_MODES = ["auto", "full", "incremental"] as const;
const INDEX_MODE_SET: ReadonlySet<string> = new Set(INDEX_MODES as readonly string[]);

const MANAGE_ADR_SUBCOMMANDS = DECISION_SUBCOMMANDS;

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

/**
 * Dependencies the handler borrows from the service. The service constructs
 * this context per call; the handler never touches the orchestrator or
 * access-service directly. `throwInputError` lets the handler raise the
 * surface-appropriate error class without a circular import.
 */
export interface CodegraphSurfaceContext {
  readonly config: PluginConfig;
  /** Resolved memory dir (used as the default codegraph root). */
  readonly memoryDir: string;
  /** Authenticated principal (HTTP header / MCP session / CLI flag). */
  readonly principal: string;
  getCodingContext(sessionKey: string): CodingContext | null;
  /** Open (or fetch cached) per-project GraphStore. */
  resolveStore(request: CodegraphSurfaceRequest): Promise<CodegraphStore>;
  /** Walk the principal's codegraph dir. */
  listDirs(dir: string): readonly string[];
  /** Remove a file (best-effort, used by delete_project). */
  removeFile(filePath: string): void;
  /** Throw the surface-appropriate input-validation error. */
  throwInputError(message: string): never;
  /** Delegate manage_adr record/supersede to Track A's decision handler. */
  delegateDecisionRecord(request: DecisionSurfaceRequest): Promise<DecisionSurfaceResponse>;
  /** Composed architecture card + graph stats builder (Track A reuse). */
  buildArchitectureCard(repoRoot: string): Promise<unknown>;
  runReindex?(store: CodegraphStore, repoRoot: string, mode: string): Promise<CodegraphReindexOutcome>;
  runLspResolution?(store: CodegraphStore, repoRoot: string, lspConfig: NonNullable<PluginConfig["codingKnowledge"]["lsp"]>): Promise<{ ok: boolean; code?: string; upgraded?: number; unresolved?: number; budgetExhausted?: number; message?: string; degradations?: Array<{ language: string; code: string; message: string }> }>;
  reportIndexStatus?(store: CodegraphStore, repoRoot: string): Promise<CodegraphIndexStatusOutcome>;
  detectChanges?(store: CodegraphStore, repoRoot: string, head: string): Promise<CodegraphDetectChangesOutcome>;
  ingestTraces?(store: CodegraphStore, traces: readonly unknown[]): Promise<CodegraphIngestTracesOutcome>;
}

/**
 * The single shared implementation behind the MCP, HTTP, and CLI codegraph
 * tool surfaces. All three transports dispatch through the `codegraph_*`
 * boundary operations, which call this function via the service delegate.
 */
export async function handleCodegraphTool(
  request: CodegraphSurfaceRequest,
  ctx: CodegraphSurfaceContext,
): Promise<CodegraphSurfaceResponse> {
  if (!codegraphSurfaceVisible(ctx.config)) {
    return disabledResponse(request.tool, "codegraph tools are disabled in config");
  }

  switch (request.tool) {
    case "list_projects":
      return handleListProjects(request, ctx);
    case "get_schema":
      return withStore(request, ctx, (store) => handleGetSchema(store, request.tool));
    case "search_graph":
      return withStore(request, ctx, (store) => handleSearchGraph(store, request, ctx));
    case "search_code":
      return withStore(request, ctx, (store) => handleSearchCode(store, request, ctx));
    case "trace_path":
      return withStore(request, ctx, (store) => handleTracePath(store, request, ctx));
    case "get_snippet":
      return withStore(request, ctx, (store) => handleGetSnippet(store, request, ctx));
    case "query_graph":
      return withStore(request, ctx, (store) => handleQueryGraph(store, request, ctx));
    case "index_status":
      return withStore(request, ctx, (store) => handleIndexStatus(store, request, ctx));
    case "detect_changes":
      return withStore(request, ctx, (store) => handleDetectChanges(store, request, ctx));
    case "index":
      return handleIndex(request, ctx);
    case "delete_project":
      return handleDeleteProject(request, ctx);
    case "get_architecture":
      return handleGetArchitecture(request, ctx);
    case "manage_adr":
      return handleManageAdr(request, ctx);
    case "ingest_traces":
      return withStore(request, ctx, (store) => handleIngestTraces(store, request, ctx));
    default: {
      const _exhaustive: never = request.tool;
      void _exhaustive;
      ctx.throwInputError(`unknown codegraph tool: ${request.tool}`);
    }
  }
}

function disabledResponse(tool: CodegraphToolName, message: string): CodegraphSurfaceResponse {
  return { tool, ok: false, code: "disabled", message };
}

/**
 * Resolve the per-project store and run `fn`. Translates
 * {@link CodegraphRuntimeError} codes into the surface response shape so
 * the transport layer never has to pattern-match on error class.
 */
async function withStore(
  request: CodegraphSurfaceRequest,
  ctx: CodegraphSurfaceContext,
  fn: (store: CodegraphStore) => Promise<CodegraphSurfaceResponse>,
): Promise<CodegraphSurfaceResponse> {
  let store: CodegraphStore;
  try {
    store = await ctx.resolveStore(request);
  } catch (err) {
    if (err instanceof CodegraphRuntimeError) {
      return { tool: request.tool, ok: false, code: err.code, message: err.message };
    }
    throw err;
  }
  return fn(store);
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

async function handleListProjects(
  request: CodegraphSurfaceRequest,
  ctx: CodegraphSurfaceContext,
): Promise<CodegraphSurfaceResponse> {
  const projects = listCodegraphProjects({
    config: ctx.config,
    memoryDir: ctx.memoryDir,
    principal: ctx.principal,
    listDir: ctx.listDirs,
  });
  return { tool: request.tool, ok: true, result: { projects } };
}

async function handleGetSchema(
  store: CodegraphStore,
  tool: CodegraphToolName,
): Promise<CodegraphSurfaceResponse> {
  const stats = store.schemaStats();
  if (!stats.ok) {
    return { tool, ok: false, code: stats.code, message: "schemaStats failed" };
  }
  return { tool, ok: true, result: stats };
}

async function handleSearchGraph(
  store: CodegraphStore,
  request: CodegraphSurfaceRequest,
  ctx: CodegraphSurfaceContext,
): Promise<CodegraphSurfaceResponse> {
  const query = requireString(request.query, "query", ctx);
  const limit = clampPositiveInteger(request.limit, 50, "limit", ctx);
  // Map the surface `query` to the store's SearchQuery shape: the store's
  // searchGraph reads `namePattern` (not `query`) for symbol-name matching.
  const result = store.searchGraph({ namePattern: query, limit });
  if (!result.ok) {
    return { tool: request.tool, ok: false, code: result.code, message: "searchGraph failed" };
  }
  return { tool: request.tool, ok: true, result };
}

/** Symbol kinds search_code limits results to (issue #1554 rejection table). */
const SEARCH_CODE_KINDS = ["function", "class", "method"] as const;

async function handleSearchCode(
  store: CodegraphStore,
  request: CodegraphSurfaceRequest,
  ctx: CodegraphSurfaceContext,
): Promise<CodegraphSurfaceResponse> {
  const query = requireString(request.query, "query", ctx);
  const limit = clampPositiveInteger(request.limit, 50, "limit", ctx);
  const seen = new Set<string>();
  const merged: unknown[] = [];
  for (const kind of SEARCH_CODE_KINDS) {
    if (merged.length >= limit) break;
    const result = store.searchGraph({ label: kind, namePattern: query, limit });
    if (!result.ok) {
      return { tool: request.tool, ok: false, code: result.code, message: "searchGraph failed" };
    }
    for (const hit of result.hits as readonly Record<string, unknown>[]) {
      const id = typeof hit?.nodeId === "string" ? hit.nodeId : JSON.stringify(hit);
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(hit);
      if (merged.length >= limit) break;
    }
  }
  return { tool: request.tool, ok: true, result: { hits: merged } };
}

async function handleTracePath(
  store: CodegraphStore,
  request: CodegraphSurfaceRequest,
  ctx: CodegraphSurfaceContext,
): Promise<CodegraphSurfaceResponse> {
  const start = requireString(request.start, "start", ctx);
  const direction = request.direction ?? "outbound";
  if (!TRACE_DIRECTION_SET.has(direction)) {
    ctx.throwInputError(
      `direction must be one of ${TRACE_DIRECTIONS.join(", ")}; got ${JSON.stringify(direction)}`,
    );
  }
  const depth = clampPositiveInteger(request.depth ?? 2, 2, "depth", ctx);
  // Map the surface direction names to the store's contract: the store
  // expects `incoming`/`outgoing`/`both` and `maxDepth` (not depth).
  const storeDirection = direction === "outbound" ? "outgoing" : direction === "inbound" ? "incoming" : direction;
  const result = store.traverse({ start, direction: storeDirection, maxDepth: depth });
  if (!result.ok) {
    return { tool: request.tool, ok: false, code: result.code, message: "traverse failed" };
  }
  return { tool: request.tool, ok: true, result };
}

async function handleGetSnippet(
  store: CodegraphStore,
  request: CodegraphSurfaceRequest,
  ctx: CodegraphSurfaceContext,
): Promise<CodegraphSurfaceResponse> {
  const qualifiedName = requireString(request.qualifiedName, "qualifiedName", ctx);
  const result = await store.snippetFor({ qualifiedName });
  if (!result.ok) {
    return { tool: request.tool, ok: false, code: result.code, message: "snippetFor failed" };
  }
  return { tool: request.tool, ok: true, result };
}

async function handleQueryGraph(
  store: CodegraphStore,
  request: CodegraphSurfaceRequest,
  ctx: CodegraphSurfaceContext,
): Promise<CodegraphSurfaceResponse> {
  if (typeof request.query === "string" && isLikelyCypher(request.query)) {
    ctx.throwInputError(
      "codegraph_query_graph does not accept Cypher text; pass a structured query via structuredQuery (issue #1554 rejection table)",
    );
  }
  if (request.structuredQuery === undefined) {
    ctx.throwInputError("codegraph_query_graph requires structuredQuery");
  }
  // The structured query is forwarded verbatim; the store validates the
  // inner shape. The surface never interprets query internals.
  const result = store.searchGraph(request.structuredQuery);
  if (!result.ok) {
    return { tool: request.tool, ok: false, code: result.code, message: "searchGraph failed" };
  }
  return { tool: request.tool, ok: true, result };
}

async function handleIndexStatus(
  store: CodegraphStore,
  request: CodegraphSurfaceRequest,
  ctx: CodegraphSurfaceContext,
): Promise<CodegraphSurfaceResponse> {
  const repoRoot = resolveRepoRoot(request, ctx);
  if (!ctx.reportIndexStatus) {
    return {
      tool: request.tool,
      ok: false,
      code: "runtime_unavailable",
      message: "index_status requires @remnic/coding-graph; the runtime is unavailable.",
    };
  }
  void store; // store resolved by withStore; the delegate opens its own read path.
  const outcome = await ctx.reportIndexStatus(store, repoRoot);
  if (!outcome.ok) {
    return { tool: request.tool, ok: false, code: outcome.code, message: outcome.message };
  }
  return { tool: request.tool, ok: true, result: outcome.status };
}

async function handleDetectChanges(
  store: CodegraphStore,
  request: CodegraphSurfaceRequest,
  ctx: CodegraphSurfaceContext,
): Promise<CodegraphSurfaceResponse> {
  const head = requireString(request.head, "head", ctx);
  if (!ctx.detectChanges) {
    return {
      tool: request.tool,
      ok: false,
      code: "runtime_unavailable",
      message: "detect_changes requires @remnic/coding-graph; the runtime is unavailable.",
    };
  }
  const repoRoot = resolveRepoRoot(request, ctx);
  void store;
  const outcome = await ctx.detectChanges(store, repoRoot, head);
  if (!outcome.ok) {
    return { tool: request.tool, ok: false, code: outcome.code, message: outcome.message };
  }
  return { tool: request.tool, ok: true, result: { head, affected: outcome.affected } };
}

async function handleIndex(
  request: CodegraphSurfaceRequest,
  ctx: CodegraphSurfaceContext,
): Promise<CodegraphSurfaceResponse> {
  const repoRoot = requireString(request.repoRoot, "repoRoot", ctx);
  const modeRaw = request.mode ?? "auto";
  if (!INDEX_MODE_SET.has(modeRaw)) {
    ctx.throwInputError(`mode must be one of ${INDEX_MODES.join(", ")}; got ${JSON.stringify(modeRaw)}`);
  }
  //
  // Open the per-project store. The reindex itself is invoked explicitly
  // via ctx.runReindex below — GraphStore.open only creates/applies the
  // schema; it does NOT parse or ingest files (P1 fix: previously the
  // handler returned ok:true after open + schemaStats without reindexing).
  //
  const resolveReq = { ...request, repoRoot } as CodegraphSurfaceRequest;
  let store: CodegraphStore;
  try {
    store = await ctx.resolveStore(resolveReq);
  } catch (err) {
    if (err instanceof CodegraphRuntimeError) {
      return { tool: request.tool, ok: false, code: err.code, message: err.message };
    }
    throw err;
  }
  if (!ctx.runReindex) {
    return {
      tool: request.tool,
      ok: false,
      code: "runtime_unavailable",
      message: "index requires @remnic/coding-graph's reindex executor; the runtime is unavailable.",
    };
  }
  const outcome = await ctx.runReindex(store, repoRoot, modeRaw);
  if (!outcome.ok) {
    return { tool: request.tool, ok: false, code: outcome.code, message: outcome.message };
  }
  let lspUpgradeSummary:
    | {
        upgraded: number;
        unresolved: number;
        budgetExhausted: number;
        degradations?: ReadonlyArray<{ language: string; code: string; message: string }>;
      }
    | { error: string; message: string }
    | undefined;
  const lspConfig = ctx.config.codingKnowledge.lsp;
  if (lspConfig?.enabled === true && ctx.runLspResolution) {
    const lspResult = await ctx.runLspResolution(store, repoRoot, lspConfig);
    lspUpgradeSummary = lspResult.ok
      ? {
          upgraded: lspResult.upgraded ?? 0,
          unresolved: lspResult.unresolved ?? 0,
          budgetExhausted: lspResult.budgetExhausted ?? 0,
          ...(lspResult.degradations !== undefined && lspResult.degradations.length > 0
            ? { degradations: lspResult.degradations }
            : {}),
        }
      : { error: lspResult.code ?? "lsp_error", message: lspResult.message ?? "" };
  }
  const stats = store.schemaStats();
  return {
    tool: request.tool,
    ok: true,
    result: {
      repoRoot,
      mode: outcome.mode,
      filesIngested: outcome.filesIngested,
      head: outcome.head,
      stats,
      ...(lspUpgradeSummary ? { lsp: lspUpgradeSummary } : {}),
    },
  };
}

async function handleDeleteProject(
  request: CodegraphSurfaceRequest,
  ctx: CodegraphSurfaceContext,
): Promise<CodegraphSurfaceResponse> {
  const projectId = resolveProjectId(request, ctx);
  if (request.confirm !== true) {
    return {
      tool: request.tool,
      ok: false,
      code: "confirm_required",
      message: "codegraph_delete_project requires confirm: true (rule 48)",
    };
  }
  try {
    const result = await deleteCodegraphProject({
      config: ctx.config,
      memoryDir: ctx.memoryDir,
      principal: ctx.principal,
      projectId,
      confirm: true,
      removeFile: ctx.removeFile,
    });
    return { tool: request.tool, ok: true, result };
  } catch (err) {
    if (err instanceof CodegraphRuntimeError) {
      return { tool: request.tool, ok: false, code: err.code, message: err.message };
    }
    throw err;
  }
}

async function handleGetArchitecture(
  request: CodegraphSurfaceRequest,
  ctx: CodegraphSurfaceContext,
): Promise<CodegraphSurfaceResponse> {
  const codingContext = resolveCodingContext(request, ctx);
  const repoRoot = request.repoRoot ?? codingContextLocalRoot(codingContext);
  const card = await ctx.buildArchitectureCard(repoRoot);
  let stats: CodegraphSchemaStatsResult;
  try {
    const store = await ctx.resolveStore(request);
    stats = store.schemaStats();
  } catch (err) {
    if (err instanceof CodegraphRuntimeError) {
      stats = { ok: false, code: err.code };
    } else {
      throw err;
    }
  }
  return {
    tool: request.tool,
    ok: true,
    result: { card, graphStats: stats },
  };
}

async function handleManageAdr(
  request: CodegraphSurfaceRequest,
  ctx: CodegraphSurfaceContext,
): Promise<CodegraphSurfaceResponse> {
  const subcommand = request.subcommand;
  if (typeof subcommand !== "string" || !(MANAGE_ADR_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    ctx.throwInputError(
      `manage_adr subcommand must be one of ${MANAGE_ADR_SUBCOMMANDS.join(", ")}; got ${JSON.stringify(subcommand)}`,
    );
  }
  const codingContext = resolveCodingContext(request, ctx);
  if (!isCodingKnowledgeFeatureEnabled(ctx.config.codingKnowledge, "decisionRecords", codingContext)) {
    return disabledResponse(
      request.tool,
      "manage_adr requires codingKnowledge.enabled + decisionRecords + an attached coding context",
    );
  }
  const decisionRequest: DecisionSurfaceRequest = {
    subcommand: subcommand as DecisionSurfaceRequest["subcommand"],
    sessionKey: request.sessionKey,
    id: request.id,
    title: request.title,
    status: request.status,
    context: request.context,
    decision: request.decision,
    consequences: request.consequences,
    entityRefs: request.entityRefs,
    supersedesId: request.supersedesId,
  };
  const result = await ctx.delegateDecisionRecord(decisionRequest);
  return { tool: request.tool, ok: true, result };
}

async function handleIngestTraces(
  store: CodegraphStore,
  request: CodegraphSurfaceRequest,
  ctx: CodegraphSurfaceContext,
): Promise<CodegraphSurfaceResponse> {
  if (!Array.isArray(request.traces)) {
    ctx.throwInputError("codegraph_ingest_traces requires traces: an array of call-site observations");
  }
  if (!ctx.ingestTraces) {
    return {
      tool: request.tool,
      ok: false,
      code: "runtime_unavailable",
      message: "ingest_traces requires @remnic/coding-graph's store write path; the runtime is unavailable.",
    };
  }
  const outcome = await ctx.ingestTraces(store, request.traces);
  if (!outcome.ok) {
    return { tool: request.tool, ok: false, code: outcome.code, message: outcome.message };
  }
  return {
    tool: request.tool,
    ok: true,
    result: {
      accepted: outcome.accepted,
      persisted: outcome.persisted,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

function requireString(value: unknown, field: string, ctx: CodegraphSurfaceContext): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    ctx.throwInputError(`codegraph: ${field} is required and must be a non-empty string`);
  }
  return value as string;
}

function clampPositiveInteger(
  value: number | undefined,
  defaultValue: number,
  field: string,
  ctx: CodegraphSurfaceContext,
): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    ctx.throwInputError(`codegraph: ${field} must be a positive integer; got ${JSON.stringify(value)}`);
  }
  return Math.min(value, 200);
}

function resolveCodingContext(request: CodegraphSurfaceRequest, ctx: CodegraphSurfaceContext): CodingContext {
  if (!request.sessionKey) {
    ctx.throwInputError("codegraph tool requires a sessionKey with an attached coding context");
  }
  const codingContext = ctx.getCodingContext(request.sessionKey);
  if (codingContext === null) {
    ctx.throwInputError(
      `no coding context attached to session ${request.sessionKey}; attach one via set_coding_context first`,
    );
  }
  return codingContext;
}

function resolveProjectId(request: CodegraphSurfaceRequest, ctx: CodegraphSurfaceContext): string {
  if (typeof request.project === "string" && request.project.trim().length > 0) {
    return request.project.trim();
  }
  return resolveCodingContext(request, ctx).projectId;
}

/**
 * Resolve the repo root for index_status / detect_changes. Prefers an
 * explicit `repoRoot` on the request; falls back to the session's coding
 * context rootPath (the same fallback get_architecture uses). Throws a
 * surface input error when neither is available so the runtime delegate
 * never receives an empty root.
 */
function resolveRepoRoot(request: CodegraphSurfaceRequest, ctx: CodegraphSurfaceContext): string {
  if (typeof request.repoRoot === "string" && request.repoRoot.trim().length > 0) {
    return request.repoRoot.trim();
  }
  return codingContextLocalRoot(resolveCodingContext(request, ctx));
}

/**
 * Cheap heuristic for the rejection table: a string starting with a Cypher
 * keyword (`MATCH`, `RETURN`, `WHERE`, ...) is rejected as Cypher text.
 */
function isLikelyCypher(input: string): boolean {
  return /^\s*(MATCH|RETURN|WHERE|CREATE|MERGE|DELETE|WITH|OPTIONAL|CALL|YIELD|UNWIND)\b/i.test(input);
}

export {
  codegraphSurfaceVisible,
  codegraphRuntimeAvailable,
  getCodegraphStore,
};
