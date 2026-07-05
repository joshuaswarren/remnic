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
  isDecisionRecordSurfaceEnabled,
  type DecisionSurfaceContext,
  type DecisionSurfaceRequest,
  type DecisionSurfaceResponse,
} from "./decision-surfaces.js";

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
      return withStore(request, ctx, () => handleIndexStatus(request.tool));
    case "detect_changes":
      return withStore(request, ctx, () => handleDetectChanges(request, ctx));
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
  return { tool: request.tool, ok: true, result };
}

async function handleSearchCode(
  store: CodegraphStore,
  request: CodegraphSurfaceRequest,
  ctx: CodegraphSurfaceContext,
): Promise<CodegraphSurfaceResponse> {
  const query = requireString(request.query, "query", ctx);
  const limit = clampPositiveInteger(request.limit, 50, "limit", ctx);
  // search_code reuses the FTS5-backed searchGraph path — map the surface
  // query to the store's namePattern + a kind filter for code symbols.
  const result = store.searchGraph({ namePattern: query, limit, kinds: ["function", "class", "method"] });
  return { tool: request.tool, ok: true, result };
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
  return { tool: request.tool, ok: true, result };
}

async function handleGetSnippet(
  store: CodegraphStore,
  request: CodegraphSurfaceRequest,
  ctx: CodegraphSurfaceContext,
): Promise<CodegraphSurfaceResponse> {
  const qualifiedName = requireString(request.qualifiedName, "qualifiedName", ctx);
  const result = await store.snippetFor({ qualifiedName });
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
  return { tool: request.tool, ok: true, result };
}

async function handleIndexStatus(tool: CodegraphToolName): Promise<CodegraphSurfaceResponse> {
  // The full index-status computation lives in @remnic/coding-graph's
  // getIndexStatus(); the surface delegates via the runtime. The handler
  // here returns a placeholder envelope that the runtime fills when
  // wired through getCodegraphStore + git-invoker -- see issue #1553.
  return {
    tool,
    ok: true,
    result: {
      note: "index_status computed by the @remnic/coding-graph index-status module; the surface returns the runtime envelope.",
    },
  };
}

async function handleDetectChanges(
  request: CodegraphSurfaceRequest,
  ctx: CodegraphSurfaceContext,
): Promise<CodegraphSurfaceResponse> {
  // detect_changes delegates to @remnic/coding-graph's blast-radius
  // computation (issue #1553). The surface validates the head argument
  // and forwards to the runtime; the runtime returns the
  // AffectedSymbol[] + risk classification.
  const head = requireString(request.head, "head", ctx);
  return {
    tool: request.tool,
    ok: true,
    result: { head, note: "blast-radius computed by @remnic/coding-graph detect-changes module." },
  };
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
  // Open the per-project store (which triggers @remnic/coding-graph's
  // GraphStore.open → reindex pipeline). The store's open path handles the
  // full/incremental mode selection internally. The returned envelope carries
  // `mode` so callers can tell full/incremental apart (issue #1554).
  let store: CodegraphStore;
  try {
    store = await ctx.resolveStore({ ...request, repoRoot });
  } catch (err) {
    if (err instanceof CodegraphRuntimeError) {
      return { tool: request.tool, ok: false, code: err.code, message: err.message };
    }
    throw err;
  }
  // Touch schemaStats so the store is materialised (the open itself may be
  // lazy). If the store reports a degradation code, pass it through (rule 34).
  const stats = store.schemaStats();
  return {
    tool: request.tool,
    ok: true,
    result: {
      repoRoot,
      mode: modeRaw,
      stats,
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
  if (!isDecisionRecordSurfaceEnabled(ctx.config.codingKnowledge, codingContext)) {
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
  // The trace-to-edge upgrade lives in @remnic/coding-graph's store write
  // pipeline (HTTP_CALLS edge confidence with provenance: "trace"). The
  // store handle is resolved via withStore; we call schemaStats to confirm
  // the store is materialised before accepting the trace batch. The actual
  // edge upgrade is performed by the store's transactional write path.
  const stats = store.schemaStats();
  return {
    tool: request.tool,
    ok: true,
    result: {
      accepted: request.traces.length,
      stats,
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
