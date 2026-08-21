/**
 * Reasoning-trace recall boost (issue #564 PR 3).
 *
 * Pure helpers for:
 * - detecting whether a user query looks like a problem-solving ask
 *   ("how do I…", "step by step", etc.)
 * - boosting stored reasoning_trace memories within a result list when that
 *   condition matches.
 *
 * Callers gate these helpers behind the `recallReasoningTraceBoostEnabled`
 * config flag (default false); the helpers themselves are also no-ops when
 * `enabled` is false so they can be safely chained into the recall pipeline.
 */

/**
 * Heuristic: does the incoming query read like the user wants a stored
 * solution chain (reasoning trace)?
 *
 * Positive signals:
 *  - starts with "how do I", "how can I", "how would I", "how to"
 *  - contains "step by step", "walk me through", "work through"
 *  - contains "reasoning", "think through", "figure out", "debug"
 *  - explicitly mentions "trace" or "chain of thought"
 *
 * This is intentionally conservative — the boost is OFF by default, so false
 * negatives are cheap, but false positives would shift retrieval for ordinary
 * queries on an opt-in install.
 */
export function looksLikeProblemSolvingQuery(query: string): boolean {
  if (typeof query !== "string") return false;
  const q = query.trim().toLowerCase();
  if (q.length === 0) return false;

  // Starts-with patterns.
  const startsWithPatterns = [
    /^how\s+do\s+i\b/,
    /^how\s+can\s+i\b/,
    /^how\s+would\s+i\b/,
    /^how\s+should\s+i\b/,
    /^how\s+to\b/,
    /^what'?s?\s+the\s+best\s+way\s+to\b/,
    /^can\s+you\s+walk\s+me\s+through\b/,
    /^walk\s+me\s+through\b/,
    /^help\s+me\s+debug\b/,
    /^help\s+me\s+figure\s+out\b/,
    /^why\s+(does|is|did)\b/,
  ];
  for (const re of startsWithPatterns) {
    if (re.test(q)) return true;
  }

  // Anywhere-in-string phrases. These mirror the doc-comment's stated
  // positive signals: broader variants ("work through", "figure out",
  // "debug this") are included so "how do I debug this" doesn't have to
  // lean on the `help me debug` starts-with entry alone, and so queries
  // like "work through the problem" or "figure out why it broke" trigger
  // the heuristic as the docstring claims.
  const phrases = [
    "step by step",
    "step-by-step",
    "work through",
    "walk through",
    "walk me through",
    "reason through",
    "think through",
    "figure out",
    "chain of thought",
    "reasoning trace",
    "solution chain",
    "troubleshoot",
    "debug this",
    "debug the",
    " debug ",
  ];
  for (const phrase of phrases) {
    if (q.includes(phrase)) return true;
  }

  return false;
}

/**
 * Minimal shape the boost helper needs to read from a recall result. Matches
 * QmdSearchResult as of issue #564 but kept structural so tests and future
 * callers don't have to import orchestrator-level types.
 */
export interface BoostableResult {
  path: string;
  score: number;
  docid?: string;
}

/**
 * Path-based marker for memories that live in the dedicated
 * reasoning-traces/ subtree. Using a path segment keeps this cheap: no
 * frontmatter parsing or extra I/O is needed.
 */
export function isReasoningTracePath(candidatePath: string): boolean {
  if (typeof candidatePath !== "string") return false;
  // Match "/reasoning-traces/" as a full path segment to avoid false
  // positives like "my-reasoning-traces-notes/".
  return /(^|[\\/])reasoning-traces([\\/]|$)/.test(candidatePath);
}

/**
 * Default additive boost applied to a reasoning_trace candidate when the
 * current query looks like a problem-solving ask.
 *
 * Chosen to be roughly the same magnitude as the existing CATEGORY_BOOSTS
 * entry for reasoning_trace (0.09 in importance scoring), keeping the signal
 * visible but not overwhelming stronger lexical/vector matches.
 */
export const DEFAULT_REASONING_TRACE_BOOST = 0.15;

export interface ApplyReasoningTraceBoostOptions {
  enabled: boolean;
  query: string;
  boost?: number;
}

/**
 * Apply a score boost to results whose path sits under reasoning-traces/
 * when the query looks like a problem-solving ask. Returns a new array;
 * the input array is not mutated.
 *
 * Ordering policy: the helper walks the results in order, boosts every
 * matching reasoning trace in place, then promotes each boosted trace
 * upward PAST any non-boosted neighbor whose score is strictly lower
 * than the trace's boosted score. Non-matching results keep their
 * incoming relative order — so reranker-driven path ordering and any
 * other upstream nudges on non-trace items are preserved. We do NOT
 * re-sort the full list, which would wipe out rerank priority on
 * non-trace items (whose numeric scores may have been left stale by the
 * rerank pass). This matters because MMR runs immediately after and
 * truncates to a topN window — globally re-sorting would silently drop
 * reranker-promoted items below the cutoff.
 *
 * No-ops (returns a copy of the input unchanged) when:
 *  - `enabled` is false,
 *  - `query` is empty / not a problem-solving ask,
 *  - the result list contains no reasoning-trace paths.
 *
 * Note on legacy paths: this helper intentionally only matches paths
 * under the dedicated `reasoning-traces/` subtree introduced by PR 3.
 * Historical reasoning_trace memories (if any) written before that
 * subtree existed were routed to `facts/<date>/` and are NOT
 * boost-eligible. Operators upgrading across that boundary should run
 * the migration CLI or rewrite old paths before enabling the boost.
 */
export function applyReasoningTraceBoost<R extends BoostableResult>(
  results: readonly R[],
  options: ApplyReasoningTraceBoostOptions,
): R[] {
  if (!options.enabled) return [...results];
  if (!Array.isArray(results) || results.length === 0) return [...results];
  if (!looksLikeProblemSolvingQuery(options.query)) return [...results];

  const boostAmount =
    typeof options.boost === "number" && Number.isFinite(options.boost) && options.boost >= 0
      ? options.boost
      : DEFAULT_REASONING_TRACE_BOOST;

  // Step 1: boost the scores of matching traces, preserving positions.
  const boosted: R[] = [];
  let changed = false;
  for (const r of results) {
    if (isReasoningTracePath(r.path)) {
      changed = true;
      const baseScore = typeof r.score === "number" && Number.isFinite(r.score) ? r.score : 0;
      boosted.push({ ...r, score: baseScore + boostAmount } as R);
    } else {
      boosted.push(r);
    }
  }
  if (!changed) return boosted;

  // Step 2: promote each boosted trace upward past any non-trace neighbor
  // whose score is strictly lower than the boosted score. Non-trace items
  // never move past each other, so reranker-driven ordering on non-trace
  // items is preserved.
  const out = boosted.slice();
  for (let i = 0; i < out.length; i++) {
    if (!isReasoningTracePath(out[i].path)) continue;
    const trace = out[i];
    const traceScore =
      typeof trace.score === "number" && Number.isFinite(trace.score) ? trace.score : 0;
    let j = i;
    while (j > 0) {
      const prev = out[j - 1];
      if (isReasoningTracePath(prev.path)) break; // don't reorder traces vs each other
      const prevScore =
        typeof prev.score === "number" && Number.isFinite(prev.score) ? prev.score : 0;
      if (prevScore >= traceScore) break;
      out[j] = prev;
      j -= 1;
    }
    if (j !== i) out[j] = trace;
  }

  return out;
}
