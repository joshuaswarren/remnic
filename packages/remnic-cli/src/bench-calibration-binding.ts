export interface CalibrationProvenanceBinding {
  sourceResultId?: string;
  expectedAnswerSetSha256?: string;
  expectedQuestionIdListSha256?: string;
}

export interface CalibrationProvenanceState {
  sourceResultId?: string;
  answerSetHash?: string;
  orderedQuestionIdsHash?: string;
}

/**
 * Require provenance pins to be an all-or-nothing extension of the two judge
 * configuration pins. Returns whether the caller supplied provenance pins.
 */
export function validateCalibrationProvenancePinSet(
  binding: CalibrationProvenanceBinding,
  hasBothConfigPins: boolean
): boolean {
  const pins = [binding.sourceResultId, binding.expectedAnswerSetSha256, binding.expectedQuestionIdListSha256];
  const hasAny = pins.some((pin) => pin !== undefined);
  if (hasAny && (!pins.every((pin) => pin !== undefined) || !hasBothConfigPins)) {
    throw new Error(
      "--source-result-id, --expected-answer-set-sha256, and --expected-question-id-list-sha256 must be supplied together with both calibration configuration pins."
    );
  }
  return hasAny;
}

/** Validate the state loaded atomically at benchmark dispatch against its source pins. */
export function assertCalibrationProvenanceMatches(
  binding: CalibrationProvenanceBinding,
  state: CalibrationProvenanceState,
  benchmarkId: string
): void {
  if (
    binding.sourceResultId !== undefined &&
    (binding.sourceResultId !== state.sourceResultId ||
      binding.expectedAnswerSetSha256 !== state.answerSetHash ||
      binding.expectedQuestionIdListSha256 !== state.orderedQuestionIdsHash)
  ) {
    throw new Error(
      `Calibration provenance mismatch for ${benchmarkId}; refusing to attach calibration state from an unpinned source.`
    );
  }
}
