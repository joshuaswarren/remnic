import { headerValue, type AdapterContext, type EngramAdapter, type ResolvedIdentity } from "./types.js";

/**
 * OpenCode adapter.
 *
 * Detection: OpenCode identifies itself as "opencode" in the MCP
 * clientInfo of its initialize handshake, and sends
 * User-Agent: opencode/<version> on HTTP requests.
 *
 * User-configured identification is also supported via headers in the
 * OpenCode MCP server config:
 *      "headers": { "X-Engram-Client-Id": "opencode" }
 *
 * Principal overrides are intentionally handled only by the HTTP server's
 * trustPrincipalHeader gate. Adapters must not independently trust
 * X-Engram-Principal.
 */
export class OpenCodeAdapter implements EngramAdapter {
  readonly id = "opencode";

  matches(context: AdapterContext): boolean {
    // Primary: MCP clientInfo from initialize handshake
    const clientName = context.clientInfo?.name?.toLowerCase() ?? "";
    if (clientName.includes("opencode")) return true;

    // Fallback: User-Agent header ("opencode/<version>")
    const ua = headerValue(context.headers, "user-agent");
    if (ua && ua.toLowerCase().startsWith("opencode/")) return true;

    // Fallback: user-configured client identifier header
    const clientId = headerValue(context.headers, "x-engram-client-id");
    if (clientId?.toLowerCase() === "opencode") return true;

    return false;
  }

  resolveIdentity(context: AdapterContext): ResolvedIdentity {
    // MCP session ID (standard MCP header, server-assigned)
    const mcpSessionId = headerValue(context.headers, "mcp-session-id");

    // Namespace: explicit header > default
    const namespace = headerValue(context.headers, "x-engram-namespace")
      || "opencode";

    return {
      namespace,
      principal: "opencode",
      sessionKey: mcpSessionId ?? context.sessionKey,
      adapterId: this.id,
    };
  }
}
