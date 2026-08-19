/**
 * Pure state-view labeler (issue #1952 leftover).
 *
 * Surfaces wait. `current` stays current. `historical` and `transition`
 * keep their kind only when both supersededAt and successorId are set.
 * Missing either field is current. Unknown kind throws.
 */
import type { StateLabel } from "./recall-state-view.js";

export function labelStateView(input: {
  kind: string;
  supersededAt?: string;
  successorId?: string;
}): StateLabel {
  const { kind, supersededAt, successorId } = input;
  if (kind === "current") return "current";
  if (kind === "historical" || kind === "transition") {
    if (!supersededAt || !successorId) return "current";
    return kind;
  }
  throw new Error(`unknown state view kind: ${JSON.stringify(kind)}`);
}
