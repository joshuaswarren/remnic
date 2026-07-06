/**
 * Pilot operation definitions for the access boundary (issue #1525).
 *
 * Three operations migrate through the registry in this PR — `memory_get`,
 * `memory_search`, and the `memory_store` write op — so the boundary's
 * normalization matrix (rules 17/28/36/48/51) and shared error mapping reach
 * MCP, HTTP, and CLI from one place. Domain-group migrations (memory ops →
 * connectors → namespaces …) land as follow-up PRs that add `defineOperation`
 * calls here and delete the surface-local validation they replace.
 *
 * Importing this module for its side effects registers the pilot operations;
 * surfaces then dispatch via {@link getOperation} from `./access-boundary.js`.
 */

import { z } from "zod";

import { defineOperation } from "./access-boundary.js";
import { memoryStoreRequestSchema, type MemoryStoreRequest } from "./access-schema.js";
import type {
  EngramAccessMemoryResponse,
  EngramAccessWriteResponse,
} from "./access-service.js";
import {
  DECISION_SUBCOMMANDS,
  type DecisionSurfaceRequest,
  type DecisionSurfaceResponse,
} from "./coding/decision-surfaces.js";
import {
  type ArchitectureSurfaceRequest,
  type ArchitectureSurfaceResponse,
} from "./coding/architecture-surfaces.js";
import {
  type CodegraphSurfaceRequest,
  type CodegraphSurfaceResponse,
  isCodegraphToolName,
} from "./coding/codegraph-surfaces.js";
import {
  DELTA_SUBCOMMANDS,
  type DeltaSurfaceRequest,
  type DeltaSurfaceResponse,
} from "./coding/session-delta-surfaces.js";

// ---------------------------------------------------------------------------
// memory_get — fetch one memory by id
// ---------------------------------------------------------------------------

/**
 * `memoryId` is required and non-empty (rule 51: the MCP dispatcher previously
 * fell back to `typeof args.memoryId === "string" ? args.memoryId : ""`,
 * silently passing an empty id into the service). `namespace` is
 * `.nullable().optional()` because MCP clients send `null` (gotcha #2).
 * `namespace` has no `.min(1)` because the pre-boundary handlers forwarded
 * empty/whitespace strings, and `resolveNamespace` treats empty identically
 * to absent (both trim to falsy → default namespace). Rejecting empty would
 * break HTTP callers that send a bare `?namespace=` (Cursor review).
 */
const memoryGetSchema = z.object({
  memoryId: z.string().trim().min(1, "memoryId is required").max(512),
  namespace: z.string().trim().max(256).nullable().optional(),
});

export interface MemoryGetInput {
  readonly memoryId: string;
  readonly namespace?: string | null;
}

export interface MemoryGetOutput {
  readonly result: EngramAccessMemoryResponse;
}

export const memoryGetOperation = defineOperation<MemoryGetInput, MemoryGetOutput>({
  name: "memory_get",
  description: "Fetch one memory by id.",
  schema: memoryGetSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.memoryGet(
      input.memoryId,
      input.namespace ?? undefined,
      ctx.authenticatedPrincipal,
    );
    return { result };
  },
});

// ---------------------------------------------------------------------------
// memory_search — semantic search across memories
// ---------------------------------------------------------------------------

const memorySearchSchema = z.object({
  query: z.string().trim().min(1, "query is required").max(2048),
  namespace: z.string().trim().max(256).nullable().optional(),
  // No upper cap: the pre-boundary MCP handler forwarded any finite number to
  // memorySearch, and the QMD/search backends honor large limits. Capping at
  // 100 would reject existing clients that request larger result sets.
  maxResults: z.number().int().min(1).nullable().optional(),
  collection: z.string().trim().min(1).max(256).nullable().optional(),
});

export interface MemorySearchInput {
  readonly query: string;
  readonly namespace?: string | null;
  readonly maxResults?: number | null;
  readonly collection?: string | null;
}

