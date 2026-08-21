import {
  getMemoryForActiveMemory,
  type ActiveMemoryGetOutput,
} from "@remnic/core";
import { MemoryGetInputSchema } from "./shapes.js";
import { toolJsonResult } from "./tool-json-result.js";

export function buildMemoryGetTool(
  orchestrator: unknown,
  options: {
    getMemoryForActiveMemory?: typeof getMemoryForActiveMemory;
  } = {},
) {
  const getMemory = options.getMemoryForActiveMemory ?? getMemoryForActiveMemory;
  return {
    name: "memory_get",
    description: "Fetch one Remnic memory for the OpenClaw active-memory surface.",
    parameters: MemoryGetInputSchema,
    inputSchema: MemoryGetInputSchema,
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      ctx?: { sessionKey?: string },
    ) {
      const id =
        typeof params.id === "string" && params.id.trim().length > 0 ? params.id : null;
      if (!id) {
        throw new Error("memory_get requires an id");
      }
      const sessionKey =
        ctx?.sessionKey ??
        (typeof params.sessionKey === "string" && params.sessionKey.trim().length > 0
          ? params.sessionKey
          : "default");
      const namespace =
        typeof params.namespace === "string" && params.namespace.trim().length > 0
          ? params.namespace.trim()
          : undefined;

      const result: ActiveMemoryGetOutput = await getMemory(
        orchestrator as never,
        id,
        {
          namespace,
          sessionKey,
        },
      );
      return toolJsonResult(result);
    },
  };
}
