/**
 * Episodic context planning (issue #2331, harmonic-memory P3).
 *
 * Turns the structured `sources` provenance on recalled facts into episode
 * windows over the LCM archive: resolve each source's turn, group overlapping
 * turn ranges within a session into merged episodes, and cap the episode
 * count/span. Pure planning — no archive access — plus an async wrapper that
 * applies the single documented fallback (quote lookup) through an injected
 * locator so the planner stays testable without SQLite.
 *
 * Window bounds are `[start, end)` throughout (`toTurn` exclusive); the
 * archive's `getMessages` bounds are inclusive, so the fetch site passes
 * `toTurn - 1`.
 */

import type { ProvenanceSource } from "./types.js";

/** One fact contributing to episodic planning, with its final recall rank. */
export interface EpisodicFactInput {
  memoryId: string;
  /** Final recall rank of the fact (0 = best). Lower wins. */
  rank: number;
  sources?: ProvenanceSource[];
}

/** A merged, fetch-ready episode window. */
export interface EpisodeWindow {
  sessionKey: string;
  /** Inclusive first turn. */
  fromTurn: number;
  /** EXCLUSIVE end turn (`[start, end)` semantics). */
  toTurn: number;
  /** Best (lowest) rank among contributing facts — drives ordering. */
  factRank: number;
  /** Sorted, deduplicated contributing memory ids (citation line). */
  memoryIds: string[];
}

/** Locates a quote's turn index within a session, or null on a miss. */
export type QuoteLocator = (
  quote: string,
  sessionKey: string,
) => Promise<number | null>;

const TURN_FIELD_SEPARATOR = String.fromCharCode(1);

/**
 * Resolve a provenance `turnId` to a numeric LCM turn index, or null.
 *
 * Extraction writes `turnId` as the host turn fingerprint
 * (`buildTurnFingerprint`: `role␁content␁thread␁turnIndex`), so the numeric
 * LCM turn index is the LAST `␁`-separated field. A bare integer string is
 * also accepted. Anything else is unresolvable — skip, never guess.
 */
