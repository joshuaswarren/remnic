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
  resultStateViewKey,
  shouldWidenSuperseded,
  stateViewKey,
  type StateViewResult,
} from "./recall-state-view.js";

export function widenRecallStateViews<T extends StateViewResult>(
  results: T[],
  query: string,
  config: unknown,
  pool: readonly T[] = [],
  /**
   * #1952 — per-request effective flag (per-call `stateView` OR config,
   * gated on change intent), computed once at recall entry and threaded
   * through. When `true` it wins over the config read so a per-call
   * override survives a global `false` at the inject seam. Callers that
   * omit it keep the legacy config-only behavior.
   */
  stateViewActive?: boolean,
  /**
   * #1952 — historical recall pin (epoch ms). When set, the pool is
   * never widened (pool rows did not survive the asOf validity filter,
   * so pulling a not-yet-valid successor into a historical snapshot
   * would be wrong) and annotation runs in asOf mode: a predecessor is
   * kept and labeled relative to the snapshot without requiring its
   * successor.
   */
  asOfMs?: number,
): T[] {
  const raw =
    typeof config === "object" && config !== null && "recallStateViews" in config
      ? config.recallStateViews
      : undefined;
  const enabled = stateViewActive === true || parseRecallStateViews(raw);
  if (!enabled) return results;
  // #2893 — a threaded stateViewActive was gated on change intent
  // classified from the ORIGINAL prompt at recall entry; `query` here is
  // the cron-normalized retrievalQuery and may have lost the intent
  // signal (truncation / stop-word compaction), so do not re-check it.
  // Only the legacy config-only path re-checks intent against this query.
  if (stateViewActive !== true && !isChangeOrientedQuery(query)) return results;
  const asOfActive = typeof asOfMs === "number" && Number.isFinite(asOfMs);

  // #2859: matches are namespace-qualified, and a successor's `supersedes`
  // back-pointer anchors its predecessor even when the predecessor's own
  // `supersededBy` is absent.
  const candidateIds = new Set<string>();
  const supersedesAnchors = new Set<string>();
  for (const result of results) {
    const key = resultStateViewKey(result);
    if (!key) continue;
    candidateIds.add(key);
    if (result.supersedes) {
      supersedesAnchors.add(stateViewKey(result.namespace, result.supersedes));
    }
  }

  const seen = new Set(candidateIds);
  const extra: T[] = [];
  if (!asOfActive) {
    for (const item of pool) {
      const key = resultStateViewKey(item);
      if (!key || seen.has(key)) continue;
      const successorKey = item.supersededBy
        ? stateViewKey(item.namespace, item.supersededBy)
        : undefined;
      if (!shouldWidenSuperseded(successorKey, candidateIds) && !supersedesAnchors.has(key)) {
        continue;
      }
      extra.push(item);
      seen.add(key);
    }
  }

  return annotateStateView(extra.length > 0 ? results.concat(extra) : results, query, [], {
    enabled: true,
    ...(stateViewActive === true ? { changeIntent: true } : {}),
    ...(asOfActive ? { asOfMs } : {}),
  });
}
