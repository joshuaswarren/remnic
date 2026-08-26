/**
 * Single input-validation and error boundary for the CLI/MCP/HTTP access
 * surfaces (issue #1525, epic #1520 Phase 1).
 *
 * Every operation that crosses the access-service facade passes through ONE
 * registry entry: a zod-validated request envelope, a shared error mapper,
 * and the "reject invalid input and list valid options" behavior that
 * CLAUDE.md rules 14/17/24/28/36/48/51 previously had to be re-implemented
 * per handler. The three surfaces become thin adapters — one operation
 * definition, three transports — so a validation fix lands everywhere at
 * once.
 *
 * Host-agnostic (rule 31): operation names carry no `openclaw-*`/`engram-*`
 * prefix. Session/namespace tenancy stays in the handler layer (resolved via
 * ScopePlan #1521); the boundary validates SHAPE, not tenancy.
 */

import { z } from "zod";
import { EngramAccessInputError, type EngramAccessService } from "./access-service.js";
import {
  assertOperationAuthorizationAllowed,
  tokenCapabilityStore,
} from "./access-token-capabilities.js";
import { expandTildePath } from "./utils/path.js";

// ---------------------------------------------------------------------------
// Canonical operation names — host-agnostic (rule 31)
// ---------------------------------------------------------------------------

/**
 * Canonical operation ids. One id is shared by the MCP tool, the HTTP route,
 * and the CLI command that expose the same operation. Add to this union as
 * each domain-group migration PR (memory ops → connectors → namespaces …)
 * lands; the fitness test in `access-surface-catalog.test.ts` treats the
 * registered set as the migration state.
 */
