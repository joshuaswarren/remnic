/** Config keys parsed only so existing configs keep loading; each warns when set. */
import { log } from "./logger.js";

const DEFAULT_CAUSAL_IMPACT_WEIGHT = 0.05;

/** Lifecycle scoring never had a causal impact signal, so this weight was never read (#3667). */
export function warnDeprecatedCausalImpactWeight(weight: number | undefined): number {
  if (weight === undefined) return DEFAULT_CAUSAL_IMPACT_WEIGHT;
  log.warn(
    "cmcLifecycleCausalImpactWeight is deprecated and has no effect: lifecycle scoring has no causal impact signal (#3667). " +
      "Remove it from your config.",
  );
  return weight;
}
