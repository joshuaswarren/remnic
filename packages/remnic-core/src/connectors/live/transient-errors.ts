
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
  for (const prop of statusProps) {
    const v = e[prop];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }

  const responseStatus = e.response?.status;
  if (typeof responseStatus === "number" && Number.isFinite(responseStatus)) {
    return responseStatus;
  }

  if (typeof e.status === "number" && Number.isFinite(e.status)) return e.status;

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

  const status = resolveHttpStatus(e, statusProps);
  if (status !== undefined) {
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    // Any 4xx that isn't 429 is terminal.
    return false;
  }

  if (typeof e.code === "string") {
    if (TRANSIENT_NODE_CODES.has(e.code)) return true;
    return false;
  }

  return true;
}
