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
// Canonical tool names — mirror the external codebase-memory-mcp surface
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

/** Type guard — narrows an unknown string to a {@link CodegraphToolName}. */
export function isCodegraphToolName(value: unknown): value is CodegraphToolName {
  return typeof value === "string" && TOOL_NAME_SET.has(value);
}

/** Human-readable list for error messages (rule 51). */
export function formatCodegraphToolNames(): string {
  return CODEGRAPH_TOOL_NAMES.join(", ");
}

// ──────────────────────────────────────────────────────────────────────────
// Surface request / response shapes
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
  // search_graph / search_code
  readonly query?: string;
  readonly limit?: number;
  // trace_path
  readonly start?: string;
  readonly direction?: string;
  readonly depth?: number;
  // get_snippet
  readonly qualifiedName?: string;
  readonly path?: string;
  // query_graph (structured; Cypher passthrough is rejected)
  readonly structuredQuery?: Record<string, unknown>;
  // detect_changes
  readonly head?: string;
  // index
  readonly repoRoot?: string;
  readonly mode?: string;
  // delete_project
  readonly confirm?: boolean;
  // manage_adr (delegates to Track A's decision records)
  readonly subcommand?: string;
  readonly id?: string;
  readonly title?: string;
  readonly status?: string;
  readonly context?: string;
  readonly decision?: string;
  readonly consequences?: string;
  readonly entityRefs?: string[];
  readonly supersedesId?: string;
  // ingest_traces
  readonly traces?: unknown[];
}

export type CodegraphSurfaceResponse =
  | { tool: CodegraphToolName; ok: true; result: unknown }
  | { tool: CodegraphToolName; ok: false; code: string; message: string };

// ──────────────────────────────────────────────────────────────────────────
// Runtime-delegate outcomes — the handler surfaces these verbatim so the
// surface never reports stub success for index / ingest / status / detect.
// Each delegate is OPTIONAL: when the runtime (@remnic/coding-graph) is
// unavailable, the access-service omits it and the handler degrades with a
// clean code instead of pretending success (P1 fix, issue #1554 review).
// ──────────────────────────────────────────────────────────────────────────

/** Outcome of a reindex run (mirrors @remnic/coding-graph ReindexResult). */
export type CodegraphReindexOutcome =
  | { ok: true; mode: string; filesIngested: number; head: string | null }
  | { ok: false; code: string; message: string };

/** Outcome of an index-status probe (mirrors IndexStatus). The status body
 * is opaque at the surface layer — the runtime delegate returns the real
 * IndexStatus shape from @remnic/coding-graph and the surface passes it
 * through as `result: unknown` (core must not depend on the optional
 * package's exact type). */
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
// Allow-lists for enum-ish params — rule 51 (reject loudly, list options)
// ──────────────────────────────────────────────────────────────────────────

const TRACE_DIRECTIONS = ["inbound", "outbound", "both"] as const;
const TRACE_DIRECTION_SET: ReadonlySet<string> = new Set(TRACE_DIRECTIONS as readonly string[]);

const INDEX_MODES = ["auto", "full", "incremental"] as const;
const INDEX_MODE_SET: ReadonlySet<string> = new Set(INDEX_MODES as readonly string[]);

const MANAGE_ADR_SUBCOMMANDS = DECISION_SUBCOMMANDS;

