/**
 * Bounded JSONL state configuration (issue #1910).
 *
 * Extracted from `config.ts`/`types.ts` so the god-file line-count ratchets
 * (issue #1995) do not grow: `PluginConfig` extends the interface below and
 * `parseConfig` spreads `parseBoundedJsonlStateConfig`. No behavior change —
 * the knobs, defaults, and coercion rules are identical to the inline forms.
 */

/** Knobs that bound the unbounded JSONL state files (issue #1910). */
export interface BoundedJsonlStateConfig {
  /**
   * Auto-compact `state/memory-lifecycle-ledger.jsonl` when it exceeds this many
   * bytes, triggered off the debounced maintenance path. `0` disables. Default
   * 64MB.
   */
  memoryLifecycleLedgerCompactBytes: number;
  /**
   * Minimum interval between auto-compactions of the lifecycle ledger, so a
   * heavy rebuild cannot run back-to-back. Floored at 60s. Default 6h.
   */
  memoryLifecycleLedgerCompactMinIntervalMs: number;
  /**
   * Rotate `state/recall_impressions.jsonl` to `.1..N` when it exceeds this many
   * bytes. `0` disables. Default 32MB.
   */
  recallImpressionsRotateBytes: number;
  /**
   * Number of rotated recall-impression archives to keep (`.1 .. .N`). Floored
   * at 1 when rotation is enabled. Default 5.
   */
  recallImpressionsRotateKeep: number;
}

/** Integer coercion contract shared with `config.ts` (`parseIntegerAtLeast`). */
type IntegerParser = (value: unknown, fallback: number, min: number, keyName: string) => number;

/**
 * Parse the bounded-state knobs. Numeric knobs accept CLI/overlay string forms
 * (Gotcha #28) via `coerceNumber`, then require an integer >= min. A
 * present-but-malformed or fractional value is REJECTED (throws) rather than
 * silently taking the default; only an absent value falls back. `0` survives
 * when `min` is 0, so the documented disable stays effective on every surface
 * (byte thresholds floor at 0, the min-interval at 60s, and the keep count at 1
 * so rotation always retains at least one archive).
 */
export function parseBoundedJsonlStateConfig(
  cfg: Record<string, unknown>,
  parseIntegerAtLeast: IntegerParser,
): BoundedJsonlStateConfig {
  return {
    memoryLifecycleLedgerCompactBytes: parseIntegerAtLeast(
      cfg.memoryLifecycleLedgerCompactBytes,
      64 * 1024 * 1024,
      0,
      "memoryLifecycleLedgerCompactBytes",
    ),
    memoryLifecycleLedgerCompactMinIntervalMs: parseIntegerAtLeast(
      cfg.memoryLifecycleLedgerCompactMinIntervalMs,
      6 * 60 * 60 * 1000,
      60_000,
      "memoryLifecycleLedgerCompactMinIntervalMs",
    ),
    recallImpressionsRotateBytes: parseIntegerAtLeast(
      cfg.recallImpressionsRotateBytes,
      32 * 1024 * 1024,
      0,
      "recallImpressionsRotateBytes",
    ),
    recallImpressionsRotateKeep: parseIntegerAtLeast(
      cfg.recallImpressionsRotateKeep,
      5,
      1,
      "recallImpressionsRotateKeep",
    ),
  };
}
