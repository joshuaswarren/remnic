/**
 * Issue #560 PR 4 — Memory Worth recall filter.
 *
 * Pure helper that multiplies candidate recall scores by a Memory Worth
 * factor (from `computeMemoryWorth`, PR 2) so memories with a history of
 * failed sessions sink in the ranking. Reading the per-memory counters is
 * the caller's job — this module does no I/O and depends only on PR 2's
 * pure scorer.
 *
 * The filter is feature-flagged (`recallMemoryWorthFilterEnabled` on
 * PluginConfig, default `false` in this PR) so operators can A/B it safely
 * before PR 5 flips the default.
 *
 * Intentional properties:
 *   - Pure function. No side effects, no I/O. Tested directly.
 *   - Candidates with no counters (empty `counters` map entry) score exactly
 *     the same as they did pre-filter (multiplier = 0.5, but we renormalize
 *     so the neutral prior stays neutral — see the "neutral prior preserves
 *     ranking among unseen memories" test below).
 *   - Stable: a strictly sorted input stays in its original order among
 *     items that all score to the prior. This matters because an ad-hoc
 *     sort that returns 0 for ties on some comparators but not others
 *     produces non-deterministic ordering (CLAUDE.md rule 19).
 *   - Does not mutate inputs — returns a new array.
 *
 * How the multiplier is applied:
 *   `new_score = old_score * (p_success / PRIOR)`
 *   where PRIOR = 0.5. This way an uninstrumented memory (p_success = 0.5)
 *   gets a multiplier of exactly 1.0 (no penalty, no boost), a memory that
 *   always succeeds gets a multiplier approaching 2.0 (boosted) and a
 *   memory that always fails gets a multiplier approaching 0.0 (sunk).
 *   Using the ratio instead of raw `p_success` keeps the filter from
 *   accidentally halving every un-instrumented memory the moment it ships.
 *
 * Out of scope:
 *   - Reading counters from storage (caller does that once per recall).
 *   - Orchestrator wiring / config plumbing (separate commit in this PR).
 *   - Default flip to `true` (PR 5 once benchmark confirms a win).
 */

import { computeMemoryWorth, type MemoryWorthResult } from "./memory-worth.js";

/**
 * One memory's outcome history, keyed by memory path so the filter can look
 * up a candidate's counters in O(1). `lastAccessed` is passed through to
 * `computeMemoryWorth` where it drives optional recency decay.
 */
export interface MemoryWorthCounters {
  mw_success?: number;
  mw_fail?: number;
  lastAccessed?: string | null;
}

/**
 * A scored recall candidate. Defined locally (rather than importing
 * `QmdSearchResult`) so the filter can be reused by any caller that has a
 * `{ path, score }` shape — e.g. unit tests, bench fixtures, and future
 * non-QMD retrieval backends.
 */
export interface MemoryWorthFilterCandidate {
  path: string;
  score: number;
}

export interface MemoryWorthFilterOptions {
  /**
   * Map from memory path → outcome counters. Candidates whose path is not
   * in this map score at the neutral prior (multiplier = 1.0).
   */
  counters: ReadonlyMap<string, MemoryWorthCounters>;
  /**
   * Current time reference — passed through to `computeMemoryWorth` for
   * decay math. Required (not defaulted) so tests and deterministic bench
   * runs don't depend on the wall clock.
   */
  now: Date;
  /**
   * Half-life for outcome decay, in milliseconds. Optional; when omitted,
   * decay is disabled and raw counters are used.
   */
  halfLifeMs?: number;
  /**
   * Re-sort the candidates by descending filtered score before returning.
   * When `false`, the original input order is preserved (but the `.score`
   * fields still reflect the multiplier). Default `true` because most
   * callers want a ranked result; a few tests / bench fixtures want the
   * order preserved so they can assert on position.
   */
  reorder?: boolean;
}

/**
 * Output of `applyMemoryWorthFilter`. `worth` surfaces the computed
 * `{ score, p_success, confidence }` for each candidate so observability /
 * xray layers can report why each item moved without re-deriving it.
 */
