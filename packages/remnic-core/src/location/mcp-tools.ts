/**
 * Location MCP tool definitions (issue #2047) — the five
 * `engram.location_*` tool-def objects, extracted from access-mcp.ts so the
 * surface file stays at its structural ceiling (same pattern as
 * wearables/mcp-tools.ts). Spread back into `this.tools`
 * (`...LOCATION_MCP_TOOLS`); MCP_MIGRATED_OPERATIONS + boundary dispatch
 * stay inline in access-mcp.ts. Location is fleet-wide: no namespace arg
 * (day files live under the memory root, outside every namespace).
 */

import type { McpTool } from "../access-mcp.js";

export const LOCATION_MCP_TOOLS: McpTool[] = [
  {
    name: "engram.location_status",
    description:
      "Location sync status: master gate, timezone, per-source provider registration, last sync, and recent stored day counts. Never returns secrets, addresses, coordinates, or place labels.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "engram.location_check",
    description:
      "Probe every enabled location provider (auth/connectivity). Reports ok/detail per source; a disabled master gate or source reports a skip reason, never an error.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "engram.location_sync",
    description:
      "Sync local-day place observations from every enabled location provider (default: location.syncDays ending yesterday). Same shared runner as the CLI and HTTP surfaces; a forced sync never bypasses the enabled gates or validation. Returns per-day, per-source synced/skipped/failed results.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "Optional exclusive-window end day (YYYY-MM-DD, inclusive); defaults to yesterday in location.timezone.",
        },
        days: {
          type: "integer",
          minimum: 1,
          maximum: 90,
          description: "Optional window size (1..90); defaults to location.syncDays.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "engram.location_backfill",
    description:
      "Sync an explicit historical day range (inclusive, capped at 90 days) for every enabled location provider. Same shared sync runner as location_sync; never makes an unbounded scan.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Range start day (YYYY-MM-DD)." },
        to: { type: "string", description: "Range end day (YYYY-MM-DD, inclusive)." },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "engram.location_day",
    description:
      "Return one stored location day (place segments per source). Coordinates appear only when location.retainCoordinates is enabled; an unstored day returns found:false.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Day to read (YYYY-MM-DD)." },
      },
      required: ["date"],
      additionalProperties: false,
    },
  },
];