export const OPERATION_NAMES = [
  "memory_get",
  "memory_search",
  "external_wiki_search",
  "memory_store",
  "coding_decision",
  "coding_architecture",
  // codegraph parity tools (issue #1554) -- each maps to one codegraph_*
  // boundary operation that delegates to the surface handler in
  // coding/codegraph-surfaces.ts. Names match the external tool suffixes.
  "codegraph_index",
  "codegraph_list_projects",
  "codegraph_delete_project",
  "codegraph_index_status",
  "codegraph_search_graph",
  "codegraph_trace_path",
  "codegraph_detect_changes",
  "codegraph_query_graph",
  "codegraph_get_schema",
  "codegraph_get_snippet",
  "codegraph_get_architecture",
  "codegraph_search_code",
  "codegraph_manage_adr",
  "codegraph_ingest_traces",
  "memory_correct_plan",
  "memory_correct_apply",
  "coding_delta",
  // Remaining MCP/HTTP handlers migrated through the boundary (issue #1525).
  "recall",
  "recall_explain",
  "set_coding_context",
  "recall_tier_explain",
  "recall_xray",
  "recall_why",
  "who_knows",
  "promotion_candidates",
  "namespace_writable",
  "wearables_status",
  "wearables_sync",
  "transcript_day",
  "transcript_search",
  "transcript_memories",
  "location_status",
  "location_check",
  "location_sync",
  "location_backfill",
  "location_day",
  "meetings_list",
  "meetings_get",
  "meetings_build",
  "deep_recall",
  "memory_expand",
  "memory_traverse",
  "memory_ls",
  "memory_tree",
  "memory_find",
  "standup",
  "action_confidence",
  "chatgpt_memory_inspector",
  "day_summary",
  "capsule_export",
  "capsule_import",
  "capsule_list",
  "memory_governance_run",
  "entity_synthesis_run",
  "procedure_mining_run",
  "pattern_reinforcement_run",
  "procedural_stats",
  "procedure_library_maintenance",
  "memory_timeline",
  "suggestion_submit",
  "entity_get",
  "review_queue_list",
  "correction_pending",
  "observe",
  "lcm_search",
  "lcm_compaction_flush",
  "extraction_force_flush",
  "lcm_compaction_record",
  "continuity_audit_generate",
  "continuity_incident_open",
  "continuity_incident_close",
  "continuity_incident_list",
  "continuity_loop_add_or_update",
  "continuity_loop_review",
  "identity_anchor_get",
  "identity_anchor_update",
  "memory_identity",
  "work_task",
  "work_project",
  "work_board",
  "shared_context_write_output",
  "shared_feedback_record",
  "shared_priorities_append",
  "relay_mission_append",
  "relay_mission_read",
  "shared_context_cross_signals_run",
  "shared_context_curate_daily",
  "compounding_weekly_synthesize",
  "compounding_promote_candidate",
  "compression_guidelines_optimize",
  "compression_guidelines_activate",
  "memory_profile",
  "memory_entities_list",
  "memory_questions",
  "memory_last_recall",
  "memory_intent_debug",
  "memory_qmd_debug",
  "memory_graph_explain",
  "graph_snapshot",
  "memory_feedback",
  "memory_promote",
  "memory_outcome",
  "memory_action_apply",
  "context_checkpoint",
  "briefing",
  "review_list",
  "review_resolve",
  "contradiction_scan_run",
  "preference_drift_scan",
  "memory_summarize_hourly",
  "conversation_index_update",
  "profiling_report",
  "graph_edge_decay_run",
  "live_connectors_run",
  "peer_list",
  "peer_get",
  "peer_set",
  "peer_delete",
  "peer_profile_get",
  "peer_forget",
  "console_state",
  "dreams_status",
  "dreams_run",
  "support_passport_memory_preview",
  "support_passport_cards_list",
  "support_passport_draft_create",
  "support_passport_drafts_generate",
  "support_passport_card_replace",
  "support_passport_card_approve",
  "support_passport_card_reject",
  "support_passport_card_withdraw",
  "support_passport_grant_create",
  "support_passport_grants_list",
  "support_passport_grant_revoke",
  "support_passport_grant_read",
  "support_passport_grant_ask",
  // HTTP-only routes (no direct MCP tool equivalent).
  "adapters_status",
  "offline_sync_snapshot",
  "offline_sync_snapshot_stream",
  "offline_sync_files",
  "offline_sync_file_content",
  "offline_sync_apply_file_content",
  "offline_sync_apply",
  "lcm_status",
  "memory_list",
  "recall_timings",
  "entity_list",
  "maintenance_status",
  "quality_status",
  "trust_zones_status",
  "trust_zones_records",
  "review_disposition",
  "review_deck_list",
  "review_deck_action",
  "review_deck_undo",
  "trust_zones_promote",
  "trust_zones_demo_seed",
  "citations_observed",
  "contradiction_detail",
  "graph_events",
  // Chat surface — conversational memory inspection/correction (issue #1583).
  "chat_message",
  "chat_events",
] as const;

/**
 * Canonical operation ids. One id is shared by the MCP tool, the HTTP route,
 * and the CLI command that expose the same operation. Derived from
 * {@link OPERATION_NAMES} (single source of truth) so the runtime catalog
 * used for token-capability validation cannot drift from the type. The
 * fitness test in `access-surface-catalog.test.ts` treats the registered set
 * as the migration state.
 */
export type OperationName = (typeof OPERATION_NAMES)[number];

const IMPLICIT_HTTP_NAMESPACE_OPERATIONS = new Set<OperationName>([
  "offline_sync_snapshot",
  "offline_sync_snapshot_stream",
  "memory_list",
  "entity_list",
  "maintenance_status",
  "quality_status",
  "trust_zones_status",
  "graph_events",
  "citations_observed",
]);

const PRINCIPAL_NAMESPACE_OPERATIONS = new Set<OperationName>([
  "support_passport_memory_preview",
  "support_passport_cards_list",
  "support_passport_draft_create",
  "support_passport_drafts_generate",
  "support_passport_card_replace",
  "support_passport_card_approve",
  "support_passport_card_reject",
  "support_passport_card_withdraw",
  "support_passport_grant_create",
  "support_passport_grants_list",
  "support_passport_grant_revoke",
]);

// ---------------------------------------------------------------------------
// Operation context — what every handler receives
// ---------------------------------------------------------------------------

