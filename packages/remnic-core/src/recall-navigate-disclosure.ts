/**
 * Disclosure ladder for recall navigation (issue #1956).
 *
 * Pure. Levels are ordered shallowest→deepest and matched exactly:
 * no trimming, no case folding. `planDisclosureStep` allows only
 * strictly deeper expansions so a caller cannot re-pay budget for
 * output it already has.
 */
export const DISCLOSURE_LEVELS = ["chunk", "section", "raw"] as const;
export type DisclosureLevel = (typeof DISCLOSURE_LEVELS)[number];

export type DisclosureStepResult =
  | { ok: true; from: DisclosureLevel; to: DisclosureLevel; steps: number }
  | { ok: false; error: "unknown_level" | "not_deeper" };

export function disclosureRank(level: string): number {
  const index = (DISCLOSURE_LEVELS as readonly string[]).indexOf(level);
  if (index === -1) {
    throw new RangeError(
      `unknown disclosure level ${JSON.stringify(level)}; allowed values: ${DISCLOSURE_LEVELS.join(", ")}`,
    );
  }
  return index;
}

export function planDisclosureStep(input: {
  from: string;
  to: string;
}): DisclosureStepResult {
  // Runtime guard: the declared type says string, but callers pass
  // agent-supplied JSON. A bad request is a typed refusal, not a crash.
  if (typeof input.from !== "string" || typeof input.to !== "string") {
    return { ok: false, error: "unknown_level" };
  }
  let fromRank: number;
  let toRank: number;
  try {
    fromRank = disclosureRank(input.from);
    toRank = disclosureRank(input.to);
  } catch {
    return { ok: false, error: "unknown_level" };
  }
  if (toRank <= fromRank) {
    return { ok: false, error: "not_deeper" };
  }
  return {
    ok: true,
    from: DISCLOSURE_LEVELS[fromRank],
    to: DISCLOSURE_LEVELS[toRank],
    steps: toRank - fromRank,
  };
}
