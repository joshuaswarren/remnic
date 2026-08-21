/**
 * Recall inject-line mapper for state views (issue #1952).
 *
 * Maps each result through renderStateViewLine. A disabled flag keeps
 * original text per item. An empty list stays empty.
 */
import { renderStateViewLine, type StateViewLineResult } from "./recall-state-view-render.js";

export function injectStateViewLines(
  results: readonly StateViewLineResult[],
  options: { enabled?: boolean } = {},
): string[] {
  return results.map((result) => renderStateViewLine(result, options));
}
