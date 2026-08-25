/**
 * Deterministic machine-readable recap export from timeline cards (issue #2051).
 *
 * Pure: cards + date + timezone in, stable JSON out. No LLM, no I/O, no
 * persistence. Same cards always serialize to the same bytes, regardless of
 * input array order: cards are sorted by id before serialization.
 *
 * Privacy boundary (issue #2053 policy): a card `title` is captured
 * observation content (the source window title). It is excluded unless the
 * export explicitly permits observations — the same default as
 * `activity.exportIncludeObservations`. Evidence references (store row ids,
 * identity hashes) are always kept: they point at content without copying it.
 */
import type { TimelineCard } from "./types.js";

export interface DeterministicRecapOptions {
  date: string;
  timezone: string;
  cards: readonly TimelineCard[];
  /**
   * Include observation-derived card content (`title`). Default false,
   * matching the `activity.exportIncludeObservations` policy default.
   */
  includeObservations?: boolean;
}

/** Card projected for export: `title` present only when the policy permits. */
export interface RecapExportCard extends Omit<TimelineCard, "title"> {
  title?: string;
}

export interface DeterministicRecap {
  date: string;
  timezone: string;
  cards: RecapExportCard[];
}

/**
 * Project one card for export with a fixed key order. Observation-derived
 * `title` is dropped unless `includeObservations`; user-authored provenance
 * (manual edits, pause reasons inside `summary`) stays, and evidence
 * references always stay.
 */
export function projectCardForRecapExport(
  card: TimelineCard,
  includeObservations: boolean,
): RecapExportCard {
  const projected: RecapExportCard = {
    id: card.id,
    kind: card.kind,
    summary: card.summary,
    categoryId: card.categoryId,
    confidence: card.confidence,
    startUtc: card.startUtc,
    endUtc: card.endUtc,
    dayKey: card.dayKey,
    timezone: card.timezone,
    machine: card.machine,
    evidenceIds: card.evidenceIds,
    evidenceRange: card.evidenceRange,
  };
  if (card.manualEdit !== undefined) {
    projected.manualEdit = card.manualEdit;
  }
  if (includeObservations) {
    projected.title = card.title;
  }
  return projected;
}

function compareCardIds(a: RecapExportCard, b: RecapExportCard): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Build the byte-stable JSON recap document for one local day.
 * Callers may `JSON.stringify` the returned object; construction order
 * (date, timezone, cards, and the per-card key order) is fixed, so
 * serialization is deterministic.
 */
export function exportDeterministicRecap(
  options: DeterministicRecapOptions,
): DeterministicRecap {
  const includeObservations = options.includeObservations === true;
  return {
    date: options.date,
    timezone: options.timezone,
    cards: options.cards
      .map((card) => projectCardForRecapExport(card, includeObservations))
      .sort(compareCardIds),
  };
}
