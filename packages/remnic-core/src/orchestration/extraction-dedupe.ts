/**
 * Exact-duplicate collapse for one extraction drain window (#3443).
 *
 * Turns that repeat an earlier turn's role AND content within the same window
 * and scope are duplicate payloads: every one sent to the extraction model is
 * decode work that produces nothing the representative did not already cover.
 * The collapse keeps the FIRST occurrence as the representative and marks
 * every later copy so the drain's chunk still carries every identity —
 * buffer/claim clearing and chunk drops remove representative and duplicates
 * together — while the extraction run keeps the marked copies out of the
 * model conversation.
 *
 * Pure and read-only: buffered and claimed turns are never altered, reordered
 * or deleted here; markers live on fresh in-flight copies only.
 */

import { extractionScopeGroupKey } from "../buffer-turn-helpers.js";
import type { BufferTurn } from "../types.js";

/** The duplicate structure of one window, keyed by input position. */
export interface CollapsedDuplicates {
  /** First occurrence of each role+content key per scope, in input order. */
  readonly representatives: readonly BufferTurn[];
  /** Input position of `representatives[i]` — chunk slices map back through these. */
  readonly representativePositions: readonly number[];
  /** Per input position: true when that turn is a duplicate covered by an earlier representative. */
  readonly duplicateFlags: readonly boolean[];
  /** How many input turns are duplicates. */
  readonly duplicateCount: number;
}

/**
 * Collapse exact duplicates (same role AND same content, whitespace-sensitive)
 * to their first occurrence within each scope of one window. Turns in
 * different write scopes (namespace/principal/scope-profile/coding-binding
 * pins) are never collapsed together, even when the text is identical — the
 * same scope-group identity that partitions extractions partitions this
 * collapse. Identity beyond role+content (timestamp, session, fingerprints)
 * does not merge duplicates: every original stays a distinct identity the
 * drain must account for.
 */
export function collapseExactDuplicateTurns(turns: readonly BufferTurn[]): CollapsedDuplicates {
  const firstByKey = new Map<string, number>();
  const representatives: BufferTurn[] = [];
  const representativePositions: number[] = [];
  const duplicateFlags: boolean[] = new Array<boolean>(turns.length).fill(false);
  let duplicateCount = 0;
  for (const [position, turn] of turns.entries()) {
    const key = `${extractionScopeGroupKey(turn)}\u0000${turn.role}\u0000${turn.content}`;
    if (firstByKey.has(key)) {
      duplicateFlags[position] = true;
      duplicateCount += 1;
      continue;
    }
    firstByKey.set(key, position);
    representatives.push(turn);
    representativePositions.push(position);
  }
  return { representatives, representativePositions, duplicateFlags, duplicateCount };
}

/**
 * The drain's in-flight window: representatives pass through untouched, each
 * duplicate becomes a fresh marked COPY (identity fields unchanged, so
 * buffer/claim matching still finds the buffered turn). `start`/`end` bound
 * the slice, so a chunk expands to exactly its own original span.
 */
export function markDuplicateTurns(
  turns: readonly BufferTurn[],
  collapsed: CollapsedDuplicates,
  start = 0,
  end = turns.length,
): BufferTurn[] {
  const marked: BufferTurn[] = [];
  for (let position = start; position < end; position += 1) {
    const turn = turns[position]!;
    marked.push(collapsed.duplicateFlags[position] === true ? { ...turn, extractionDuplicateOf: true } : turn);
  }
  return marked;
}
