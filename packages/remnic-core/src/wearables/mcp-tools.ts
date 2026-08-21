/**
 * Wearables MCP tool definitions (issue #1900 / #2123) — the five
 * `engram.wearables_*` / `engram.transcript_*` tool-def objects, extracted from
 * access-mcp.ts so the surface file stays under its structural ceiling. Spread
 * back into `this.tools` (`...WEARABLES_MCP_TOOLS`); tools/list is verified at
 * runtime. MCP_MIGRATED_OPERATIONS + callTool dispatch stay inline in
 * access-mcp.ts. Each schema carries `namespace` + `sessionKey` so the MCP
 * scope-override injects the caller namespace (caller-derived symmetry, #2123).
 */

import type { McpTool } from "../access-mcp.js";

export const WEARABLES_MCP_TOOLS: McpTool[] = [
      {
        name: "engram.wearables_status",
        description:
          "Status of wearable transcript sources (Limitless / Bee / Omi): configured sources, connector availability, last sync, stored transcript days.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string", description: "Caller namespace to scope this operation to (issue #2123)." },
            sessionKey: { type: "string", description: "Session key for principal/namespace resolution." },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.wearables_sync",
        description:
          "Pull, clean, and store wearable transcripts for one source or all enabled sources; optionally creates trust-gated memories per the source's memoryMode.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string", description: "Caller namespace to scope this operation to (issue #2123)." },
            sessionKey: { type: "string", description: "Session key for principal/namespace resolution." },
            source: {
              type: "string",
              description: "Source id (e.g. limitless, bee, omi). Omit to sync every enabled source.",
            },
            date: {
              type: "string",
              description: "Sync exactly this day (YYYY-MM-DD). Overrides days.",
            },
            days: {
              type: "integer",
              minimum: 1,
              maximum: 90,
              description: "Lookback window in days ending today (default 2).",
            },
            forceMemories: {
              type: "boolean",
              description: "Re-run memory extraction even for unchanged days.",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.transcript_day",
        description:
          "Return the full stored wearable transcript(s) for a day, across all sources or one source, with cross-source overlap hints.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string", description: "Caller namespace to scope this operation to (issue #2123)." },
            sessionKey: { type: "string", description: "Session key for principal/namespace resolution." },
            date: {
              type: "string",
              description: "Day to read (YYYY-MM-DD). Required.",
            },
            source: {
              type: "string",
              description: "Optional source id to scope to (e.g. limitless).",
            },
          },
          required: ["date"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.transcript_search",
        description:
          "Search stored wearable transcripts. Results carry source + date so callers can pull the full day via engram.transcript_day.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string", description: "Caller namespace to scope this operation to (issue #2123)." },
            sessionKey: { type: "string", description: "Session key for principal/namespace resolution." },
            query: {
              type: "string",
              description: "Search query. Required; non-empty.",
            },
            source: {
              type: "string",
              description: "Optional source id filter.",
            },
            from: {
              type: "string",
              description: "Optional inclusive start date (YYYY-MM-DD).",
            },
            to: {
              type: "string",
              description: "Optional inclusive end date (YYYY-MM-DD).",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 50,
              description: "Maximum results (default 10).",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.transcript_memories",
        description:
          "List memories created from wearable transcripts, filterable by source and/or day. Includes pending_review candidates awaiting approval.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string", description: "Caller namespace to scope this operation to (issue #2123)." },
            sessionKey: { type: "string", description: "Session key for principal/namespace resolution." },
            source: {
              type: "string",
              description: "Optional source id filter (e.g. limitless).",
            },
            date: {
              type: "string",
              description: "Optional transcript day filter (YYYY-MM-DD).",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 200,
              description: "Maximum results (default 50).",
            },
          },
          additionalProperties: false,
        },
      }
];
