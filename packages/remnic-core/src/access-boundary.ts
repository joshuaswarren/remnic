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
export type OperationName =
  | "memory_get"
  | "memory_search"
  | "memory_store"
  | "coding_decision"
  | "coding_architecture"
  // codegraph parity tools (issue #1554) -- each maps to one codegraph_*
  // boundary operation that delegates to the surface handler in
  // coding/codegraph-surfaces.ts. Names match the external tool suffixes.
  | "codegraph_index"
  | "codegraph_list_projects"
  | "codegraph_delete_project"
  | "codegraph_index_status"
  | "codegraph_search_graph"
  | "codegraph_trace_path"
  | "codegraph_detect_changes"
  | "codegraph_query_graph"
  | "codegraph_get_schema"
  | "codegraph_get_snippet"
  | "codegraph_get_architecture"
  | "codegraph_search_code"
  | "codegraph_manage_adr"
  | "codegraph_ingest_traces"
  | "coding_delta";

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
}

// ---------------------------------------------------------------------------
// Operation spec + bound operation
// ---------------------------------------------------------------------------

export interface OperationSpec<In, Out> {
  /** Canonical operation id; matches an {@link OperationName}. */
  readonly name: OperationName;
  readonly description: string;
  /** Zod schema validating the raw request envelope. */
  readonly schema: z.ZodType<In>;
  /** Handler invoked with the parsed input; throws EngramAccessInputError for domain faults. */
  readonly handler: (input: In, ctx: OperationContext) => Promise<Out>;
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
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
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
export function defineOperation<In, Out>(spec: OperationSpec<In, Out>): BoundOperation<In, Out> {
  if (registry.has(spec.name)) {
    throw new Error(`access-boundary: operation already registered: ${spec.name}`);
  }
  const bound: BoundOperation<In, Out> = {
    spec,
    run: async (rawInput, ctx) => {
      const parseResult = spec.schema.safeParse(rawInput);
      if (!parseResult.success) {
        throw new EngramAccessInputError(formatZodIssues(parseResult.error));
      }
      return spec.handler(parseResult.data, ctx);
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

/** All registered operation names. */
export function listRegisteredOperations(): readonly OperationName[] {
  return [...registry.keys()];
}

/** Test-only: clear the registry so pilot definitions can be re-registered. */
export function __resetRegistryForTest(): void {
  registry.clear();
}
