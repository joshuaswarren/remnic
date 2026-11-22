
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
