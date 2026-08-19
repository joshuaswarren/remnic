/**
 * Parse a timeline analysis claim's observationId (issue #2050).
 */
export type ParseClaimObservationIdResult =
  | { ok: true; observationId: string }
  | { ok: false; error: "missing_observation" };

export function parseClaimObservationId(claim: {
  observationId?: string | null;
}): ParseClaimObservationIdResult {
  const raw = claim.observationId;
  if (raw == null) return { ok: false, error: "missing_observation" };
  const observationId = raw.trim();
  if (observationId.length === 0) return { ok: false, error: "missing_observation" };
  return { ok: true, observationId };
}
