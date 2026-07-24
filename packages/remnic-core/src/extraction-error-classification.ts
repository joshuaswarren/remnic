import type { ExtractionFailureClass } from "./types.js";
import { isTransientHttpError } from "./connectors/live/transient-errors.js";

/**
 * Read a numeric HTTP status off a thrown error without re-implementing the
 * shared transient classifier. Uses `in`/typeof narrowing (no inline casts).
 */
function httpStatusFromError(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  if ("status" in err && typeof err.status === "number" && Number.isFinite(err.status)) return err.status;
  if ("statusCode" in err && typeof err.statusCode === "number" && Number.isFinite(err.statusCode)) {
    return err.statusCode;
  }
  return undefined;
}

/**
 * Map a thrown extraction error to a coarse failure class for the retry/breaker
 * layer. 401/403 → `auth_config` (misconfigured provider, open the breaker);
 * transient (429/5xx/network, per the shared `isTransientHttpError`) → back off;
 * anything else defaults to `provider_retryable` (fail-open toward retry, but
 * capped by the per-fingerprint attempt budget). Never throws.
 */
export function classifyExtractionThrownError(err: unknown): ExtractionFailureClass {
  try {
    const status = httpStatusFromError(err);
    if (status === 401 || status === 403) return "auth_config";
    if (isTransientHttpError(err)) return "provider_retryable";
    return "provider_retryable";
  } catch {
    return "provider_retryable";
  }
}

/**
 * Map the gateway fallback's discriminated parse-failure reason to a coarse
 * extraction failure class. "no models configured" is an auth/config problem;
 * an HTTP/transport failure backs off; an unparseable-but-present response is a
 * genuine empty-parse.
 */
export function classifyFallbackParseFailure(
  reason: "no_models" | "empty" | "http_error",
): ExtractionFailureClass {
  switch (reason) {
    case "no_models":
      return "auth_config";
    case "http_error":
      return "provider_retryable";
    case "empty":
      return "parse_empty";
  }
}
