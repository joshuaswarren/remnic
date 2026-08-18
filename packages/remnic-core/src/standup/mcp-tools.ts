import type { McpTool } from "../access-mcp.js";

export const STANDUP_MCP_TOOLS: McpTool[] = [
  {
    name: "engram.standup",
    description:
      "Deterministic standup brief: yesterday highlights, today priorities, blockers, and an activity grid. Pass date as YYYY-MM-DD; default is today UTC.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Standup day (YYYY-MM-DD). Defaults to today UTC." },
      },
      additionalProperties: false,
    },
  },
];
