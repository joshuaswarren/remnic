/**
 * Span-mode extraction config + fact span-ref types (issue #2333 Phase B,
 * bench-gated). Sibling module so config.ts and types.ts stay under their
 * structural ratchets (#1995); types.ts re-exports both.
 *
 * Default "off"; an unrecognized value is REJECTED, never defaulted
 * (checklist #39) — silently ignoring it would run an unbenched extraction
 * contract.
 */

import { z } from "zod";
import { parseExtractionLivenessConfig } from "./extraction-liveness.js";

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
const extractionSpanBlockSchema = z.object({ spanMode: z.unknown().optional() }).strict();

/** Span + liveness fields for parseConfig. One spread keeps config.ts at the ratchet. */
export function parseExtractionFields(cfg: Record<string, unknown>) {
  return {
    extraction: parseExtractionSpanConfig(cfg.extraction),
    extractionLiveness: parseExtractionLivenessConfig(cfg),
  };
}

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
  const parsed = extractionSpanBlockSchema.safeParse(block);
  if (!parsed.success) {
    const unknownKeys = parsed.error.issues.flatMap((issue) =>
      issue.code === "unrecognized_keys" ? issue.keys : []
    );
    throw new Error(
      `extraction has unknown propert${unknownKeys.length === 1 ? "y" : "ies"}: ${unknownKeys.join(", ")}. Allowed: "spanMode".`,
    );
  }
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
