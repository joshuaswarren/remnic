/**
 * Content-free activity health snapshot (issue #2053 slice).
 *
 * Pure status builder. Surfaces report gate state, retention policy, source
 * revision, last analysis outcome, and counts only — never observation or
 * card content, prompts, or media.
 */

export const ACTIVITY_ANALYSIS_STATUSES = ["ok", "failed", "skipped", "never"] as const;
export type ActivityAnalysisStatus = (typeof ACTIVITY_ANALYSIS_STATUSES)[number];

export interface ActivityHealthSnapshot {
  enabled: boolean;
  retentionDays: number;
  sourceRevision: string | null;
  lastAnalysisStatus: ActivityAnalysisStatus;
  observationCount: number;
  cardCount: number;
}

const STATUS_ALLOW_LIST = ACTIVITY_ANALYSIS_STATUSES.join(", ");

/**
 * Build the health snapshot. Master `enabled: false` still returns a snapshot
 * (surfaces must report the gate); counts stay as given and are never redacted.
 */
export function buildActivityHealth(input: {
  enabled: boolean;
  retentionDays: number;
  sourceRevision?: string | null;
  lastAnalysisStatus?: string | null;
  observationCount: number;
  cardCount: number;
}): ActivityHealthSnapshot {
  const { enabled, retentionDays, observationCount, cardCount } = input;
  if (!Number.isInteger(retentionDays) || retentionDays < 0) {
    throw new RangeError("retentionDays must be a non-negative integer");
  }
  if (!Number.isInteger(observationCount) || observationCount < 0) {
    throw new RangeError("invalid count: observationCount must be a non-negative integer");
  }
  if (!Number.isInteger(cardCount) || cardCount < 0) {
    throw new RangeError("invalid count: cardCount must be a non-negative integer");
  }
  const rawRevision = input.sourceRevision;
  const trimmedRevision = typeof rawRevision === "string" ? rawRevision.trim() : "";
  const rawStatus = input.lastAnalysisStatus;
  let lastAnalysisStatus: ActivityAnalysisStatus = "never";
  if (rawStatus !== undefined && rawStatus !== null) {
    if (!(ACTIVITY_ANALYSIS_STATUSES as readonly string[]).includes(rawStatus)) {
      throw new TypeError(
        `unknown analysis status ${JSON.stringify(rawStatus)}; expected one of: ${STATUS_ALLOW_LIST}`,
      );
    }
    lastAnalysisStatus = rawStatus as ActivityAnalysisStatus;
  }
  return {
    enabled,
    retentionDays,
    sourceRevision: trimmedRevision === "" ? null : trimmedRevision,
    lastAnalysisStatus,
    observationCount,
    cardCount,
  };
}
