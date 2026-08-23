/**
 * Recall inject seam for state views (issue #1952).
 *
 * Widening lives in recall-state-view-widen.ts. parseConfig cannot grow.
 * Operators set `recallStateViews` on the live PluginConfig extra field.
 * Default false is identity.
 */

import { widenRecallStateViews } from "./recall-state-view-widen.js";
import type { StateViewResult } from "./recall-state-view.js";

export function applyRecallStateViews<T extends StateViewResult>(
  results: T[],
  query: string,
  config: unknown,
  stateViewActive?: boolean,
): T[] {
  return widenRecallStateViews(results, query, config, [], stateViewActive);
}
