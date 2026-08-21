/**
 * Shared transient-error classifier for live connectors.
 *
 * All three connectors (Drive, Notion, Gmail) need to distinguish transient
 * errors (re-throw so the pass stops without advancing the cursor — the next
 * poll retries the same batch) from terminal errors (skip-and-continue — the
 * resource is gone, inaccessible, or malformed in a non-recoverable way).
 *
 * Having three independent copies of this logic caused divergent edge-case
 * handling (Cursor thread PRRT_kwDORJXyws59sdH4 / #745). This module is the
 * single source of truth; all three connectors import from here.
 *
 * Transient classes:
 *   - 429  (rate-limit / quota — retry after backoff)
 *   - 5xx  (backend error — retry)
 *   - AbortError / cancelled requests
 *   - Network errors with no HTTP status (ECONNRESET, ETIMEDOUT, ENOTFOUND, EAI_AGAIN, …)
 *   - Bare `Error` with no metadata (plain network failures)
 *
 * Terminal classes (skip-and-continue):
 *   - 400  (bad request — won't be fixed by retrying)
 *   - 403  (permission denied)
 *   - 404  (resource gone or not shared)
 *   - 410  (gone)
 *   - Any other 4xx that isn't 429
 *
 * Connector-specific status properties are resolved via the `statusProps`
 * parameter. Connectors attach their own status property name (e.g.
 * `gmailStatus`, `notionStatus`) so the classifier can resolve it without
 * knowing the error shape in detail.
 */

/**
 * Duck-typed error shape that all three connector error types share.
 * Callers pass additional connector-specific status property names via
 * `statusProps`.
 */
interface ErrorLike {
  name?: unknown;
  code?: unknown;
  status?: unknown;
  response?: { status?: unknown } | null;
  [key: string]: unknown;
}

/**
 * Set of Node.js network-layer error codes we treat as transient.
 * Explicitly enumerated (not a denylist) so unknown codes don't accidentally
 * get swallowed.
 */
const TRANSIENT_NODE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ERR_NETWORK",
  "ERR_NETWORK_CHANGED",
]);

/**
 * Resolve a numeric HTTP status from any of the documented locations on an
 * error-shaped object.
 *
 * Resolution order:
 *   1. `statusProps` — connector-specific status properties (e.g. `gmailStatus`, `notionStatus`)
 *   2. `response.status` — canonical for fetch-compatible / GaxiosError shapes
 *   3. `status` — top-level for some HTTP client libraries
 *   4. `code` — numeric (older GaxiosError) or string-numeric ("429" / "503")
 */
function resolveHttpStatus(
  e: ErrorLike,
  statusProps: readonly string[],
): number | undefined {
  // Connector-specific properties first.
  for (const prop of statusProps) {
    const v = e[prop];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }

  // response.status (canonical GaxiosError / fetch-compatible).
  const responseStatus = e.response?.status;
  if (typeof responseStatus === "number" && Number.isFinite(responseStatus)) {
    return responseStatus;
  }

  // Top-level status.
  if (typeof e.status === "number" && Number.isFinite(e.status)) return e.status;

  // Numeric code.
  if (typeof e.code === "number" && Number.isFinite(e.code)) return e.code;

  // String-numeric codes ("429" / "503" — older googleapis / older Node HTTP).
  if (typeof e.code === "string" && /^\d+$/.test(e.code)) {
    const n = Number(e.code);
    if (Number.isFinite(n) && n >= 100 && n <= 599) return n;
  }

  return undefined;
}

/**
 * Generic transient-error classifier.
 *
 * Returns `true` when `err` looks transient (caller should re-throw without
 * advancing the cursor so the next poll retries). Returns `false` for terminal
 * errors (skip-and-continue is safe).
 *
 * @param err      - The caught error value.
 * @param statusProps - Additional property names the caller attaches an HTTP
 *                  status to (e.g. `["gmailStatus"]`, `["notionStatus"]`).
 *                  Pass an empty array when only the generic locations are needed.
 */
export function isTransientHttpError(
  err: unknown,
  statusProps: readonly string[] = [],
): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as ErrorLike;

  // AbortError — always transient.
  if (typeof e.name === "string" && e.name === "AbortError") return true;

  // Resolve HTTP status.
  const status = resolveHttpStatus(e, statusProps);
  if (status !== undefined) {
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    // Any 4xx that isn't 429 is terminal.
    return false;
  }

  // Network-layer codes.
  if (typeof e.code === "string") {
    if (TRANSIENT_NODE_CODES.has(e.code)) return true;
    // Unknown string code with no HTTP status: conservative terminal to avoid
    // looping on a permanent error. Callers can override if needed.
    return false;
  }

  // No status, no code — likely a plain `Error` from a fetch-layer network
  // failure. Treat as transient.
  return true;
}
