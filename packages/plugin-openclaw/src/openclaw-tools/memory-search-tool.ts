import {
  recallForActiveMemory,
  type ActiveMemorySearchOutput,
} from "@remnic/core";
import { MemorySearchInputSchema } from "./shapes.js";
import { toolJsonResult } from "./tool-json-result.js";

export function buildMemorySearchTool(
  orchestrator: unknown,
  options: {
    snippetMaxChars?: number;
    recallForActiveMemory?: typeof recallForActiveMemory;
  } = {},
) {
  const recall = options.recallForActiveMemory ?? recallForActiveMemory;
  return {
    name: "memory_search",
    description: "Search Remnic memories for the OpenClaw active-memory surface.",
    parameters: MemorySearchInputSchema,
    inputSchema: MemorySearchInputSchema,
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      ctx?: { sessionKey?: string },
    ) {
      const query =
        typeof params.query === "string" && params.query.trim().length > 0
          ? params.query
          : null;
      if (!query) {
        throw new Error("memory_search requires a non-empty query");
      }
      const limit = typeof params.limit === "number" ? params.limit : undefined;
      const sessionKey =
        ctx?.sessionKey ??
        (typeof params.sessionKey === "string" && params.sessionKey.trim().length > 0
          ? params.sessionKey
          : "default");
      const filters =
        params.filters && typeof params.filters === "object"
          ? (params.filters as Record<string, unknown>)
          : undefined;

      const result: ActiveMemorySearchOutput = await recall(orchestrator as never, {
        query,
        limit,
        filters,
        sessionKey,
        snippetMaxChars: options.snippetMaxChars,
      });

      return toolJsonResult(result);
    },
  };
}
