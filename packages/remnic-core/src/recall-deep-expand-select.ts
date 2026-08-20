/**
 * Select EXPAND node ids for deep recall (issue #2332).
 *
 * A foreign id refuses the whole selection; an oversized request truncates.
 * Duplicates collapse before the cap. Pure. Surfaces wait.
 */
export const DEFAULT_MAX_EXPAND_PER_STEP = 3;

export type ExpandSelectionResult =
  | { ok: true; nodeIds: string[]; truncated: boolean }
  | { ok: false; error: "invalid_policy_output"; foreignIds: string[] };

export function selectExpandNodeIds(input: {
  frontierIds: readonly string[];
  requestedIds: unknown;
  maxExpandPerStep?: number;
}): ExpandSelectionResult {
  const max =
    input.maxExpandPerStep === undefined
      ? DEFAULT_MAX_EXPAND_PER_STEP
      : input.maxExpandPerStep;
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(
      `maxExpandPerStep must be an integer >= 1; got ${JSON.stringify(max)}`,
    );
  }

  if (!Array.isArray(input.requestedIds)) {
    return { ok: false, error: "invalid_policy_output", foreignIds: [] };
  }

  const frontier = new Set(input.frontierIds);
  const seen = new Set<string>();
  const foreign = new Set<string>();
  const ordered: string[] = [];

  for (const entry of input.requestedIds) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      foreign.add(String(entry));
      continue;
    }
    if (!frontier.has(entry)) {
      foreign.add(entry);
      continue;
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    ordered.push(entry);
  }

  if (foreign.size > 0) {
    return {
      ok: false,
      error: "invalid_policy_output",
      foreignIds: [...foreign].sort(),
    };
  }

  const truncated = ordered.length > max;
  return {
    ok: true,
    nodeIds: truncated ? ordered.slice(0, max) : ordered,
    truncated,
  };
}
