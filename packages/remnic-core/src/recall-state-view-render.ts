/**
 * Recall inject-line renderer for state views (issue #1952).
 *
 * Historical and transition rows get `[superseded <date> by <id>]` when both
 * supersededAt and supersededBy are present. Current rows and a disabled
 * flag are identity.
 */
import { formatSupersededPrefix, type StateViewResult } from "./recall-state-view.js";

export type StateViewLineResult = StateViewResult & { text?: string };

export function renderStateViewLine(
  result: StateViewLineResult,
  options: { enabled?: boolean } = {},
): string {
  const text = typeof result.text === "string" ? result.text : "";
  if (options.enabled !== true) return text;
  const label = result.stateLabel;
  if (label !== "historical" && label !== "transition") return text;
  const date = result.supersededAt;
  const successor = result.supersededBy;
  if (!date || !successor) return text;
  return `${formatSupersededPrefix(date, successor)} ${text}`;
}
