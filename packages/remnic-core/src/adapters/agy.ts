import { headerValue, type AdapterContext, type EngramAdapter, type ResolvedIdentity } from "./types.js";

/**
 * Antigravity CLI (agy) adapter.
 *
 * Detection: agy's MCP clientInfo.name contains "agy" in the initialize
 * handshake. The bundled stdio→HTTP proxy also sends
 * X-Engram-Client-Id: agy-cli (matching the lifecycle hook runner's
 * client id) so detection does not depend on the handshake alone.
 *
 * Namespace can be set with the X-Engram-Namespace header; the proxy
 * forwards REMNIC_NAMESPACE/ENGRAM_NAMESPACE as that header.
 *
 * Principal overrides are intentionally handled only by the HTTP server's
 * trustPrincipalHeader gate. Adapters must not independently trust
 * X-Engram-Principal.
 */
export class AgyAdapter implements EngramAdapter {
  readonly id = "agy";

  matches(context: AdapterContext): boolean {
    const clientName = context.clientInfo?.name?.toLowerCase() ?? "";
    if (clientName.includes("agy")) return true;

    const clientId = headerValue(context.headers, "x-engram-client-id");
    if (clientId && (clientId.toLowerCase() === "agy-cli" || clientId.toLowerCase() === "agy")) {
      return true;
    }

    return false;
  }

  resolveIdentity(context: AdapterContext): ResolvedIdentity {
    const mcpSessionId = headerValue(context.headers, "mcp-session-id");
    const namespaceHeader = headerValue(context.headers, "x-engram-namespace");

    return {
      namespace: namespaceHeader ?? "agy",
      namespaceExplicit: namespaceHeader !== undefined,
      principal: "agy",
      sessionKey: mcpSessionId ?? context.sessionKey,
      adapterId: this.id,
    };
  }
}
