import { headerValue, type AdapterContext, type EngramAdapter, type ResolvedIdentity } from "./types.js";

/**
 * Replit Agent adapter.
 *
 * Detection: Replit Agent supports MCP natively (HTTP-only, configured
 * via the Integrations pane). It does NOT send identifying headers
 * automatically — detection relies on user-configured custom headers
 * in Replit's MCP Integrations UI.
 *
 * Replit provides env vars to running code (REPL_ID, REPL_OWNER,
 * REPL_SLUG) but these are NOT sent as HTTP headers to MCP servers.
 *
 * To identify Replit connections, users should configure a custom header
 * in the Replit Integrations pane when adding the Engram MCP server:
 *   Header Name: X-Engram-Client-Id
 *   Header Value: replit
 *
 * Optionally also set X-Engram-Namespace for project scoping. Principal
 * overrides are intentionally handled only by the HTTP server's
 * trustPrincipalHeader gate. Adapters must not independently trust
 * X-Engram-Principal.
 */
export class ReplitAdapter implements EngramAdapter {
  readonly id = "replit";

  matches(context: AdapterContext): boolean {
    // Primary: user-configured client identifier header
    const clientId = headerValue(context.headers, "x-engram-client-id");
    if (clientId?.toLowerCase() === "replit") return true;

    // MCP clientInfo (Replit's MCP client name is not publicly documented,
    // but check for it in case it becomes available)
    const clientName = context.clientInfo?.name?.toLowerCase() ?? "";
    if (clientName.includes("replit")) return true;

    return false;
  }

  resolveIdentity(context: AdapterContext): ResolvedIdentity {
    const mcpSessionId = headerValue(context.headers, "mcp-session-id");

    const namespace = headerValue(context.headers, "x-engram-namespace")
      || "replit";

    return {
      namespace,
      principal: "replit-agent",
      sessionKey: mcpSessionId ?? context.sessionKey,
      adapterId: this.id,
    };
  }
}
