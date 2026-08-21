/**
 * Deterministic half-open recap window clip (issue #2051).
 *
 * Clips cards to [windowStartMs, windowEndMs) so recap renderers share one
 * day-boundary derivation instead of re-deriving it per renderer.
 */
export interface RecapWindowCard {
  id: string;
  startUtc: string;
  endUtc: string;
}

export interface ClippedRecapCard {
  id: string;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export function clipCardsToRecapWindow(
  cards: readonly RecapWindowCard[],
  windowStartMs: number,
  windowEndMs: number,
): ClippedRecapCard[] {
  // NaN fails every comparison, so an unchecked non-finite bound slips past the
  // ordering guard and emits NaN timestamps and durations — `durationMs <= 0`
  // is also false for NaN, so the card is not even dropped.
  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs)) {
    throw new RangeError(
      `recap window bounds must be finite; got start ${windowStartMs} and end ${windowEndMs}`,
    );
  }
  if (windowEndMs <= windowStartMs) {
    throw new RangeError(
      `recap window end ${windowEndMs} must be greater than start ${windowStartMs}`,
    );
  }
  const out: ClippedRecapCard[] = [];
  for (const card of cards) {
    const startMs = Date.parse(card.startUtc);
    const endMs = Date.parse(card.endUtc);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      continue;
    }
    const clippedStart = Math.max(startMs, windowStartMs);
    const clippedEnd = Math.min(endMs, windowEndMs);
    const durationMs = clippedEnd - clippedStart;
    if (durationMs <= 0) {
      continue;
    }
    out.push({ id: card.id, startMs: clippedStart, endMs: clippedEnd, durationMs });
  }
  out.sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
