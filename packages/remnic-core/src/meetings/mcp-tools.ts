/**
 * Meetings MCP tool definitions (issue #1900) — the three `engram.meetings_*`
 * tool-def objects, extracted from access-mcp.ts so the surface file stays under
 * its structural ceiling. Spread back into `this.tools` (`...MEETINGS_MCP_TOOLS`);
 * tools/list is verified at runtime. MCP_MIGRATED_OPERATIONS + callTool dispatch
 * stay inline in access-mcp.ts.
 */

import type { McpTool } from "../access-mcp.js";

export const MEETINGS_MCP_TOOLS: McpTool[] = [
  {
    name: "engram.meetings_list",
    description:
      "List stored meeting records (issue #1900), across all days or one day. Returns per-day meeting summaries; empty when meetings.enabled is off.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Caller namespace to scope this operation to (issue #2123)." },
        sessionKey: { type: "string", description: "Session key for principal/namespace resolution." },
        date: {
          type: "string",
          description: "Optional day to list (YYYY-MM-DD). Omit for all days.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "engram.meetings_get",
    description:
      "Return one stored meeting record's markdown by id (mtg-YYYY-MM-DD-<hash>). Absent when not found or meetings.enabled is off.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Caller namespace to scope this operation to (issue #2123)." },
        sessionKey: { type: "string", description: "Session key for principal/namespace resolution." },
        id: {
          type: "string",
          description: "Meeting id (mtg-YYYY-MM-DD-<hash>). Required.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "engram.meetings_build",
    description:
      "Detect + fuse + store a day's meetings from ingested audio + screen activity. No-op (enabled:false) when meetings.enabled is off.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Caller namespace to scope this operation to (issue #2123)." },
        sessionKey: { type: "string", description: "Session key for principal/namespace resolution." },
        date: {
          type: "string",
          description: "Day to build (YYYY-MM-DD). Required.",
        },
      },
      required: ["date"],
      additionalProperties: false,
    },
  },
];
