/**
 * @remnic/connector-droid — Factory Droid connector for Remnic
 *
 * Connects Factory Droid to your shared Remnic memory store via HTTP MCP.
 *
 * Install with:
 *   remnic connectors install droid
 *
 * This mints a host token, records Remnic-side connector state, and writes
 * the remnic MCP server entry (HTTP transport + Authorization bearer) into
 * the user-level ~/.factory/mcp.json — never the project-level
 * .factory/mcp.json.
 *
 * Built by Droid. See docs/integration/droid.md for the full walkthrough.
 */

export {
  resolveFactoryMcpPath,
  upsertFactoryMcpRemnicEntry,
  removeFactoryMcpRemnicEntry,
} from "@remnic/core/connectors";

export const CONNECTOR_ID = "droid" as const;
export const REMNIC_MCP_SERVER_KEY = "remnic" as const;
