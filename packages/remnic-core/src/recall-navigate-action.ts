/**
 * Recall navigation action parse (issue #1956 leftover).
 *
 * Pure. Surfaces wait. Unknown or empty is unknown_action.
 */

const NAVIGATE_ACTIONS = ["expand", "traverse"] as const;

export type NavigateAction = (typeof NAVIGATE_ACTIONS)[number];

export type ParseNavigateActionResult =
  | { ok: true; action: NavigateAction }
  | { ok: false; error: "unknown_action" };

export function parseNavigateAction(value: string): ParseNavigateActionResult {
  if ((NAVIGATE_ACTIONS as readonly string[]).includes(value)) {
    return { ok: true, action: value as NavigateAction };
  }
  return { ok: false, error: "unknown_action" };
}