export interface MemorySearchOutput {
  readonly result: {
    readonly query: string;
    readonly results: ReadonlyArray<{ path: string; score: number; snippet: string }>;
    readonly count: number;
  };
}

export const memorySearchOperation = defineOperation<MemorySearchInput, MemorySearchOutput>({
  name: "memory_search",
  description: "Search memories across readable namespaces.",
  schema: memorySearchSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.memorySearch({
      query: input.query,
      namespace: input.namespace ?? undefined,
      maxResults: input.maxResults ?? undefined,
      collection: input.collection ?? undefined,
      principal: ctx.authenticatedPrincipal,
    });
    return { result };
  },
});

// ---------------------------------------------------------------------------
// memory_store — the pilot WRITE op
// ---------------------------------------------------------------------------

export type MemoryStoreInput = MemoryStoreRequest;

export interface MemoryStoreOutput {
  readonly result: EngramAccessWriteResponse;
}

export const memoryStoreOperation = defineOperation<MemoryStoreInput, MemoryStoreOutput>({
  name: "memory_store",
  description: "Store an explicit memory through the access layer.",
  // Reuse the existing schema verbatim — the migration is behavior-preserving;
  // the schema's external contract is NOT changing in this PR (per the issue's
  // pitfall note).
  schema: memoryStoreRequestSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.memoryStore(
      {
        ...input,
        authenticatedPrincipal: ctx.authenticatedPrincipal,
      },
      // Forward transport-level hooks (e.g. HTTP's atomic write-quota gate)
      // so the hook still fires inside the service's idempotent-write lock —
      // never before, never on a replay (#1434 invariant preserved by the
      // boundary migration).

      ctx.hooks,
    );
    return { result };
  },
});

// ---------------------------------------------------------------------------
// coding_decision — decision-record surfaces (issue #1548 Track A PR 2)
// ---------------------------------------------------------------------------

/**
 * The subcommand field is required and MUST be one of the four valid values
 * (rule 51 — reject loudly, list the options, never silently default). The
 * remaining fields are optional because each subcommand uses a different
 * subset; the handler validates subcommand-specific requirements after
 * routing.
 */
/**
 * MCP clients send `null` for absent optional fields. Zod `.optional()`
 * rejects `null`, so strip nulls at the object level before the inner
 * schema validates (review: cursor null-field thread).
 */
const codingDecisionSchema = z.preprocess(
  (data) => {
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        if (v !== null) out[k] = v;
      }
      return out;
    }
    return data;
  },
  z.object({
    subcommand: z.enum(DECISION_SUBCOMMANDS),
    sessionKey: z.string().trim().max(512).optional(),
    namespace: z.string().trim().max(256).optional(),
    id: z.string().trim().max(512).optional(),
    title: z.string().trim().max(512).optional(),
    status: z.string().trim().max(64).optional(),
    context: z.string().trim().max(8192).optional(),
    decision: z.string().trim().max(8192).optional(),
    consequences: z.string().trim().max(8192).optional(),
    entityRefs: z.array(z.string().trim().min(1).max(256)).optional(),
    supersedesId: z.string().trim().max(512).optional(),
  }),
);

export type CodingDecisionInput = DecisionSurfaceRequest;
export type CodingDecisionOutput = { result: DecisionSurfaceResponse };

export const codingDecisionOperation = defineOperation<
  CodingDecisionInput,
  CodingDecisionOutput
>({
  name: "coding_decision",
  description:
    "List, get, record, or supersede decision records in the session's coding namespace (issue #1548 Track A).",
  schema: codingDecisionSchema as z.ZodType<CodingDecisionInput>,
  handler: async (input, ctx) => {
    const result = await ctx.service.codingDecision(input, ctx.authenticatedPrincipal);
    return { result };
  },
});

// ---------------------------------------------------------------------------
// coding_architecture — architecture-card surfaces (issue #1548 Track A PR 3)
// ---------------------------------------------------------------------------

