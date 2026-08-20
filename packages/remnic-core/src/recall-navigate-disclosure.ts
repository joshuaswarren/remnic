/**
 * Disclosure-step planning for recall navigation (issue #1956).
 *
 * The ladder itself is NOT redefined here: `types.ts` designates
 * `RECALL_DISCLOSURE_LEVELS` the single source of truth and forbids
 * hard-coding disclosure strings elsewhere, so a second copy could drift out
 * of agreement with recall validation and rendering. This module only adds
 * the rule that an expansion must go strictly deeper, so a caller cannot
 * re-pay recall budget for output it already holds. Pure — no I/O.
 */

import {
  isRecallDisclosure,
  RECALL_DISCLOSURE_LEVELS,
  type RecallDisclosure,
} from "./types.js";

export type DisclosureStepResult =
  | { ok: true; from: RecallDisclosure; to: RecallDisclosure; steps: number }
  | { ok: false; error: "unknown_level" | "not_deeper" };

/** Index in the canonical shallow-to-deep ladder. Throws for a non-level. */
export function disclosureRank(level: string): number {
  const index = (RECALL_DISCLOSURE_LEVELS as readonly string[]).indexOf(level);
  if (index < 0) {
    throw new RangeError(
      `unknown disclosure level ${JSON.stringify(level)}; expected one of ${RECALL_DISCLOSURE_LEVELS.join(", ")}`,
    );
  }
  return index;
}

/**
 * Plan one expansion. A bad level from an agent is a typed refusal rather
 * than a throw; equal or shallower targets are `not_deeper`.
 */
export function planDisclosureStep(input: { from: string; to: string }): DisclosureStepResult {
  if (!isRecallDisclosure(input.from) || !isRecallDisclosure(input.to)) {
    return { ok: false, error: "unknown_level" };
  }
  const fromRank = disclosureRank(input.from);
  const toRank = disclosureRank(input.to);
  if (toRank <= fromRank) return { ok: false, error: "not_deeper" };
  return { ok: true, from: input.from, to: input.to, steps: toRank - fromRank };
}
