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
