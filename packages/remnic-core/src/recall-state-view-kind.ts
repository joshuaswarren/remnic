/**
 * Recall state-view kind parse (issue #1952 leftover).
 *
 * Pure. Surfaces wait. Unknown or empty is unknown_kind.
 */

const STATE_VIEW_KINDS = ["current", "historical", "transition"] as const;

export type StateViewKind = (typeof STATE_VIEW_KINDS)[number];

export type ParseStateViewKindResult =
  | { ok: true; kind: StateViewKind }
  | { ok: false; error: "unknown_kind" };

export function parseStateViewKind(value: string): ParseStateViewKindResult {
  if ((STATE_VIEW_KINDS as readonly string[]).includes(value)) {
    return { ok: true, kind: value as StateViewKind };
  }
  return { ok: false, error: "unknown_kind" };
}
