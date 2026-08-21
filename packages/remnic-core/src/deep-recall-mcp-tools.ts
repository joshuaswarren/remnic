/**
 * Deep-recall MCP tool definition (issue #2332) — extracted from
 * access-mcp.ts so the surface file stays at its structural ceiling.
 * Spread back into `this.tools` (`...DEEP_RECALL_MCP_TOOLS`); the
 * migrated-operation mapping spreads into MCP_MIGRATED_OPERATIONS.
 * The `remnic.` canonical alias is minted by withToolAliases at
 * tools/list time (same as meetings).
 */

import type { McpTool } from "./access-mcp.js";

export const DEEP_RECALL_MCP_TOOLS: McpTool[] = [
  {
    name: "engram.deep_recall",
    description:
      "Budgeted REFINE/EXPAND/STOP multi-hop retrieval over the cue-anchor graph (issue #2332). Slow and thorough (seconds; several LLM calls) — opt in when a question warrants deep search, not for routine recall. Returns ranked entries plus a per-step trace. Typed error when deepRecall.enabled is off.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The question to retrieve for. Required." },
        maxSteps: {
          type: "integer",
          minimum: 0,
          description: "Optional policy-step ceiling; cannot exceed the configured deepRecall.maxSteps.",
        },
        namespace: { type: "string", description: "Caller namespace to scope this operation to." },
        sessionKey: { type: "string", description: "Session key for principal/namespace resolution." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];