/**
 * Per-call context. `service` is the facade the handler delegates to; the
 * boundary never reaches past it. `authenticatedPrincipal` is resolved by
 * the SURFACE (MCP header / HTTP identity / CLI flag) before the boundary
 * runs, so handlers stay principal-source-agnostic. `hooks` carries
 * transport-level callbacks (e.g. HTTP write-quota enforcement) that must
 * fire atomically inside the service call; surfaces that have no such hook
 * leave it undefined.
 */
export interface OperationContext {
  readonly service: EngramAccessService;
  readonly authenticatedPrincipal?: string;
  readonly operatorPrincipal?: string;
  /** Per-request cancellation supplied by transports that own a request lifecycle. */
  readonly abortSignal?: AbortSignal;
  /** Server-resolved connector identity (Phase 1 provenance). Set by the HTTP auth boundary from the matched token's connector; flows to write handlers so frontmatter records which connector submitted the memory. Client-supplied values are always overridden. */
  readonly sourceConnector?: string;
  /**
   * The PRE-validation raw envelope exactly as the transport supplied it
   * (issue #2829). Handlers use it to retain input spellings the schema's
   * transforms canonicalize — e.g. the memory-store category aliases — so
   * diagnostics can name what the caller actually sent. Never trust it for
   * behavior; only the parsed `input` is validated.
   */
  readonly rawInput?: unknown;
  readonly hooks?: OperationHooks;
}

/**
 * Transport-level callbacks a handler forwards into the service call. Kept
 * narrow on purpose: the boundary owns validation + dispatch shape, not
 * transport policy. Add fields here only when a surface genuinely needs a
 * callback the service itself consumes.
 */
export interface OperationHooks {
  /** HTTP write-quota gate; throws to reject the write when exhausted. */
  readonly enforceWriteQuota?: () => void | Promise<void>;
  /** Commit-boundary accounting for writes that can fail after durability. */
  readonly recordWriteCommit?: () => void;
}

// ---------------------------------------------------------------------------
// Operation spec + bound operation
// ---------------------------------------------------------------------------

export interface OperationSpec<In, Out> {
  /** Canonical operation id; matches an {@link OperationName}. */
  readonly name: OperationName;
  readonly description: string;
  /**
   * Zod schema validating the raw request envelope. Input type may differ
   * from the output `In` — schemas that canonicalize during parsing (issue
   * #2829 category aliases) are first-class, declared truthfully instead of
   * cast into an input-equals-output shape.
   */
  readonly schema: z.ZodType<In, z.ZodTypeDef, unknown>;
  /** Handler invoked with the parsed input; throws EngramAccessInputError for domain faults. */
  readonly handler: (input: In, ctx: OperationContext) => Promise<Out>;
  /**
   * Marks an operation as inherently FLEET-WIDE / global — it runs across ALL
   * namespaces (or against a single non-namespaced global layer) and carries no
   * `namespace` argument, so the MCP `tools/call` effective-namespace chokepoint
   * never applies. When set, {@link defineOperation}'s run wrapper rejects any
   * namespace-SCOPED token (fail closed) via assertFleetWideOperationAllowed
   * BEFORE the handler — no side effect on denial. Unrestricted/legacy tokens
   * (cron, internal callers, no capability record) are unaffected (issue #1850).
   */
  readonly fleetWide?: boolean;
  /**
   * Alternate op allow-list: when set, the token may invoke this operation if
   * its ops allow-list permits ANY of these ops (instead of the default rule
   * that requires the op's own {@link name}). Lets a read-only diagnostic be
   * granted by the write ops it diagnoses — e.g. `namespace_writable` is
   * runnable by any token permitted to `observe`/`memory_store`, so a token
   * minted before the diagnostic op existed can still call it. Unrestricted /
   * legacy tokens (no ops axis) are unaffected. Keeps the boundary and any HTTP
   * transport for the same op enforcing ONE policy.
   */
  readonly allowedByOps?: readonly OperationName[];
}

