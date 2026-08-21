/**
 * Recall concurrency config parsing (issue #1906), extracted from config.ts to
 * keep that grandfathered file within its structural-ratchet ceiling (#1520/#1995).
 * The parsed fields still live on {@link PluginConfig}; this only relocates the
 * coercion/validation logic.
 */
import { coerceBool, coerceNumber } from "./connectors/coerce.js";
import type { PluginConfig } from "./types.js";

/**
 * Parse the per-principal recall concurrency knobs from raw config.
 *
 * `recallMaxConcurrentPerPrincipal` accepts only finite integers >= 0 so `0`
 * means "unlimited" deliberately. A fractional typo like `0.5` must NOT floor to
 * `0` (which would silently disable the cap); it falls back to the default 4
 * (AGENTS.md #1/#17).
 */
export function parseRecallConcurrencyConfig(
  cfg: Record<string, unknown>,
): Pick<PluginConfig, "recallMaxConcurrentPerPrincipal" | "recallSingleFlightEnabled"> {
  return {
    recallMaxConcurrentPerPrincipal: (() => {
      const n = coerceNumber(cfg.recallMaxConcurrentPerPrincipal);
      return n !== undefined && Number.isInteger(n) && n >= 0 ? n : 4;
    })(),
    recallSingleFlightEnabled: coerceBool(cfg.recallSingleFlightEnabled) ?? true,
  };
}