const codingArchitectureSchema = z.preprocess(
  (data) => {
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      const obj = data as Record<string, unknown>;
      const cleaned: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        if (value !== null) cleaned[key] = value;
      }
      return cleaned;
    }
    return data;
  },
  z.object({
    subcommand: z.enum(["get", "refresh"]),
    sessionKey: z.string().optional(),
    namespace: z.string().optional(),
  }),
);

export type CodingArchitectureInput = ArchitectureSurfaceRequest;
export type CodingArchitectureOutput = { result: ArchitectureSurfaceResponse };

export const codingArchitectureOperation = defineOperation<
  CodingArchitectureInput,
  CodingArchitectureOutput
>({
  name: "coding_architecture",
  description:
    "Get or refresh the architecture card for the session's coding namespace (issue #1548 Track A PR 3).",
  schema: codingArchitectureSchema as z.ZodType<CodingArchitectureInput>,
  handler: async (input, ctx) => {
    const result = await ctx.service.codingArchitecture(input, ctx.authenticatedPrincipal);
    return { result };
  },
});

const codegraphSurfaceSchema = z.preprocess(
  (data) => {
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      const obj = data as Record<string, unknown>;
      const cleaned: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        if (value !== null) cleaned[key] = value;
      }
      return cleaned;
    }
    return data;
  },
  z.object({
    tool: z.string().refine(isCodegraphToolName, {
      message: "tool must be one of the codegraph tool names",
    }),
    sessionKey: z.string().max(512).optional(),
    principal: z.string().max(256).optional(),
    project: z.string().max(256).optional(),
    query: z.string().max(2048).optional(),
    limit: z.number().int().positive().max(200).optional(),
    start: z.string().max(512).optional(),
    direction: z.string().max(64).optional(),
    depth: z.number().int().positive().max(10).optional(),
    qualifiedName: z.string().max(1024).optional(),
    path: z.string().max(2048).optional(),
    structuredQuery: z.record(z.string(), z.unknown()).optional(),
    head: z.string().max(256).optional(),
    repoRoot: z.string().max(2048).optional(),
    mode: z.string().max(64).optional(),
    confirm: z.boolean().optional(),
    subcommand: z.string().max(64).optional(),
    id: z.string().max(512).optional(),
    title: z.string().max(512).optional(),
    status: z.string().max(64).optional(),
    context: z.string().max(8192).optional(),
    decision: z.string().max(8192).optional(),
    consequences: z.string().max(8192).optional(),
    entityRefs: z.array(z.string().max(256)).optional(),
    supersedesId: z.string().max(512).optional(),
    traces: z.array(z.unknown()).optional(),
  }),
) as z.ZodType<CodegraphSurfaceRequest>;

// ---------------------------------------------------------------------------
// coding_delta — session-delta surface (issue #1548 Track A PR 4)
// ---------------------------------------------------------------------------

const codingDeltaSchema = z.preprocess(
  (data) => {
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      const obj = data as Record<string, unknown>;
      const cleaned: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        if (value !== null) cleaned[key] = value;
      }
      return cleaned;
    }
    return data;
  },
  z.object({
    subcommand: z.enum(DELTA_SUBCOMMANDS),
    sessionKey: z.string().trim().max(512).optional(),
    namespace: z.string().trim().max(256).optional(),
  }),
);

export type CodingDeltaInput = DeltaSurfaceRequest;
export type CodingDeltaOutput = { result: DeltaSurfaceResponse };

export const codingDeltaOperation = defineOperation<
  CodingDeltaInput,
  CodingDeltaOutput
>({
  name: "coding_delta",
  description:
    "Get the session delta (commits + touched files since last seen) for the session's coding namespace (issue #1548 Track A PR 4).",
  schema: codingDeltaSchema as z.ZodType<CodingDeltaInput>,
  handler: async (input, ctx) => {
    const result = await ctx.service.codingDelta(input, ctx.authenticatedPrincipal);
    return { result };
  },
});

