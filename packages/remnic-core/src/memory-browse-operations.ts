/**
 * Memory-store browse boundary operations (issue #2978).
 *
 * `memory_ls` / `memory_tree` / `memory_find` route MCP, HTTP, and CLI
 * dispatch through the shared validation + error-mapping layer
 * (access-boundary.ts) to the single `EngramAccessService.memoryStoreBrowse`
 * implementation. Sibling module so access-operations-batch.ts stays at its
 * ceiling seam (same layout as recall-navigation-operations.ts).
 */

import { z } from "zod";

import { defineOperation } from "./access-boundary.js";
import { EngramAccessInputError } from "./access-errors.js";
import type { BrowseVerb, MemoryStoreBrowseRequest } from "./memory-browse.js";

function strictSchema<T extends z.ZodRawShape>(shape: T): z.ZodType<Record<string, unknown>> {
  return z.preprocess(
    (data) => {
      if (data !== null && typeof data === "object" && !Array.isArray(data)) {
        return Object.fromEntries(Object.entries(data as Record<string, unknown>).filter(([, value]) => value !== null));
      }
      return data;
    },
    z.object(shape).passthrough(),
  ) as unknown as z.ZodType<Record<string, unknown>>;
}

function optStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optInt(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function reqStr(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EngramAccessInputError(`${field} is required`);
  }
  return value;
}

const verbShape = {
  namespace: z.string().optional(),
} as const;

function browseRequest(verb: BrowseVerb, input: Record<string, unknown>): MemoryStoreBrowseRequest {
  return {
    verb,
    ...(optStr(input.path) !== undefined ? { path: optStr(input.path) } : {}),
    ...(optInt(input.depth) !== undefined ? { depth: optInt(input.depth) } : {}),
    ...(optStr(input.pattern) !== undefined ? { pattern: optStr(input.pattern) } : {}),
    namespace: optStr(input.namespace),
  };
}

defineOperation({
  name: "memory_ls",
  description: "List the children of one store path in the caller's namespace: category dirs with counts, memory files with a one-line description.",
  schema: strictSchema({ ...verbShape, path: z.string().optional() }),
  handler: async (input, ctx) => ({
    result: await ctx.service.memoryStoreBrowse({ ...browseRequest("ls", input), authenticatedPrincipal: ctx.authenticatedPrincipal }),
  }),
});

defineOperation({
  name: "memory_tree",
  description: "Depth-limited tree of store paths under one directory, one-line descriptions, entry-capped.",
  schema: strictSchema({ ...verbShape, path: z.string().optional(), depth: z.union([z.number(), z.string()]).optional() }),
  handler: async (input, ctx) => ({
    result: await ctx.service.memoryStoreBrowse({ ...browseRequest("tree", input), authenticatedPrincipal: ctx.authenticatedPrincipal }),
  }),
});

defineOperation({
  name: "memory_find",
  description: "Deterministic name/path match (`*` glob or substring) over the caller's namespace store; semantic search stays memory_search.",
  schema: strictSchema({ ...verbShape, pattern: z.string() }),
  handler: async (input, ctx) => ({
    result: await ctx.service.memoryStoreBrowse({
      ...browseRequest("find", { ...input, pattern: reqStr(input.pattern, "pattern") }),
      authenticatedPrincipal: ctx.authenticatedPrincipal,
    }),
  }),
});
