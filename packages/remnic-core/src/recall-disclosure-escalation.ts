
import type { RecallDisclosure } from "./types.js";

export type DisclosureEscalationMode = "manual" | "auto";

export const DISCLOSURE_ESCALATION_MODES: readonly DisclosureEscalationMode[] = [
  "manual",
  "auto",
] as const;

export function isDisclosureEscalationMode(
  value: unknown,
): value is DisclosureEscalationMode {
  return (
    typeof value === "string" &&
    (DISCLOSURE_ESCALATION_MODES as readonly string[]).includes(value)
  );
}

export const DEFAULT_DISCLOSURE_ESCALATION_THRESHOLD = 0.5;

export interface DisclosureEscalationDecision {
  /** The disclosure depth the caller should use to shape the response. */
  effective: RecallDisclosure;
  /**
   * `true` when the policy escalated from the original disclosure;
   * `false` when the original was kept (either by manual mode, by
   * caller explicit choice, or because confidence stayed above the
   * threshold).
   */
  escalated: boolean;
  /**
   * Human-readable reason for the decision.  Always populated; surfaces
   * in operator-facing telemetry / debug paths.
   */
  reason: string;
}

export interface DecideDisclosureEscalationInput {
  /** The mode from config (`manual` | `auto`). */
  mode: DisclosureEscalationMode;
  /** Threshold in [0, 1]; values outside this range fall back to the default. */
  threshold: number;
  /** Disclosure resolved at request time (after default-fill). */
  originalDisclosure: RecallDisclosure;
  /**
   * Whether the caller explicitly specified a disclosure value.  Auto
   * mode only acts when the caller did NOT specify, so explicit
   * `chunk` requests are not silently upgraded.
   */
  callerProvidedDisclosure: boolean;
  /**
   * Top-K confidence (`final` score from the highest-ranked result),
   * or `undefined` when the snapshot has no scored results.
   */
  topKConfidence: number | undefined;
}

/**
 * Decide whether to escalate disclosure depth based on policy + signals.
 * Pure function — no IO, no state.
 */
export function decideDisclosureEscalation(
  input: DecideDisclosureEscalationInput,
): DisclosureEscalationDecision {
  if (input.mode === "manual") {
    return {
      effective: input.originalDisclosure,
      escalated: false,
      reason: "escalation-mode=manual",
    };
  }

  if (input.callerProvidedDisclosure) {
    return {
      effective: input.originalDisclosure,
      escalated: false,
      reason: "caller-explicit-disclosure",
    };
  }

  if (input.originalDisclosure !== "chunk") {
    return {
      effective: input.originalDisclosure,
      escalated: false,
      reason: `original-disclosure=${input.originalDisclosure}-not-eligible-for-auto`,
    };
  }

  if (
    input.topKConfidence === undefined ||
    !Number.isFinite(input.topKConfidence)
  ) {
    return {
      effective: input.originalDisclosure,
      escalated: false,
      reason: "no-top-k-confidence",
    };
  }

  const threshold =
    Number.isFinite(input.threshold) &&
    input.threshold >= 0 &&
    input.threshold <= 1
      ? input.threshold
      : DEFAULT_DISCLOSURE_ESCALATION_THRESHOLD;

  if (input.topKConfidence < threshold) {
    return {
      effective: "section",
      escalated: true,
      reason: `top-k-confidence=${input.topKConfidence.toFixed(3)}<${threshold}`,
    };
  }

  return {
    effective: input.originalDisclosure,
    escalated: false,
    reason: `top-k-confidence=${input.topKConfidence.toFixed(3)}>=${threshold}`,
  };
}
