/**
 * Analysis run metadata (issue #2050).
 *
 * Pure builder for the provider/model/prompt-version record attached to
 * stored analysis results and telemetry.
 *
 * The no-content guarantee is enforced by SHAPE, not by length: each field
 * must match an identifier/version syntax, so prose cannot be stored as a
 * "model name". A 200-character single-line string is happily prose
 * ("Summarize this user\u0027s activity"), which is why a length cap alone was
 * not the boundary this record needs. Errors never echo a rejected value,
 * so a mis-passed prompt cannot reach logs through the failure path either.
 */
export interface AnalysisRunMetadata {
  provider: string;
  model: string;
  promptVersion: string;
  /** Observation ids the run consumed, for evidence tracing. */
  observationCount: number;
}

export const ANALYSIS_METADATA_MAX_FIELD_LENGTH = 120;

/**
 * Identifier syntax for provider and model: letters, digits, and the
 * separators real provider/model slugs use (`openai`, `gpt-5.2`,
 * `anthropic/claude-4_1`, `llama3:8b`). No spaces, so a sentence cannot pass.
 */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:\-\/]*$/;

/**
 * Prompt versions are identifiers or dates (`v3`, `2026-08-01`,
 * `timeline-analysis.v2`), so the same syntax applies.
 */
const FIELD_PATTERNS: Readonly<Record<string, RegExp>> = {
  provider: IDENTIFIER,
  model: IDENTIFIER,
  promptVersion: IDENTIFIER,
};

function validateMetadataField(field: string, value: unknown): string {
  // Never interpolate the value itself: an error string is a log line, and a
  // caller that mis-passes prompt text must not have it echoed there.
  if (typeof value !== "string") {
    throw new RangeError(
      `analysis run metadata ${field} must be a string; received ${typeof value}`,
    );
  }
  if (value.length === 0) {
    throw new RangeError(`analysis run metadata ${field} must not be empty`);
  }
  if (value.length > ANALYSIS_METADATA_MAX_FIELD_LENGTH) {
    throw new RangeError(
      `analysis run metadata ${field} is too long (max ${ANALYSIS_METADATA_MAX_FIELD_LENGTH} characters)`,
    );
  }
  // Report a line break as a line break even though the pattern would also
  // reject it. U+2028 and U+2029 are line separators too: they break
  // line-oriented log consumers exactly like CR and LF.
  if (/[\n\r\u2028\u2029]/.test(value)) {
    throw new RangeError(`analysis run metadata ${field} must not contain a line break`);
  }
  const pattern = FIELD_PATTERNS[field];
  if (pattern === undefined) {
    throw new RangeError(`analysis run metadata has no pattern for field ${field}`);
  }
  if (!pattern.test(value)) {
    throw new RangeError(
      `analysis run metadata ${field} must be an identifier (letters, digits, and ._:-/ only)`,
    );
  }
  return value;
}

export function buildAnalysisRunMetadata(input: {
  provider: string;
  model: string;
  promptVersion: string;
  observationCount: number;
}): AnalysisRunMetadata {
  const provider = validateMetadataField("provider", input.provider);
  const model = validateMetadataField("model", input.model);
  const promptVersion = validateMetadataField("promptVersion", input.promptVersion);
  const observationCount = input.observationCount;
  if (
    typeof observationCount !== "number" ||
    !Number.isInteger(observationCount) ||
    observationCount < 0
  ) {
    // Report the type only. JSON.stringify would echo mis-passed content into
    // the log, and it throws outright on a bigint or a circular object.
    throw new RangeError(
      `analysis run metadata observationCount must be a non-negative integer; received ${typeof observationCount}`,
    );
  }
  return { provider, model, promptVersion, observationCount };
}
