/**
 * Adapter interface for external system identity resolution.
 *
 * Each adapter maps an external system's session/identity conventions
 * to Engram's namespace + principal model. Adapters are stateless and
 * lightweight — they don't manage lifecycles or load plugins.
 */

export interface AdapterContext {
  /** Raw HTTP headers from the incoming request */
  headers: Record<string, string | string[] | undefined>;
  /** MCP client info (from initialize handshake, if available) */
  clientInfo?: { name: string; version?: string };
  /** Explicit session key from request args */
  sessionKey?: string;
  /** Explicit namespace from already-validated request args */
  namespace?: string;
  /** Explicit principal from already-validated request args */
  principal?: string;
}

export interface ResolvedIdentity {
  /** Engram namespace (scopes memory access) */
  namespace: string;
  /** Engram principal (authorization subject) */
  principal: string;
  /** Session key for continuity tracking */
  sessionKey?: string;
  /** Which adapter resolved this identity */
  adapterId: string;
}

export interface EngramAdapter {
  /** Adapter identifier (e.g., "claude-code", "codex", "hermes", "replit") */
  readonly id: string;

  /** Whether this adapter recognizes the given request context */
  matches(context: AdapterContext): boolean;

  /** Map external session/identity to Engram namespace + principal */
  resolveIdentity(context: AdapterContext): ResolvedIdentity;
}

/**
 * Extract and trim a single header value from a headers record.
 * Returns undefined if the header is missing, empty, or all whitespace.
 */
export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const exactValue = normalizeHeaderValue(headers[key]);
  if (exactValue !== undefined) {
    return exactValue;
  }

  const normalizedKey = key.toLowerCase();
  for (const [headerKey, raw] of Object.entries(headers)) {
    if (headerKey.toLowerCase() !== normalizedKey) {
      continue;
    }
    const value = normalizeHeaderValue(raw);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function normalizeHeaderValue(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
