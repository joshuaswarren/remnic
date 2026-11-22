
import type { McpTool } from "./access-mcp.js";

export const RECALL_NAVIGATION_MCP_TOOLS: McpTool[] = [
  {
    name: "engram.memory_expand",
    description:
      "Re-render one memory a recall already served to this session at a deeper disclosure level (section or raw). Cheap follow-up — no fresh search. The id must come from this session's recent recall results.",
    inputSchema: {
      type: "object",
      properties: {
        memoryId: { type: "string", description: "Memory id (or [m:xxxx] handle) served by a recent recall. Required." },
        sessionKey: { type: "string", description: "Session key whose recent recalls authorize the id. Required." },
        disclosure: {
          type: "string",
          enum: ["section", "raw"],
          description: "Target depth; must be deeper than the chunk preview already served. Default raw.",
        },
        namespace: { type: "string", description: "Caller namespace to scope this operation to." },
      },
      required: ["memoryId", "sessionKey"],
      additionalProperties: false,
    },
  },
  {
    name: "engram.memory_traverse",
    description:
      "Follow typed links (supports/contradicts/elaborates/causes/caused_by/supersedes/follows/references/related) from a memory a recall already served to this session. Neighbors return as chunk-level summaries, optionally filtered by relation.",
    inputSchema: {
      type: "object",
      properties: {
        memoryId: { type: "string", description: "Memory id (or [m:xxxx] handle) served by a recent recall. Required." },
        sessionKey: { type: "string", description: "Session key whose recent recalls authorize the id. Required." },
        relation: {
          type: "string",
          enum: ["supports", "contradicts", "elaborates", "causes", "caused_by", "supersedes", "follows", "references", "related"],
          description: "Optional relation filter; omitted means every known relation.",
        },
        limit: { type: "integer", minimum: 1, description: "Optional cap on returned neighbors (ceiling: recallNavigation.maxNeighbors)." },
        namespace: { type: "string", description: "Caller namespace to scope this operation to." },
      },
      required: ["memoryId", "sessionKey"],
      additionalProperties: false,
    },
  },
];
