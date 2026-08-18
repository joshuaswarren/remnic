/**
 * Recall inject seam for state views (issue #1952).
 *
 * parseConfig cannot grow (fileSizeGrandfather). Operators set
 * `recallStateViews` on the live PluginConfig extra field. Default false
 * is identity. Use parseRecallStateViews — do not read a scattered
 * config flag property here.
 */

import {
  annotateStateView,
  parseRecallStateViews,
  type StateViewResult,
} from "./recall-state-view.js";

export function applyRecallStateViews<T extends StateViewResult>(
  results: T[],
  query: string,
  config: unknown,
): T[] {
  const raw =
    typeof config === "object" && config !== null && "recallStateViews" in config
      ? (config as { recallStateViews?: unknown }).recallStateViews
      : undefined;
  return annotateStateView(results, query, [], {
    enabled: parseRecallStateViews(raw),
  });
}
