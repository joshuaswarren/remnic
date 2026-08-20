/**
 * Typed failure classification for timeline analysis (issue #2050).
 *
 * Unknown kinds fail closed with a TypeError. Pure: no I/O, no clock, no randomness.
 */

export const ANALYSIS_FAILURE_KINDS = [
  "provider_unavailable",
  "timeout",
  "aborted",
  "rate_limited",
  "malformed_json",
  "invalid_schema",
  "partial_output",
  "invalid_config",
] as const;
export type AnalysisFailureKind = (typeof ANALYSIS_FAILURE_KINDS)[number];

export interface AnalysisFailure {
  kind: AnalysisFailureKind;
  /** True only when retrying the same request could plausibly succeed. */
  retryable: boolean;
  /** True when the deterministic cards must be preserved unchanged. */
  preservesDeterministic: true;
}

const RETRYABLE_BY_KIND: Readonly<Record<AnalysisFailureKind, boolean>> = {
  provider_unavailable: true,
  timeout: true,
  rate_limited: true,
  aborted: false,
  malformed_json: false,
  invalid_schema: false,
  partial_output: false,
  invalid_config: false,
};

/** True when the value is one of the known failure kinds. */
export function isAnalysisFailureKind(
  value: unknown,
): value is AnalysisFailureKind {
  return (
    typeof value === "string" &&
    (ANALYSIS_FAILURE_KINDS as readonly string[]).includes(value)
  );
}

/** Classify a failure kind. Unknown kinds throw; there is no permissive default. */
export function classifyAnalysisFailure(kind: string): AnalysisFailure {
  if (!isAnalysisFailureKind(kind)) {
    throw new TypeError(
      `unknown analysis failure kind: ${String(kind)}; allowed kinds: ${ANALYSIS_FAILURE_KINDS.join(", ")}`,
    );
  }
  return {
    kind,
    retryable: RETRYABLE_BY_KIND[kind],
    preservesDeterministic: true,
  };
}
