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
const codingDecisionSchema = z.object({
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
});

export type CodingDecisionInput = DecisionSurfaceRequest;
export type CodingDecisionOutput = { result: DecisionSurfaceResponse };

export const codingDecisionOperation = defineOperation<
  CodingDecisionInput,
  CodingDecisionOutput
>({
  name: "coding_decision",
  description:
    "List, get, record, or supersede decision records in the session's coding namespace (issue #1548 Track A).",
  schema: codingDecisionSchema,
  handler: async (input, ctx) => {
    const result = await ctx.service.codingDecision(input);
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
export const REGISTERED_OPERATIONS = [
  memoryGetOperation.spec.name,
  memorySearchOperation.spec.name,
  memoryStoreOperation.spec.name,
  codingDecisionOperation.spec.name,
] as const;