export interface BoundOperation<In = unknown, Out = unknown> {
  readonly spec: OperationSpec<In, Out>;
  /** Validate the raw envelope, then invoke the handler. Throws EngramAccessInputError on any validation failure. */
  readonly run: (rawInput: unknown, ctx: OperationContext) => Promise<Out>;
}

// ---------------------------------------------------------------------------
// Shared normalizers the boundary owns (rules 17, 28, 36, 48, 51)
// ---------------------------------------------------------------------------

/**
 * Coerce boolean-like strings at the edge (rule 36). Accepts actual booleans
 * and the string spellings clients send ("true"/"false"/"1"/"0"/"yes"/"no"/
 * "on"/"off", case-insensitive). Rejects anything else loudly — `Boolean("false")`
 * would silently be `true`, which is the bug rule 36 exists to prevent.
 *
 * `undefined`/`null`/`""` → `undefined`, so callers can keep treating an
 * absent flag as "use the default" without a separate presence check.
 */
export function coerceBooleanLike(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true" || lower === "1" || lower === "yes" || lower === "on") return true;
    if (lower === "false" || lower === "0" || lower === "no" || lower === "off") return false;
  }
  throw new EngramAccessInputError(
    `expected a boolean-like value (true|false|1|0|yes|no|on|off); got ${JSON.stringify(value)}`,
  );
}

/**
 * Coerce + validate a positive integer from a numeric string or number
 * (rule 28). Loosely-typed MCP/CLI clients send `"5"`; `typeof saved === "number"`
 * on read-back would reject it later, so we coerce at the edge and reject
 * booleans/objects loudly (`Number(true) === 1` would silently pass otherwise).
 *
 * `undefined`/`null`/`""` → `undefined`.
 */
export function coercePositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
      throw new EngramAccessInputError(`${label} expects a positive integer; got ${JSON.stringify(value)}`);
    }
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
      throw new EngramAccessInputError(`${label} expects a positive integer; got ${JSON.stringify(value)}`);
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new EngramAccessInputError(`${label} expects a positive integer; got ${JSON.stringify(value)}`);
    }
    return parsed;
  }
  throw new EngramAccessInputError(`${label} expects a positive integer; got ${JSON.stringify(value)}`);
}

/**
 * Expand `~` in a path-shaped input (rule 17). Node `fs` does NOT expand `~`;
 * ad-hoc regex drifts. `undefined`/`null`/`""` → `undefined`.
 */
export function normalizeOptionalPath(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new EngramAccessInputError(`expected a path string; got ${JSON.stringify(value)}`);
  }
  return expandTildePath(value);
}

// ---------------------------------------------------------------------------
// Error formatting — rule 51: list valid options, never silently default
// ---------------------------------------------------------------------------

/**
 * Turn a zod failure into an {@link EngramAccessInputError} whose message
 * names the offending field and — for enum/union issues — lists the valid
 * options, so the caller can correct rather than guess (rule 51).
 */
export function formatZodIssues(error: z.ZodError): string {
  const parts: string[] = [];
  for (const issue of error.issues) {
    // Collapse array-index paths (e.g. ["currentContextScopes", 1]) to
    // the field name so the message reads "field: must be ..." not
    // "field.1: must be ...".
    const hasNumeric = issue.path.some((p) => typeof p === "number");
    const path = hasNumeric
      ? issue.path.filter((p) => typeof p === "string").join(".") || "(root)"
      : issue.path.length > 0 ? issue.path.join(".") : "(root)";
    const options = enumOptionsFromIssue(issue);
    const suffix = options ? `. Valid: ${options.join(", ")}` : "";
    parts.push(`${path}: ${issue.message}${suffix}`);
  }
  return parts.length > 0
    ? `request validation failed: ${parts.join("; ")}`
    : "request validation failed";
}

