import { headerValue, type AdapterContext, type EngramAdapter, type ResolvedIdentity } from "./types.js";

/**
 * Devin CLI adapter.
 *
 * Detection: Devin CLI's MCP clientInfo.name contains "devin" in the
 * initialize handshake. The bundled stdio→HTTP proxy also sends
 * X-Engram-Client-Id: devin-cli (matching the lifecycle hook runner's
 * client id) so detection does not depend on the handshake alone.
 *
 * Namespace can be set with the X-Engram-Namespace header; the proxy
 * forwards REMNIC_NAMESPACE/ENGRAM_NAMESPACE as that header.
 *
 * Principal overrides are intentionally handled only by the HTTP server's
 * trustPrincipalHeader gate. Adapters must not independently trust
 * X-Engram-Principal.
 */
export class DevinAdapter implements EngramAdapter {
  readonly id = "devin";

  matches(context: AdapterContext): boolean {
    const clientName = context.clientInfo?.name?.toLowerCase() ?? "";
    if (clientName.includes("devin")) return true;

    const clientId = headerValue(context.headers, "x-engram-client-id");
    if (clientId && (clientId.toLowerCase() === "devin-cli" || clientId.toLowerCase() === "devin")) {
      return true;
    }

    return false;
  }

  resolveIdentity(context: AdapterContext): ResolvedIdentity {
    const mcpSessionId = headerValue(context.headers, "mcp-session-id");
    const namespaceHeader = headerValue(context.headers, "x-engram-namespace");

    return {
      namespace: namespaceHeader ?? "devin",
      namespaceExplicit: namespaceHeader !== undefined,
      principal: "devin",
      sessionKey: mcpSessionId ?? context.sessionKey,
      adapterId: this.id,
    };
  }
}
