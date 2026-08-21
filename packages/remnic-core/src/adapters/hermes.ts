import { headerValue, type AdapterContext, type EngramAdapter, type ResolvedIdentity } from "./types.js";

/**
 * Hermes Agent adapter.
 *
 * Detection: Hermes supports both MCP (via config.yaml mcp_servers)
 * and a dedicated MemoryProvider plugin protocol (Python). The MCP
 * client name is not yet publicly documented, so detection uses:
 *
 * 1. X-Hermes-Session-Id header — confirmed in v0.7.0 API server
 * 2. User-configured headers in Hermes MCP config:
 *      mcp_servers:
 *        engram:
 *          url: "http://localhost:4318/mcp"
 *          headers:
 *            X-Engram-Client-Id: "hermes"
 *            X-Engram-Namespace: "my-profile"
 * 3. MCP clientInfo name containing "hermes" (for forward compat)
 *
 * Hermes profiles isolate agent state under ~/.hermes/profiles/<name>/.
 * Each profile can map to a separate Engram namespace via the
 * X-Engram-Namespace header.
 *
 * For deeper integration, Hermes v0.7.0+ supports MemoryProvider
 * plugins (Python protocol with initialize/enrich_turn/sync_turn/
 * shutdown). A Python Engram MemoryProvider plugin would be the
 * optimal integration path — see docs/integration/hermes-setup.md.
 */
export class HermesAdapter implements EngramAdapter {
  readonly id = "hermes";

  matches(context: AdapterContext): boolean {
    // Confirmed header from Hermes v0.7.0 API server
    if (headerValue(context.headers, "x-hermes-session-id")) return true;

    // User-configured client identifier header
    const clientId = headerValue(context.headers, "x-engram-client-id");
    if (clientId?.toLowerCase() === "hermes") return true;

    // MCP clientInfo (for forward compat when Hermes documents its name)
    const clientName = context.clientInfo?.name?.toLowerCase() ?? "";
    if (clientName.includes("hermes")) return true;

    return false;
  }

  resolveIdentity(context: AdapterContext): ResolvedIdentity {
    const sessionId = headerValue(context.headers, "x-hermes-session-id");

    const namespace = headerValue(context.headers, "x-engram-namespace")
      || "hermes";

    return {
      namespace,
      principal: "hermes-agent",
      sessionKey: sessionId ?? context.sessionKey,
      adapterId: this.id,
    };
  }
}