// ---------------------------------------------------------------------------
// Surface registration map — what each transport calls the pilot ops
// ---------------------------------------------------------------------------

/**
 * The canonical short names (no `engram.`/`remnic.` prefix) of the operations
 * the boundary owns today. The fitness test treats this set as the migrated
 * set; everything else on a surface is unmigrated and counted by the ratchet.
 */
export const codegraphIndexOperation = defineOperation<
  CodegraphSurfaceRequest,
  { result: CodegraphSurfaceResponse }
>({
  name: "codegraph_index",
  description:
    "Codegraph parity tool (issue #1554): index. Delegates to the shared codegraph surface handler.",
  schema: codegraphSurfaceSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.codegraphTool(input, ctx.authenticatedPrincipal);
    return { result };
  },
});

export const codegraphListProjectsOperation = defineOperation<
  CodegraphSurfaceRequest,
  { result: CodegraphSurfaceResponse }
>({
  name: "codegraph_list_projects",
  description:
    "Codegraph parity tool (issue #1554): list_projects. Delegates to the shared codegraph surface handler.",
  schema: codegraphSurfaceSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.codegraphTool(input, ctx.authenticatedPrincipal);
    return { result };
  },
});

export const codegraphDeleteProjectOperation = defineOperation<
  CodegraphSurfaceRequest,
  { result: CodegraphSurfaceResponse }
>({
  name: "codegraph_delete_project",
  description:
    "Codegraph parity tool (issue #1554): delete_project. Delegates to the shared codegraph surface handler.",
  schema: codegraphSurfaceSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.codegraphTool(input, ctx.authenticatedPrincipal);
    return { result };
  },
});

export const codegraphIndexStatusOperation = defineOperation<
  CodegraphSurfaceRequest,
  { result: CodegraphSurfaceResponse }
>({
  name: "codegraph_index_status",
  description:
    "Codegraph parity tool (issue #1554): index_status. Delegates to the shared codegraph surface handler.",
  schema: codegraphSurfaceSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.codegraphTool(input, ctx.authenticatedPrincipal);
    return { result };
  },
});

export const codegraphSearchGraphOperation = defineOperation<
  CodegraphSurfaceRequest,
  { result: CodegraphSurfaceResponse }
>({
  name: "codegraph_search_graph",
  description:
    "Codegraph parity tool (issue #1554): search_graph. Delegates to the shared codegraph surface handler.",
  schema: codegraphSurfaceSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.codegraphTool(input, ctx.authenticatedPrincipal);
    return { result };
  },
});

export const codegraphTracePathOperation = defineOperation<
  CodegraphSurfaceRequest,
  { result: CodegraphSurfaceResponse }
>({
  name: "codegraph_trace_path",
  description:
    "Codegraph parity tool (issue #1554): trace_path. Delegates to the shared codegraph surface handler.",
  schema: codegraphSurfaceSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.codegraphTool(input, ctx.authenticatedPrincipal);
    return { result };
  },
});

export const codegraphDetectChangesOperation = defineOperation<
  CodegraphSurfaceRequest,
  { result: CodegraphSurfaceResponse }
>({
  name: "codegraph_detect_changes",
  description:
    "Codegraph parity tool (issue #1554): detect_changes. Delegates to the shared codegraph surface handler.",
  schema: codegraphSurfaceSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.codegraphTool(input, ctx.authenticatedPrincipal);
    return { result };
  },
});

export const codegraphQueryGraphOperation = defineOperation<
  CodegraphSurfaceRequest,
  { result: CodegraphSurfaceResponse }
>({
  name: "codegraph_query_graph",
  description:
    "Codegraph parity tool (issue #1554): query_graph. Delegates to the shared codegraph surface handler.",
  schema: codegraphSurfaceSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.codegraphTool(input, ctx.authenticatedPrincipal);
    return { result };
  },
});

