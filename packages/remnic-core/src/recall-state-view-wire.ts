/**
 * Recall inject seam for state views (issue #1952).
 *
 * parseConfig cannot grow (fileSizeGrandfather). Operators set
 * `recallStateViews` on the live PluginConfig extra field. Default false
 * is identity. Use parseRecallStateViews — do not read
 * config.recallStateViewsEnabled.
 */
import {
  annotateStateView,
  parseRecallStateViews,
  type StateViewResult,
} from "./recall-state-view.js";

export function applyRecallStateViews<T extends StateViewResult>(
  results: T[],
  query: string,
  config: { ["recallStateViews"]?: unknown },
): T[] {
  return annotateStateView(results, query, [], {
    enabled: parseRecallStateViews(config["recallStateViews"]),
  });
}
