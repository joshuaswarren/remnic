export interface LcmRowIdentity {
  id?: number;
  session_id?: string;
  turn_index: number;
}

export interface LcmEvidenceIdentity {
  id: string;
  archiveRowId?: number;
}

export function lcmArchiveRowId(row: Pick<LcmRowIdentity, "id">): number | undefined {
  const value = row.id;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function resolveSessionId(row: LcmRowIdentity, fallbackSessionId: string): string {
  return row.session_id ?? fallbackSessionId;
}

/**
 * Build the non-rendered evidence identity for an LCM archive row.
 *
 * Older adapters and test doubles may omit the SQLite row id. Those callers
 * retain the historical session+turn identity until they adopt row lineage.
 */
export function lcmEvidenceIdentity(
  row: LcmRowIdentity,
  fallbackSessionId: string,
): LcmEvidenceIdentity {
  const sessionId = resolveSessionId(row, fallbackSessionId);
  const archiveRowId = lcmArchiveRowId(row);
  if (archiveRowId === undefined) {
    return { id: `${sessionId}:${row.turn_index}` };
  }
  return {
    id: JSON.stringify(["lcm-row", sessionId, archiveRowId]),
    archiveRowId,
  };
}

/** Match a search hit to its expanded archive row without conflating siblings. */
export function isSameLcmRow(
  left: LcmRowIdentity,
  leftFallbackSessionId: string,
  right: LcmRowIdentity,
  rightFallbackSessionId: string,
): boolean {
  const leftRowId = lcmArchiveRowId(left);
  const rightRowId = lcmArchiveRowId(right);
  const leftSessionId = resolveSessionId(left, leftFallbackSessionId);
  const rightSessionId = resolveSessionId(right, rightFallbackSessionId);
  if (leftRowId !== undefined && rightRowId !== undefined) {
    return leftRowId === rightRowId && leftSessionId === rightSessionId;
  }
  return leftSessionId === rightSessionId && left.turn_index === right.turn_index;
}