export function resolveProvenanceTurnIndex(turnId: unknown): number | null {
  if (typeof turnId !== "string" || turnId.length === 0) return null;
  const lastField = turnId.includes(TURN_FIELD_SEPARATOR)
    ? turnId.split(TURN_FIELD_SEPARATOR).pop()!
    : turnId;
  if (!/^\d+$/.test(lastField)) return null;
  const parsed = Number.parseInt(lastField, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

interface DraftWindow {
  sessionKey: string;
  fromTurn: number;
  toTurn: number;
  factRank: number;
  bestTurn: number;
  memoryIds: Set<string>;
}

function windowForTurn(
  sessionKey: string,
  turn: number,
  rank: number,
  memoryId: string,
): DraftWindow {
  const fromTurn = Math.max(0, turn - 1);
  return {
    sessionKey,
    fromTurn,
    toTurn: turn + 2,
    factRank: rank,
    bestTurn: turn,
    memoryIds: new Set([memoryId]),
  };
}

function mergeDrafts(drafts: DraftWindow[], maxTurnsPerEpisode: number): EpisodeWindow[] {
  const bySession = new Map<string, DraftWindow[]>();
  for (const draft of drafts) {
    const list = bySession.get(draft.sessionKey);
    if (list) list.push(draft);
    else bySession.set(draft.sessionKey, [draft]);
  }

  const windows: EpisodeWindow[] = [];
  for (const [sessionKey, sessionDrafts] of bySession) {
    // Sort by fromTurn, then toTurn, so a shuffle cannot change merge results.
    sessionDrafts.sort(
      (a, b) => a.fromTurn - b.fromTurn || a.toTurn - b.toTurn,
    );
    let current: DraftWindow | null = null;
    const flush = () => {
      if (!current) return;
      windows.push(finalizeWindow(current, maxTurnsPerEpisode));
      current = null;
    };
    for (const draft of sessionDrafts) {
      if (current && draft.fromTurn <= current.toTurn) {
        // Overlapping or adjacent ([a,b) + [b,c) share no turn but read as one
        // continuous episode): merge. Merged bounds stay [start, end).
        current.toTurn = Math.max(current.toTurn, draft.toTurn);
        if (draft.factRank < current.factRank) {
          current.factRank = draft.factRank;
          current.bestTurn = draft.bestTurn;
        }
        for (const id of draft.memoryIds) current.memoryIds.add(id);
      } else {
        flush();
        current = { ...draft, memoryIds: new Set(draft.memoryIds) };
      }
    }
    flush();
  }
  return windows;
}

function finalizeWindow(draft: DraftWindow, maxTurnsPerEpisode: number): EpisodeWindow {
  let { fromTurn, toTurn } = draft;
  const span = toTurn - fromTurn;
  if (maxTurnsPerEpisode > 0 && span > maxTurnsPerEpisode) {
    // Trim the tail but keep the highest-ranked fact's turn inside: anchor one
    // turn of leading context on the best turn, clamped to the merged range.
    fromTurn = Math.min(
      Math.max(draft.bestTurn - 1, draft.fromTurn),
      draft.toTurn - maxTurnsPerEpisode,
    );
    // maxTurnsPerEpisode === 1 (or a clamp collision) can push the anchor
    // above the best turn; slide back down so the best turn stays included.
    if (fromTurn + maxTurnsPerEpisode <= draft.bestTurn) {
      fromTurn = Math.min(draft.bestTurn, draft.toTurn - maxTurnsPerEpisode);
    }
    toTurn = fromTurn + maxTurnsPerEpisode;
  }
  return {
    sessionKey: draft.sessionKey,
    fromTurn,
    toTurn,
    factRank: draft.factRank,
    memoryIds: [...draft.memoryIds].sort(),
  };
}

/** Total, stable ordering: rank asc, sessionKey asc, fromTurn asc, then residual identity. */
export function compareEpisodeWindows(
  left: EpisodeWindow,
  right: EpisodeWindow,
): number {
  return (
    left.factRank - right.factRank ||
    (left.sessionKey < right.sessionKey ? -1 : left.sessionKey > right.sessionKey ? 1 : 0) ||
    left.fromTurn - right.fromTurn ||
    left.toTurn - right.toTurn ||
    (left.memoryIds < right.memoryIds ? -1 : left.memoryIds > right.memoryIds ? 1 : 0)
  );
}

/**
 * Plan episode windows from recalled facts' structured provenance.
 *
 * Pure: no archive access. Facts without a structured `sources` array are
 * skipped (no legacy scalar `source` parsing). Sources whose `turnId` does
 * not resolve to a number are skipped — the caller decides whether to attempt
 * the quote fallback for facts that lost every source.
 *
 * `maxEpisodes` or `maxTurnsPerEpisode` of 0 disables the section: returns
 * `[]` before any work (zero semantics, checklist item 33).
 */
export function planEpisodeWindows(options: {
  recalledFacts: ReadonlyArray<EpisodicFactInput>;
  maxEpisodes: number;
  maxTurnsPerEpisode: number;
}): EpisodeWindow[] {
  if (options.maxEpisodes <= 0 || options.maxTurnsPerEpisode <= 0) return [];
  const drafts: DraftWindow[] = [];
  for (const fact of options.recalledFacts) {
    if (!fact || !Array.isArray(fact.sources)) continue;
    for (const source of fact.sources) {
      if (!source || typeof source.sessionKey !== "string" || source.sessionKey.length === 0) {
        continue;
      }
      const turn = resolveProvenanceTurnIndex(source.turnId);
      if (turn === null) continue;
      drafts.push(
        windowForTurn(source.sessionKey, turn, fact.rank, fact.memoryId),
      );
    }
  }
  if (drafts.length === 0) return [];
  const windows = mergeDrafts(drafts, options.maxTurnsPerEpisode);
  return windows.sort(compareEpisodeWindows).slice(0, options.maxEpisodes);
}

/**
 * Facts whose sources all failed turn resolution but that carry a quote.
 * These are the ONLY candidates for the quote-lookup fallback.
 */
export function factsNeedingQuoteFallback(
  recalledFacts: ReadonlyArray<EpisodicFactInput>,
): EpisodicFactInput[] {
  return recalledFacts.filter(
    (fact) =>
      fact &&
      Array.isArray(fact.sources) &&
      fact.sources.length > 0 &&
      fact.sources.some((source) => typeof source?.quote === "string" && source.quote.length > 0) &&
      !fact.sources.some((source) => resolveProvenanceTurnIndex(source?.turnId) !== null),
  );
}

/**
 * Plan episode windows, applying the single documented fallback: for a fact
 * whose turnIds ALL failed resolution but that has a quote, locate the quote
 * in the archive and window around the located turn. A locator miss means the
 * fact contributes no episode. Falls back to the pure plan when no locator is
 * supplied.
 */
export async function planEpisodeWindowsWithFallback(options: {
  recalledFacts: ReadonlyArray<EpisodicFactInput>;
  maxEpisodes: number;
  maxTurnsPerEpisode: number;
  locateQuote?: QuoteLocator;
}): Promise<EpisodeWindow[]> {
  const facts = [...options.recalledFacts];
  const locator = options.locateQuote;
  if (locator && facts.length > 0) {
    for (const fact of factsNeedingQuoteFallback(options.recalledFacts)) {
      for (const source of fact.sources ?? []) {
        if (typeof source?.quote !== "string" || source.quote.length === 0) continue;
        if (typeof source.sessionKey !== "string" || source.sessionKey.length === 0) continue;
        let turn: number | null = null;
        try {
          turn = await locator(source.quote, source.sessionKey);
        } catch {
          turn = null;
        }
        if (turn === null || !Number.isSafeInteger(turn) || turn < 0) continue;
        facts.push({
          memoryId: fact.memoryId,
          rank: fact.rank,
          sources: [
            {
              sessionKey: source.sessionKey,
              turnId: String(turn),
              observedAt: source.observedAt,
              quote: source.quote,
            },
          ],
        });
        break; // one located quote per fact is enough to window it
      }
    }
  }
  return planEpisodeWindows({
    recalledFacts: facts,
    maxEpisodes: options.maxEpisodes,
    maxTurnsPerEpisode: options.maxTurnsPerEpisode,
  });
}
