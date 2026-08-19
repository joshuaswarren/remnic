/**
 * Drop analysis claims that do not cite a supplied observation (issue #2050).
 */
export interface TimelineEvidenceClaim {
  observationId: number;
}

export interface TimelineEvidenceObservation {
  id: number;
}

/** Keep claims whose observationId is present. Preserve claim order. */
export function boundEvidence<T extends TimelineEvidenceClaim>(
  claims: readonly T[],
  observations: readonly TimelineEvidenceObservation[],
): T[] {
  if (observations.length === 0) return [];
  const ids = new Set(observations.map((observation) => observation.id));
  return claims.filter((claim) => ids.has(claim.observationId));
}
