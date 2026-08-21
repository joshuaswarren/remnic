/**
 * Replit connector installer.
 *
 * Since Replit has no plugin system, this formats a pre-existing Remnic
 * bearer token into setup instructions for the Integrations pane.
 */

export interface ReplitInstallResult {
  token: string;
  instructions: string;
  mcpConfig: {
    url: string;
    headers: Record<string, string>;
  };
}

export interface ReplitEndpointOptions {
  host?: string;
  port?: number;
  baseUrl?: string | URL;
}

function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("Replit MCP port must be an integer between 1 and 65535");
  }
}

function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function endpointFromHost(host: string, port: number): URL {
  const trimmedHost = host.trim();
  if (trimmedHost.length === 0) {
    throw new TypeError("Replit MCP host must be a non-empty hostname or URL origin");
  }

  if (hasScheme(trimmedHost)) {
    const url = new URL(trimmedHost);
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      throw new TypeError("Replit MCP base URL must be an origin without a path, query, or hash");
    }
    return url;
  }

  if (/[/?#]/.test(trimmedHost)) {
    throw new TypeError("Replit MCP host must not include a path, query, or hash");
  }

  assertValidPort(port);
  return new URL(`http://${trimmedHost}:${port}`);
}

function buildMcpUrl(hostOrOptions: string | URL | ReplitEndpointOptions = "localhost", port = 4318): string {
  const endpoint =
    hostOrOptions instanceof URL
      ? endpointFromHost(hostOrOptions.toString(), port)
      : typeof hostOrOptions === "object"
        ? hostOrOptions.baseUrl
          ? endpointFromHost(hostOrOptions.baseUrl.toString(), hostOrOptions.port ?? port)
          : endpointFromHost(hostOrOptions.host ?? "localhost", hostOrOptions.port ?? port)
        : endpointFromHost(hostOrOptions, port);

  endpoint.pathname = "/mcp";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString();
}

export function generateReplitInstructions(
  token: string,
  hostOrOptions: string | URL | ReplitEndpointOptions = "localhost",
  port = 4318,
): ReplitInstallResult {
  const url = buildMcpUrl(hostOrOptions, port);

  const instructions = `
Replit Agent MCP Setup
======================

1. In your Replit workspace, open Integrations > Add MCP server
2. Enter URL: ${url}
3. Add headers:
   - Authorization: Bearer ${token}
   - X-Engram-Client-Id: replit
4. Click Test & Save

Note: For cloud Replit, the Remnic MCP endpoint must be publicly reachable (via tunnel, public IP, or reverse proxy).

Limitations:
- Replit has no hook system, so memory recall/observe is manual
- The agent must explicitly call Remnic MCP tools (recall, observe, store, search)
- All 44 MCP tools are available
`.trim();

  return {
    token,
    instructions,
    mcpConfig: {
      url,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Engram-Client-Id": "replit",
      },
    },
  };
}
