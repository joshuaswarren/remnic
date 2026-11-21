/**
 * Coarse failure class consumed by the extraction retry/backoff + circuit
 * breaker layer (extraction hot-loop hardening). Kept deliberately small:
 * - `provider_retryable`: transient provider failure (429/5xx/network) — back off and retry.
 * - `parse_empty`: provider responded but produced no parseable output — retry with a low attempt cap.
 * - `output_truncated`: provider stopped at its output ceiling (`finish_reason=length`) — a retry
 *   at the same `maxOutputTokens` can never complete, so the fingerprint long-parks immediately;
 *   the window survives for a run under a raised ceiling (#3521).
 * - `auth_config`: auth/config failure (401/403/"no models configured") — open the breaker immediately.
 */
export type ExtractionFailureClass = "provider_retryable" | "parse_empty" | "output_truncated" | "auth_config";
