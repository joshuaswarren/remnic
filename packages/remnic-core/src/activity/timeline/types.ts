/**
 * Timeline-card layer over the #1899 activity store (issue #2049).
 *
 * A card is a deterministic, replayable *derived view*: it references snapshot
 * evidence by store row id and content identity, never copying or re-storing
 * it. All intervals are half-open [start, end) UTC; day bucketing reuses the
 * DST-aware `activityDayWindow` from the digest layer, so timeline days and
 * digests always agree on day bounds.
 */

/** Reference to one stored observation (subset of ActivitySnapshot; no text). */
export interface TimelineObservation {
  /** Store row id of the referenced snapshot. */
  id: number;
  machine: string;
  /** UTC ISO-8601 capture instant. */
  capturedAtUtc: string;
  app: string;
  windowTitle: string;
  /** Browser tab URL, when the frontmost window is a known browser. */
  browserUrl?: string;
  /** Content hash of the referenced snapshot (identity, not re-stored text). */
  contentHash: string;
}

/** User-declared pause, half-open [startUtc, endUtc) in UTC. Not idle. */
export interface TimelinePause {
  startUtc: string;
  endUtc: string;
  /** Free-form reason, kept verbatim on the derived pause card. */
  reason?: string;
}

/** One category definition in the registry. */
export interface TimelineCategory {
  /** Stable ID (`system.*` is the reserved namespace). */
  id: string;
  name: string;
  /** Hex color, `#RRGGBB`. */
  color: string;
  description: string;
  /** Presentation order; equal orders tie-break by id. */
  order: number;
  /** Reserved system category (idle / pause / unknown). */
  system?: boolean;
  /** Marks the reserved idle category. */
  idle?: boolean;
}

export type TimelineCardKind = "activity" | "idle" | "pause";

/** Provenance stamped on a card when a manual correction was applied. */
export interface TimelineManualEdit {
  categoryId?: string;
  title?: string;
  editedAtUtc: string;
}

/** A persisted manual correction; keyed by stable card id, survives rebuilds. */
export interface TimelineCorrection {
  cardId: string;
  categoryId?: string;
  title?: string;
  editedAtUtc: string;
}

/** Stable first/last evidence identity keys bracketing a card's sources. */
export interface TimelineEvidenceRange {
  firstKey: string;
  lastKey: string;
}

export interface TimelineCard {
  /** Stable content-derived id (never array position or wall-clock). */
  id: string;
  kind: TimelineCardKind;
  title: string;
  summary: string;
  categoryId: string;
  /** Classification confidence; manual corrections set it to 1. */
  confidence: number;
  /** Half-open [startUtc, endUtc) UTC bounds. */
  startUtc: string;
  endUtc: string;
  /** Local day key (YYYY-MM-DD) this card belongs to. */
  dayKey: string;
  timezone: string;
  /** Track the card was built on; null for machine-less pause cards. */
  machine: string | null;
  /** Store row ids of the source snapshots (empty for idle/pause). */
  evidenceIds: number[];
  /** First/last evidence identity keys (null for idle/pause). */
  evidenceRange: TimelineEvidenceRange | null;
  /** Present only when a manual correction was applied. */
  manualEdit?: TimelineManualEdit;
}

/** One replayable local day of cards. */
export interface TimelineDay {
  formatVersion: number;
  date: string;
  timezone: string;
  startUtc: string;
  endUtc: string;
  cards: TimelineCard[];
}
