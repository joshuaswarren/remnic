import { headerValue, type AdapterContext, type EngramAdapter, type ResolvedIdentity } from "./types.js";

/**
 * Grok adapter.
 *
 * Detection: Grok clients identify themselves with a clientInfo name
 * containing "grok" in the MCP initialize handshake, and send
 * User-Agent: grok/<version> on HTTP requests. The exact clientInfo
 * name is not yet stable across Grok surfaces (desktop app, CLI), so
 * detection uses a contains-match for forward compatibility.
 *
 * User-configured identification is also supported via headers:
 *      "headers": { "X-Engram-Client-Id": "grok" }
 *
 * Principal overrides are intentionally handled only by the HTTP server's
 * trustPrincipalHeader gate. Adapters must not independently trust
 * X-Engram-Principal.
 */
export class GrokAdapter implements EngramAdapter {
  readonly id = "grok";

  matches(context: AdapterContext): boolean {
    // Primary: MCP clientInfo from initialize handshake
    const clientName = context.clientInfo?.name?.toLowerCase() ?? "";
    if (clientName.includes("grok")) return true;

    // Fallback: User-Agent header ("grok/<version>")
    const ua = headerValue(context.headers, "user-agent");
    if (ua && ua.toLowerCase().startsWith("grok/")) return true;

    // Fallback: user-configured client identifier header
    const clientId = headerValue(context.headers, "x-engram-client-id");
    if (clientId?.toLowerCase() === "grok") return true;

    return false;
  }

  resolveIdentity(context: AdapterContext): ResolvedIdentity {
    // MCP session ID (standard MCP header, server-assigned)
    const mcpSessionId = headerValue(context.headers, "mcp-session-id");

    // Namespace: explicit header > default
    const namespace = headerValue(context.headers, "x-engram-namespace")
      || "grok";

    return {
      namespace,
      principal: "grok",
      sessionKey: mcpSessionId ?? context.sessionKey,
      adapterId: this.id,
    };
  }
}
