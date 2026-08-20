/**
 * Analysis run metadata (issue #2050).
 *
 * Pure builder for the provider/model/prompt-version record attached to
 * stored analysis results and telemetry. The shape is deliberately
 * content-proof: three short single-line strings plus a count, so a
 * metadata record cannot carry prompt text, response text, or secrets.
 */
export interface AnalysisRunMetadata {
  provider: string;
  model: string;
  promptVersion: string;
  /** Observation ids the run consumed, for evidence tracing. */
  observationCount: number;
}

export const ANALYSIS_METADATA_MAX_FIELD_LENGTH = 200;

function validateMetadataField(field: string, value: string): string {
  if (typeof value !== "string") {
    throw new RangeError(`analysis run metadata ${field} must be a non-blank string`);
  }
  // Newline first: a trailing newline is also "surrounding whitespace", but the
  // contract requires any newline to report as a newline.
  if (value.includes("\n") || value.includes("\r")) {
    throw new RangeError(`analysis run metadata ${field} must not contain a newline`);
  }
  if (value.length === 0 || value.trim().length === 0 || value.trim() !== value) {
    throw new RangeError(
      `analysis run metadata ${field} must be a non-blank string without surrounding whitespace`,
    );
  }
  if (value.length > ANALYSIS_METADATA_MAX_FIELD_LENGTH) {
    throw new RangeError(
      `analysis run metadata ${field} is too long (max ${ANALYSIS_METADATA_MAX_FIELD_LENGTH} characters)`,
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
    !Number.isFinite(observationCount) ||
    !Number.isInteger(observationCount) ||
    observationCount < 0
  ) {
    throw new RangeError(
      `analysis run metadata observationCount must be a non-negative integer; got ${JSON.stringify(observationCount)}`,
    );
  }
  return { provider, model, promptVersion, observationCount };
}
