/**
 * Span-mode extraction config + fact span-ref types (issue #2333 Phase B,
 * bench-gated). Sibling module so config.ts and types.ts stay under their
 * structural ratchets (#1995); types.ts re-exports both.
 *
 * Default "off"; an unrecognized value is REJECTED, never defaulted
 * (checklist #39) — silently ignoring it would run an unbenched extraction
 * contract.
 */

export interface ExtractionSpanConfig {
  /**
   * - "off" (default): extraction generates content as before.
   * - "shadow": request spans AND content; materialize + compare + log
   *   agreement telemetry; persist the generated content (zero behavior
   *   change).
   * - "on": persist materialized frame+span content, falling back per fact
   *   to generated content when the span fails validation.
   */
  spanMode: "off" | "shadow" | "on";
}

export interface ExtractedFactSpanRef {
  /** Ordinal of the source turn in the extraction segment (0-based). */
  sourceMessageIndex: number;
  /** [charStart, charEnd) into the turn's exact in-memory text (UTF-16 code units). */
  charStart: number;
  charEnd: number;
  /** ≤ 15 generated words making the span self-contained (resolves deixis). */
  frame: string;
  /** Optional prompt-source identity; when present it must match the captured stamp. */
  sourceHash?: string;
  sourceLength?: number;
}

export const EXTRACTION_SPAN_MODES = ["off", "shadow", "on"] as const;

export function parseExtractionSpanConfig(raw: unknown): ExtractionSpanConfig {
  if (raw === undefined) {
    return { spanMode: "off" };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `extraction must be an object with optional spanMode (got ${JSON.stringify(raw)}). Omit the key for the default "off".`,
    );
  }
  const block = raw as Record<string, unknown>;
  const spanMode = block.spanMode;
  if (spanMode === undefined) {
    return { spanMode: "off" };
  }
  for (const mode of EXTRACTION_SPAN_MODES) {
    if (spanMode === mode) {
      return { spanMode: mode };
    }
  }
  throw new Error(
    `extraction.spanMode must be one of "off", "shadow", "on" (got ${JSON.stringify(spanMode)}). Omit the key for the default "off".`,
  );
}