export interface MemoryWorthFilterResultItem {
  path: string;
  /** Final score after the Memory Worth multiplier is applied. */
  score: number;
  /** The untouched input score — useful for telemetry and xray. */
  originalScore: number;
  /** The multiplier that was applied (1.0 for uninstrumented memories). */
  multiplier: number;
  /** The Memory Worth result (`score`, `p_success`, `confidence`). */
  worth: MemoryWorthResult;
}

/**
 * Neutral prior from `computeMemoryWorth`. Uninstrumented memories score
 * exactly 0.5, so dividing by this value makes the multiplier land on 1.0
 * for candidates with no history.
 */
const NEUTRAL_PRIOR = 0.5;

/**
 * Apply the Memory Worth multiplier to each candidate's score and (by
 * default) re-sort the list by descending score.
 *
 * When `counters` is empty, every candidate gets a multiplier of 1.0 — the
 * function is safe to call unconditionally when the feature flag is on,
 * even for namespaces that have zero instrumented memories.
 */
export function applyMemoryWorthFilter(
  candidates: readonly MemoryWorthFilterCandidate[],
  options: MemoryWorthFilterOptions,
): MemoryWorthFilterResultItem[] {
  const reorder = options.reorder !== false;
  const result: MemoryWorthFilterResultItem[] = [];

  // Walk candidates in input order so the pre-sort ordering can act as a
  // stable tiebreaker below. Record each candidate's position so we can
  // break score ties deterministically (CLAUDE.md rule 19).
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i]!;
    const counters = options.counters.get(candidate.path) ?? {};
    const worth = computeMemoryWorth({
      mw_success: counters.mw_success,
      mw_fail: counters.mw_fail,
      lastAccessed: counters.lastAccessed,
      now: options.now,
      halfLifeMs: options.halfLifeMs,
    });
    const multiplier = worth.score / NEUTRAL_PRIOR;
    // Clamp the candidate score at zero before multiplying. A negative
    // base score (can happen when upstream penalties push a candidate
    // below zero) would flip the intended direction: a multiplier > 1
    // would move the score further negative (worse rank), while a
    // multiplier < 1 would move it toward zero (better rank). That's the
    // opposite of "failure-prone memories sink". Treat negatives as zero
    // so the filter's semantics hold regardless of upstream arithmetic.
    const safeBase = candidate.score < 0 ? 0 : candidate.score;
    const scored = safeBase * multiplier;
    result.push({
      path: candidate.path,
      score: scored,
      originalScore: candidate.score,
      multiplier,
      worth,
    });
  }

  if (!reorder) return result;

  // Attach original position for stable sort. Node's Array.sort is stable
  // by spec since ES2019, but we encode the tiebreaker explicitly so a
  // comparator reviewer can see the contract.
  const indexed = result.map((r, i) => ({ r, i }));
  indexed.sort((a, b) => {
    if (b.r.score !== a.r.score) return b.r.score - a.r.score;
    return a.i - b.i;
  });
  return indexed.map((x) => x.r);
}

/**
 * Convenience lookup helper for callers that already have an array of
 * memory files with `path` and frontmatter fields on each. Keeps the map
 * construction in one place so call sites don't drift.
 */
export function buildMemoryWorthCounterMap(
  memories: readonly {
    path: string;
    frontmatter: {
      mw_success?: number;
      mw_fail?: number;
      lastAccessed?: string | null;
    };
  }[],
): Map<string, MemoryWorthCounters> {
  const map = new Map<string, MemoryWorthCounters>();
  for (const m of memories) {
    const fm = m.frontmatter;
    // Only add entries with at least one counter present — keeps the map
    // small when the instrumented fraction is still low.
    if (fm.mw_success === undefined && fm.mw_fail === undefined) continue;
    map.set(m.path, {
      mw_success: fm.mw_success,
      mw_fail: fm.mw_fail,
      lastAccessed: fm.lastAccessed,
    });
  }
  return map;
}