export const codegraphGetSchemaOperation = defineOperation<
  CodegraphSurfaceRequest,
  { result: CodegraphSurfaceResponse }
>({
  name: "codegraph_get_schema",
  description:
    "Codegraph parity tool (issue #1554): get_schema. Delegates to the shared codegraph surface handler.",
  schema: codegraphSurfaceSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.codegraphTool(input, ctx.authenticatedPrincipal);
    return { result };
  },
});

export const codegraphGetSnippetOperation = defineOperation<
  CodegraphSurfaceRequest,
  { result: CodegraphSurfaceResponse }
>({
  name: "codegraph_get_snippet",
  description:
    "Codegraph parity tool (issue #1554): get_snippet. Delegates to the shared codegraph surface handler.",
  schema: codegraphSurfaceSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.codegraphTool(input, ctx.authenticatedPrincipal);
    return { result };
  },
});

export const codegraphGetArchitectureOperation = defineOperation<
  CodegraphSurfaceRequest,
  { result: CodegraphSurfaceResponse }
>({
  name: "codegraph_get_architecture",
  description:
    "Codegraph parity tool (issue #1554): get_architecture. Delegates to the shared codegraph surface handler.",
  schema: codegraphSurfaceSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.codegraphTool(input, ctx.authenticatedPrincipal);
    return { result };
  },
});

export const codegraphSearchCodeOperation = defineOperation<
  CodegraphSurfaceRequest,
  { result: CodegraphSurfaceResponse }
>({
  name: "codegraph_search_code",
  description:
    "Codegraph parity tool (issue #1554): search_code. Delegates to the shared codegraph surface handler.",
  schema: codegraphSurfaceSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.codegraphTool(input, ctx.authenticatedPrincipal);
    return { result };
  },
});

export const codegraphManageAdrOperation = defineOperation<
  CodegraphSurfaceRequest,
  { result: CodegraphSurfaceResponse }
>({
  name: "codegraph_manage_adr",
  description:
    "Codegraph parity tool (issue #1554): manage_adr. Delegates to the shared codegraph surface handler.",
  schema: codegraphSurfaceSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.codegraphTool(input, ctx.authenticatedPrincipal);
    return { result };
  },
});

export const codegraphIngestTracesOperation = defineOperation<
  CodegraphSurfaceRequest,
  { result: CodegraphSurfaceResponse }
>({
  name: "codegraph_ingest_traces",
  description:
    "Codegraph parity tool (issue #1554): ingest_traces. Delegates to the shared codegraph surface handler.",
  schema: codegraphSurfaceSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.codegraphTool(input, ctx.authenticatedPrincipal);
    return { result };
  },
});

// Batch-migrated operations (issue #1525): registers all remaining
// handlers through the boundary as a side effect of importing this module.
import "./access-operations-batch.js";

export const REGISTERED_OPERATIONS = [
  memoryGetOperation.spec.name,
  memorySearchOperation.spec.name,
  memoryStoreOperation.spec.name,
  codingDecisionOperation.spec.name,
  codingArchitectureOperation.spec.name,
  codegraphIndexOperation.spec.name,
  codegraphListProjectsOperation.spec.name,
  codegraphDeleteProjectOperation.spec.name,
  codegraphIndexStatusOperation.spec.name,
  codegraphSearchGraphOperation.spec.name,
  codegraphTracePathOperation.spec.name,
  codegraphDetectChangesOperation.spec.name,
  codegraphQueryGraphOperation.spec.name,
  codegraphGetSchemaOperation.spec.name,
  codegraphGetSnippetOperation.spec.name,
  codegraphGetArchitectureOperation.spec.name,
  codegraphSearchCodeOperation.spec.name,
  codegraphManageAdrOperation.spec.name,
  codegraphIngestTracesOperation.spec.name,
  codingDeltaOperation.spec.name,
] as const;