// ──────────────────────────────────────────────────────────────────────────
// Handler context — the surface service wires this per call
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
  /**
   * Run a reindex via @remnic/coding-graph's executeReindex. Optional — when
   * omitted (runtime unavailable), the index handler degrades with a clean
   * code instead of stub success (P1 fix).
   */
  runReindex?(store: CodegraphStore, repoRoot: string, mode: string): Promise<CodegraphReindexOutcome>;
  /**
   * Run LSP type resolution after a heuristic reindex (issue #1917).
   * Optional — when omitted or when codingKnowledge.lsp is not enabled,
   * the heuristic edges stand alone.
   */
  runLspResolution?(store: CodegraphStore, repoRoot: string, lspConfig: NonNullable<PluginConfig["codingKnowledge"]["lsp"]>): Promise<{ ok: boolean; code?: string; upgraded?: number; unresolved?: number; budgetExhausted?: number; message?: string; degradations?: Array<{ language: string; code: string; message: string }> }>;
  /**
   * Report index status via @remnic/coding-graph's getIndexStatus. Optional —
   * when omitted, index_status degrades with a clean code (no placeholder).
   */
  reportIndexStatus?(store: CodegraphStore, repoRoot: string): Promise<CodegraphIndexStatusOutcome>;
  /**
   * Detect changes / blast radius via @remnic/coding-graph's detect-changes
   * pipeline. Optional — when omitted, detect_changes degrades cleanly.
   */
  detectChanges?(store: CodegraphStore, repoRoot: string, head: string): Promise<CodegraphDetectChangesOutcome>;
  /**
   * Persist runtime call traces as HTTP_CALLS edges via the store's write
   * path. Optional — when omitted, ingest_traces degrades cleanly. The
   * returned `persisted` count is the number of traces actually written.
   */
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
  // Gate 1: config-only predicate. Runtime availability check follows per
  // tool so that `list_projects` (which does not need a store) still works
  // when the package is missing -- it returns the empty list with a clean
  // code rather than throwing.
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
      // Exhaustive: the switch above covers CODEGRAPH_TOOL_NAMES. The
      // default branch exists so a future tool added to the union without
      // a handler here fails closed rather than silently no-oping.
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
// Per-tool handlers — thin adapters over the store's structured API.
// No query logic in the surface layer (issue #1554 design).
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
  // Thread 12 (cursor bugbot): a closed-store / invalid-query failure arrives
  // as { ok: false, code }. The surface MUST mirror that to ok:false so MCP/HTTP
  // clients honoring CodegraphSurfaceResponse.ok do not treat failures as
  // successes (search_code already did this; the other read handlers did not).
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
  // search_code limits results to code symbol kinds (function/class/method).
  // The store's SearchQuery.label takes a SINGLE kind, so query per kind and
  // merge + dedupe by nodeId. The earlier `kinds` array was silently
  // ignored by GraphStore.searchGraph, making this an unfiltered name search
  // (issue #1554 review threads: kind filter must be real, not cosmetic).
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
  // Cypher passthrough is rejected: the store exposes a STRUCTURED query
  // API (searchGraph / traverse / schemaStats / deadCode); a string
  // Cypher query against `query` is the documented rejection-table case.
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
  // Delegate to @remnic/coding-graph's getIndexStatus via the runtime. When
  // the runtime delegate is absent (package missing), degrade with a clean
  // code instead of a placeholder success (issue #1554 review thread).
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
  // Delegate to @remnic/coding-graph's detect-changes + blast-radius
  // pipeline (issue #1553). When the runtime delegate is absent, degrade
  // with a clean code instead of a placeholder success (review thread).
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
  // Open the per-project store. The reindex itself is invoked explicitly
  // via ctx.runReindex below — GraphStore.open only creates/applies the
  // schema; it does NOT parse or ingest files (P1 fix: previously the
  // handler returned ok:true after open + schemaStats without reindexing).
  //
  // Open the per-project store. The reindex itself is invoked explicitly
  // via ctx.runReindex below — GraphStore.open only creates/applies the
  // schema; it does NOT parse or ingest files (P1 fix: previously the
  // handler returned ok:true after open + schemaStats without reindexing).
  //
  // Project derivation for repoRoot-only callers lives in the SHARED
  // resolveStore (access-service.ts) so every store-backed tool — index,
  // search_graph, get_schema, index_status — reopens the SAME DB. No
  // per-handler duplication (issue #1554 review threads 7/9/11).
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
  // Run the reindex executor. When the runtime delegate is absent (package
  // missing), degrade with a clean code instead of stub success.
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
  // LSP Phase B: upgrade unresolved call sites via language servers.
  // Failure is non-fatal (heuristic edges survive) but NEVER silent — the
  // degradation code/message surface in the result so a misconfigured
  // server is diagnosable from the index response (review thread).
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
    // Rule 48: destructive operations are never defaulted to proceed.
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
  const repoRoot = request.repoRoot ?? codingContext.rootPath;
  // Composition (issue #1554): deterministic architecture card from Track A
  // (no live graph) + live graph stats from the per-project store. Two
  // existing sources, one composed response -- no duplicated card logic.
  const card = await ctx.buildArchitectureCard(repoRoot);
  let stats: CodegraphSchemaStatsResult;
  try {
    const store = await ctx.resolveStore(request);
    stats = store.schemaStats();
  } catch (err) {
    if (err instanceof CodegraphRuntimeError) {
      // Architecture card still returns; graph stats degrade to a clean
      // "unavailable" code rather than failing the whole composition.
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
  // Rule 22 reuse: codegraph_manage_adr is a *presentation* of Track A's
  // decision records under the parity tool name. Same store, same status
  // lifecycle, zero duplicate ADR logic. The identity test (issue #1554
  // done-when) asserts that `manage_adr record` and `coding_decision record`
  // write byte-identical records -- both routes call handleCodingDecision.
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
  // Persist traces as HTTP_CALLS edges via the store's write path. The
  // trace→edge upgrade lives in the runtime delegate (P1 fix: previously
  // the handler returned accepted: traces.length without persisting). When
  // the runtime delegate is absent, degrade with a clean code.
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
// Helpers — validation + project resolution
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
  return resolveCodingContext(request, ctx).rootPath;
}

/**
 * Cheap heuristic for the rejection table: a string starting with a Cypher
 * keyword (`MATCH`, `RETURN`, `WHERE`, ...) is rejected as Cypher text.
 */
function isLikelyCypher(input: string): boolean {
  return /^\s*(MATCH|RETURN|WHERE|CREATE|MERGE|DELETE|WITH|OPTIONAL|CALL|YIELD|UNWIND)\b/i.test(input);
}

// Re-export the runtime helpers the access-service delegate uses so the
// surface module is the single import for callers wiring the boundary.
export {
  codegraphSurfaceVisible,
  codegraphRuntimeAvailable,
  getCodegraphStore,
};
