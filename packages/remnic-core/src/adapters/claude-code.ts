import { headerValue, type AdapterContext, type EngramAdapter, type ResolvedIdentity } from "./types.js";

/**
 * Claude Code adapter.
 *
 * Detection: Claude Code sends clientInfo.name = "claude-code" in the
 * MCP initialize handshake, and User-Agent: claude-code/<version> in
 * HTTP requests. Project path is available via MCP ListRoots capability
 * (server receives the cwd as a file:// URI root), not via headers.
 *
 * For HTTP REST (non-MCP) requests, detection relies on User-Agent or
 * user-configured X-Engram-Client-Id header in .claude.json headers.
 *
 * Namespace can be set by configuring custom headers in
 * .claude.json or .mcp.json:
 *   "headers": { "X-Engram-Namespace": "my-project" }
 *
 * Principal overrides are intentionally handled only by the HTTP server's
 * trustPrincipalHeader gate. Adapters must not independently trust
 * X-Engram-Principal.
 */
export class ClaudeCodeAdapter implements EngramAdapter {
  readonly id = "claude-code";

  matches(context: AdapterContext): boolean {
    // Primary: MCP clientInfo from initialize handshake (exact match)
    if (context.clientInfo?.name === "claude-code") return true;

    // Fallback: User-Agent header (Claude Code sends "claude-code/<version>")
    const ua = headerValue(context.headers, "user-agent");
    if (ua && ua.toLowerCase().startsWith("claude-code/")) return true;

    // Fallback: user-configured client identifier header
    const clientId = headerValue(context.headers, "x-engram-client-id");
    if (clientId?.toLowerCase() === "claude-code") return true;

    return false;
  }

  resolveIdentity(context: AdapterContext): ResolvedIdentity {
    // MCP session ID (standard MCP header, server-assigned)
    const mcpSessionId = headerValue(context.headers, "mcp-session-id");

    // Namespace: explicit header > default
    const namespace = headerValue(context.headers, "x-engram-namespace")
      || "claude-code";

    return {
      namespace,
      principal: "claude-code",
      sessionKey: mcpSessionId ?? context.sessionKey,
      adapterId: this.id,
    };
  }
}
