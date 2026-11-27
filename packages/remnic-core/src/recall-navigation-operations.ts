
import { z } from "zod";

import { defineOperation } from "./access-boundary.js";
import { EngramAccessInputError, rejectReservedArgumentKey } from "./access-errors.js";

function stripNulls(data: unknown): unknown {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    const cleaned = Object.create(null);
    for (const [key, value] of Object.entries(obj)) {
      rejectReservedArgumentKey(key);
      if (value !== null) cleaned[key] = value;
    }
    return cleaned;
  }
  return data;
}

function strictSchema<T extends z.ZodRawShape>(shape: T): z.ZodType<Record<string, unknown>> {
  return z.preprocess(stripNulls, z.object(shape).passthrough()) as unknown as z.ZodType<Record<string, unknown>>;
}

const str = z.string().optional();

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

const baseShape = {
  memoryId: z.string(),
  sessionKey: z.string(),
  namespace: str,
};

defineOperation({
  name: "memory_expand",
  description: "Re-render one already-served recall result at a deeper disclosure level (chunk → section → raw).",
  schema: strictSchema({ ...baseShape, disclosure: z.enum(["chunk", "section", "raw"]).optional() }),
  handler: async (input, ctx) => {
    const disclosure = optStr(input.disclosure);
    return {
      result: await ctx.service.recallNavigate({
        action: "expand",
        memoryId: reqStr(input.memoryId, "memoryId"),
        sessionKey: reqStr(input.sessionKey, "sessionKey"),
        ...(disclosure === "chunk" || disclosure === "section" || disclosure === "raw" ? { disclosure } : {}),
        namespace: optStr(input.namespace),
        authenticatedPrincipal: ctx.authenticatedPrincipal,
      }),
    };
  },
});

defineOperation({
  name: "memory_traverse",
  description:
    "Follow typed frontmatter links from an already-served recall result; neighbors return as chunk-level summaries.",
  schema: strictSchema({
    ...baseShape,
    relation: z
      .enum([
        "supports",
        "contradicts",
        "elaborates",
        "causes",
        "caused_by",
        "supersedes",
        "follows",
        "references",
        "related",
      ])
      .optional(),
    limit: z.union([z.number(), z.string()]).optional(),
  }),
  handler: async (input, ctx) => {
    const relation = optStr(input.relation);
    return {
      result: await ctx.service.recallNavigate({
        action: "traverse",
        memoryId: reqStr(input.memoryId, "memoryId"),
        sessionKey: reqStr(input.sessionKey, "sessionKey"),
        ...(relation !== undefined ? { relation } : {}),
        limit: optInt(input.limit),
        namespace: optStr(input.namespace),
        authenticatedPrincipal: ctx.authenticatedPrincipal,
      }),
    };
  },
});
