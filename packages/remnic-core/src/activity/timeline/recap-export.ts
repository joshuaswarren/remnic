/**
 * Deterministic machine-readable recap export from timeline cards (issue #2051).
 *
 * Pure: cards + date + timezone in, stable JSON out. No LLM, no I/O, no
 * persistence. Same cards always serialize to the same bytes, regardless of
 * input array order: cards are sorted by id before serialization.
 */
import type { TimelineCard } from "./types.js";

export interface DeterministicRecapOptions {
  date: string;
  timezone: string;
  cards: readonly TimelineCard[];
}

export interface DeterministicRecap {
  date: string;
  timezone: string;
  cards: TimelineCard[];
}

function compareCardIds(a: TimelineCard, b: TimelineCard): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Build the byte-stable JSON recap document for one local day.
 * Callers may `JSON.stringify` the returned object; construction order
 * (date, timezone, cards) is fixed, so serialization is deterministic.
 */
export function exportDeterministicRecap(
  options: DeterministicRecapOptions,
): DeterministicRecap {
  return {
    date: options.date,
    timezone: options.timezone,
    cards: [...options.cards].sort(compareCardIds),
  };
}
