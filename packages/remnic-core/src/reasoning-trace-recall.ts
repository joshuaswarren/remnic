
export function looksLikeProblemSolvingQuery(query: string): boolean {
  if (typeof query !== "string") return false;
  const q = query.trim().toLowerCase();
  if (q.length === 0) return false;

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

export interface BoostableResult {
  path: string;
  score: number;
  docid?: string;
  /** Effective relevance carried forward by an upstream rerank stage. */
  effectiveScore?: number;
}

export function isReasoningTracePath(candidatePath: string): boolean {
  if (typeof candidatePath !== "string") return false;
  return /(^|[\\/])reasoning-traces([\\/]|$)/.test(candidatePath);
}

export const DEFAULT_REASONING_TRACE_BOOST = 0.15;

export interface ApplyReasoningTraceBoostOptions {
  enabled: boolean;
  query: string;
  boost?: number;
}

/**
 * The relevance a row is compared on: its effective relevance when a rerank
 * stage left one (MMR ranks on the same basis), else the raw retrieval score.
 */
function comparisonRelevance(row: BoostableResult): number {
  if (typeof row.effectiveScore === "number" && Number.isFinite(row.effectiveScore)) {
    return row.effectiveScore;
  }
  return typeof row.score === "number" && Number.isFinite(row.score) ? row.score : 0;
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

  const boosted: R[] = [];
  let changed = false;
  for (const r of results) {
    if (isReasoningTracePath(r.path)) {
      changed = true;
      const baseScore = typeof r.score === "number" && Number.isFinite(r.score) ? r.score : 0;
      const effective =
        typeof r.effectiveScore === "number" && Number.isFinite(r.effectiveScore)
          ? r.effectiveScore + boostAmount
          : undefined;
      boosted.push(
        effective === undefined
          ? ({ ...r, score: baseScore + boostAmount } as R)
          : ({ ...r, score: baseScore + boostAmount, effectiveScore: effective } as R),
      );
    } else {
      boosted.push(r);
    }
  }
  if (!changed) return boosted;

  const out = boosted.slice();
  for (let i = 0; i < out.length; i++) {
    if (!isReasoningTracePath(out[i].path)) continue;
    const trace = out[i];
    const traceScore = comparisonRelevance(trace);
    let j = i;
    while (j > 0) {
      const prev = out[j - 1];
      if (isReasoningTracePath(prev.path)) break; // don't reorder traces vs each other
      const prevScore = comparisonRelevance(prev);
      if (prevScore >= traceScore) break;
      out[j] = prev;
      j -= 1;
    }
    if (j !== i) out[j] = trace;
  }

  return out;
}