function enumOptionsFromIssue(issue: z.ZodIssue): readonly string[] | undefined {
  // zod exposes accepted enum values on the issue for ZodEnum / ZodNativeEnum
  // and on the options of invalid_union discriminators. Reading them here
  // keeps "list valid options" in ONE place rather than per handler.
  if (issue.code === z.ZodIssueCode.invalid_enum_value) {
    const rawOptions = (issue as { options?: unknown }).options;
    if (Array.isArray(rawOptions)) {
      return rawOptions.map((opt) => String(opt));
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<OperationName, BoundOperation>();

/**
 * Register an operation. Throws if the name is already registered — duplicate
 * registration is a programming error, not a runtime input fault, so it throws
 * a plain Error (not the input-error class surfaces translate for clients).
 */
/**
 * Error map that converts Zod's generic type-mismatch messages into
 * human-readable "must be a <type>" messages (rule 51).  Applied at the
 * boundary chokepoint so every operation gets consistent messaging
 * without per-handler boilerplate.
 */
const humanReadableErrorMap: z.ZodErrorMap = (issue, ctx) => {
  if (issue.code === z.ZodIssueCode.invalid_type) {
    if (issue.received === "undefined") return { message: ctx.defaultError };
    // Array-element type errors — collapse to field-level message.
    if (issue.path.some((p) => typeof p === "number")) {
      const arrField = issue.path.filter((p) => typeof p === "string").join(".");
      return { message: `${arrField} must be an array of ${issue.expected}s` };
    }
    const fieldName = issue.path.length > 0 ? String(issue.path[issue.path.length - 1]) : "value";
    switch (issue.expected) {
      case "string": return { message: `${fieldName} must be a string` };
      case "boolean": return { message: `${fieldName} must be a boolean` };
      case "number": return { message: `${fieldName} must be a number` };
      case "array": return { message: `${fieldName} must be an array` };
      case "object": return { message: `${fieldName} must be an object` };
      default: return { message: ctx.defaultError };
    }
  }
  return { message: ctx.defaultError };
};

export function defineOperation<In, Out>(spec: OperationSpec<In, Out>): BoundOperation<In, Out> {
  if (registry.has(spec.name)) {
    throw new Error(`access-boundary: operation already registered: ${spec.name}`);
  }
  const bound: BoundOperation<In, Out> = {
    spec,
    run: async (rawInput, ctx) => {
      const parseResult = spec.schema.safeParse(rawInput, { errorMap: humanReadableErrorMap });
      if (!parseResult.success) {
        throw new EngramAccessInputError(formatZodIssues(parseResult.error));
      }
      assertOperationAuthorizationAllowed(tokenCapabilityStore.getStore(), spec);
      return spec.handler(parseResult.data, { ...ctx, rawInput });
    },
  };
  // Store under the canonical name; the cast is safe because In/Out are
  // erased at the registry boundary and recovered by callers via getOperation.
  registry.set(spec.name, bound as unknown as BoundOperation);
  return bound;
}

/** Look up a registered operation by canonical name. */
export function getOperation(name: OperationName): BoundOperation | undefined {
  return registry.get(name);
}

/** Whether a probe must authorize an operation's effective namespace. */
export function operationRequiresAuthorizedNamespace(name: OperationName): boolean {
  if (name === "namespace_writable") return false;
  if (IMPLICIT_HTTP_NAMESPACE_OPERATIONS.has(name)) return true;
  let schema: unknown = registry.get(name)?.spec.schema;
  // preprocess/transform/refine each wrap ZodEffects. One unwrap left
  // suggestion_submit looking namespace-free after the category transform.
  while (schema instanceof z.ZodEffects) schema = schema.innerType();
  return schema instanceof z.ZodObject && Object.hasOwn(schema.shape, "namespace");
}

/** Whether an operation resolves its namespace from the authenticated principal. */
export function operationUsesPrincipalNamespace(name: OperationName): boolean {
  return PRINCIPAL_NAMESPACE_OPERATIONS.has(name);
}

/** All registered operation names. */
export function listRegisteredOperations(): readonly OperationName[] {
  return [...registry.keys()];
}

/** Test-only: clear the registry so pilot definitions can be re-registered. */
export function __resetRegistryForTest(): void {
  registry.clear();
}
