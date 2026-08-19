/**
 * Recall state-view widening (issue #1952).
 *
 * When recallStateViews is on and the query is change-oriented, admit a
 * superseded memory only if its successor is already in the candidate set.
 * Flag off / non-change queries are identity.
 */
import {
  annotateStateView,
  isChangeOrientedQuery,
  parseRecallStateViews,
  resultStateViewId,
  shouldWidenSuperseded,
  type StateViewResult,
} from "./recall-state-view.js";

export function widenRecallStateViews<T extends StateViewResult>(
  results: T[],
  query: string,
  config: unknown,
  pool: readonly T[] = [],
): T[] {
  const raw =
    typeof config === "object" && config !== null && "recallStateViews" in config
      ? config.recallStateViews
      : undefined;
  const enabled = parseRecallStateViews(raw);
  if (!enabled || !isChangeOrientedQuery(query)) return results;

  const candidateIds = new Set<string>();
  for (const result of results) {
    const id = resultStateViewId(result);
    if (id) candidateIds.add(id);
  }

  const seen = new Set(candidateIds);
  const extra: T[] = [];
  for (const item of pool) {
    const id = resultStateViewId(item);
    if (!id || seen.has(id)) continue;
    if (!shouldWidenSuperseded(item.supersededBy, candidateIds)) continue;
    extra.push(item);
    seen.add(id);
  }

  return annotateStateView(extra.length > 0 ? results.concat(extra) : results, query, [], {
    enabled: true,
  });
}
