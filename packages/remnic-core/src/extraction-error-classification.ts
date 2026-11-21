import type { ExtractionFailureClass, ExtractionResult } from "./types.js";
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

const CONTEXT_LIMIT_MESSAGE = /maximum context|context length|context window|request entity/i;
const SIZE_LIMIT_PHRASE = /too large|too long|exceed/i;
const INPUT_SUBJECT_TERM =
  /\b(?:input|prompt|request|payload|body|messages?|content|context|size|length|tokens?)\b/i;
const REQUEST_TOO_LARGE_EXCLUDE =
  /\b(?:max_tokens|max_completion_tokens|temperature|top_p|quota|rate limit|spending|billing)\b/i;

/**
 * True when a provider refused the request because the input is too big: HTTP
 * 413, or HTTP 400 whose message names a size or context limit (OpenAI-style
 * "maximum context length", "total text input size exceeds 8 MB"). "too large",
 * "too long" and "exceed" count only beside an input subject and never beside
 * an output, quota or sampling term (`max_tokens exceeds limit`,
 * `temperature is too large`, `quota exceeded` are different failures).
 * Resending the same atomic request can never succeed (#3531). Never throws.
 */

/** An Error or SDK error object; the HTTP status is sniffed off it when present. */
export interface HttpThrowable {
  readonly status?: number;
  readonly message?: string;
}

export function isRequestTooLargeError(err: HttpThrowable): boolean {
  try {
    const status = httpStatusFromError(err);
    if (status === 413) return true;
    if (status !== 400 || !(err instanceof Error)) return false;
    const message = err.message;
    if (CONTEXT_LIMIT_MESSAGE.test(message)) return true;
    if (REQUEST_TOO_LARGE_EXCLUDE.test(message)) return false;
    return SIZE_LIMIT_PHRASE.test(message) && INPUT_SUBJECT_TERM.test(message);
  } catch {
    return false;
  }
}

/**
 * Result when the provider refused the window as too large (#3531). Retryable
 * on purpose: the retained turns are never parked or dropped, and
 * `remnic buffer drain` can still extract them in budget-sized chunks.
 */
export function directInputTooLargeResult(): ExtractionResult {
  return {
    facts: [],
    profileUpdates: [],
    entities: [],
    questions: [],
    extractionFailure: "direct_input_too_large",
    extractionFailureClass: "provider_retryable",
  };
}

export function formatDirectInputTooLargeLog(chars: number): string {
  return (
    `extraction: direct client refused a ${chars}-char request as too large; an atomic flush is never ` +
    "split, so any turns the gateway fallback does not extract stay buffered for `remnic buffer drain`"
  );
}

/**
 * Map the gateway fallback's discriminated parse-failure reason to a coarse
 * extraction failure class. "no models configured" is an auth/config problem;
 * an HTTP/transport failure backs off; an unparseable-but-present response is a
 * genuine empty-parse.
 */
export function classifyFallbackParseFailure(
  reason: "no_models" | "empty" | "http_error" | "schema_rejection" | "timeout",
): ExtractionFailureClass {
  switch (reason) {
    case "no_models":
      return "auth_config";
    case "http_error":
    case "timeout":
      return "provider_retryable";
    case "empty":
    case "schema_rejection":
      return "parse_empty";
  }
}

/**
 * Operator-visible extraction parse-failure line. Keeps the historical
 * greppable prefix and appends the fields that used to live only at debug.
 */
export function formatExtractionParseFailureLog(input: {
  failureReason: string;
  attemptedModel?: string;
  httpStatus?: number;
  errorClass?: string;
  traceId: string;
}): string {
  const modelUsed =
    typeof input.attemptedModel === "string" && input.attemptedModel.length > 0
      ? input.attemptedModel
      : "unknown";
  const errorClass =
    typeof input.errorClass === "string" && input.errorClass.length > 0
      ? input.errorClass
      : "none";
  const httpStatus =
    typeof input.httpStatus === "number" && Number.isFinite(input.httpStatus)
      ? String(input.httpStatus)
      : "none";
  return [
    "extraction fallback returned no parsed output",
    `failureReason=${input.failureReason}`,
    `modelUsed=${modelUsed}`,
    `errorClass=${errorClass}`,
    `httpStatus=${httpStatus}`,
    `traceId=${input.traceId}`,
  ].join(" ");
}

/**
 * The local endpoint answered, and what it said rejects this input (unusable content, or a client error that is not
 * auth, timeout or rate limiting): the chunk's problem, not an outage. A `finish_reason=length` reply classifies as
 * `output_truncated` (#3521); every other rejection retries like an empty parse, and a trigger-drain
 * chunk that keeps drawing it is dropped after its recovery copy is saved.
 */
export class LocalLlmRejectedError extends Error {
  constructor(readonly httpStatus?: number, readonly finishReason?: string) {
    super(httpStatus === undefined ? "local LLM answered with unusable content" : `local LLM rejected the input (HTTP ${httpStatus})`);
    this.name = "LocalLlmRejectedError";
  }
}

/**
 * Map a local-endpoint rejection to its failure class: a reply cut off at the
 * output ceiling (`finish_reason=length`) is `output_truncated` — retries at
 * the same `maxOutputTokens` can never complete (#3521). Every other unusable
 * or refused reply stays `parse_empty`.
 */
export function classifyLocalLlmRejected(err: LocalLlmRejectedError): ExtractionFailureClass {
  return err.finishReason === "length" ? "output_truncated" : "parse_empty";
}

/** What the local client recorded about a failed call (`failureDiag`). */
export interface LocalFailureDiag {
  lastError?: unknown;
  /** The completion's `finish_reason` as the client received it (validated before it is logged). */
  finishReason?: string;
}

/** The HTTP status when the local endpoint answered and refuses this input (400, 413, 422); else undefined. A wrong model name or route (404, 405, 410), auth, timeout and rate limiting are the setup's problem, not the chunk's. */
export function localRejectionStatus(diag: LocalFailureDiag): number | undefined {
  const status = httpStatusFromError(diag.lastError);
  return status !== undefined && [400, 413, 422].includes(status) ? status : undefined;
}
