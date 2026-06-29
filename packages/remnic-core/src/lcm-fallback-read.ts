/**
 * Shared helper for reading LCM-backed recall sections across the ordered,
 * read-authorized fallback key set (#1505 codex P2 "Merge LCM fallback reads
 * instead of short-circuiting").
 *
 * Background: a branch-scoped session archives its LCM rows under whichever
 * coding-overlay namespace was effective at write time, so its evidence can be
 * split across the primary overlay key AND the project / root fallback keys.
 * Normal QMD/file recall already searches the primary namespace PLUS
 * `codingOverlay.readFallbacks` and MERGES the rows. The LCM read path must do
 * the same: query EVERY authorized read key and merge the candidate evidence
 * into each section's existing dedupe + rank + budget pass, instead of stopping
 * at the first key that happens to yield a (possibly weak) hit.
 *
 * Each section already owns a section-appropriate dedupe (a `seen` set or a
 * `rankAndDedupe…` step), so the fan-out only needs to resolve the ordered,
 * deduped read-key set and UNION the per-key candidates into that existing
 * pipeline — the budget is then applied exactly once to the union. Centralizing
 * the key-set resolution here (rather than re-implementing per builder) follows
 * CLAUDE.md rule 22 (scope resolution must be deduplicated).
 */

/** A recall section's LCM read target: either a single key or an ordered set. */
export interface LcmReadSessionTarget {
  /**
   * The single LCM read `session_id` (pre-#1505 behavior). `undefined` means a
   * sessionless, archive-wide read with no `session_id` filter.
   */
  sessionId?: string;
  /**
   * The ordered, read-authorized LCM read key set (primary overlay key first,
   * then project / root fallbacks) the orchestrator derived from the same
   * readable namespace set normal recall searches. When present and non-empty,
   * it supersedes `sessionId`.
   */
  sessionIds?: readonly (string | undefined)[];
}

// `undefined` (a sessionless, archive-wide read) is a distinct, legitimate read
// target, so it needs a non-string sentinel in the dedupe set. A leading space
// keeps it disjoint from every real session key / namespaced LCM key (which are
// `[A-Za-z0-9._-]` plus the U+001F namespace sentinel, never leading-space).
const UNDEFINED_SESSION_SENTINEL = " <lcm-sessionless>";

/**
 * Resolve the ordered, deduped set of LCM read `session_id`s a recall section
 * must query.
 *
 * When `sessionIds` is provided (the #1505 fallback unification), it is used
 * verbatim, deduped while preserving first-seen order so the caller queries
 * keys in priority order (primary overlay → fallbacks) without re-querying an
 * identical key (e.g. when two namespaces both collapse to the default store).
 * Otherwise the section reads under the single `sessionId`, so the result is
 * `[sessionId]` — byte-for-byte the pre-#1505 single-key behavior, including a
 * single `undefined` for a sessionless archive-wide read.
 */
export function resolveLcmReadSessionIds(
  target: LcmReadSessionTarget,
): Array<string | undefined> {
  const source =
    target.sessionIds && target.sessionIds.length > 0
      ? target.sessionIds
      : [target.sessionId];
  const seen = new Set<string>();
  const out: Array<string | undefined> = [];
  for (const sessionId of source) {
    const key = sessionId === undefined ? UNDEFINED_SESSION_SENTINEL : sessionId;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sessionId);
  }
  // Defensive: an all-empty `sessionIds` still collapses to the single-key path.
  return out.length > 0 ? out : [target.sessionId];
}
