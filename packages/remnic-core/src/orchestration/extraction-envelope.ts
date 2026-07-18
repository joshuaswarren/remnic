import {
  composeMemoryEnvelope,
  TAG_LIMITS,
  type MemoryWriteInput,
  type SealedMemoryEnvelope,
  type WriteContext,
} from "../write-envelope.js";
import { normalizeTags } from "../recall-tag-filter.js";
import { log } from "../logger.js";

/**
 * Envelope helpers for the extraction persistence pipeline (issue #1989 PR2).
 *
 * Extraction input is MACHINE-GENERATED: one malformed LLM field must never
 * abort a whole persistence batch that legacy `writeMemory` would have
 * accepted. Every extraction-side compose therefore runs in salvage mode,
 * and every drop is warn-logged (rule 34 — visible, never silent).
 */

/**
 * Compose an extraction-side envelope in salvage mode and warn-log any
 * salvage notes. The single compose wrapper for all extraction-persist
 * write sites, so note logging cannot be forgotten at a new site.
 */
export function composeSalvagedExtractionEnvelope(
  input: MemoryWriteInput,
  ctx: WriteContext,
): SealedMemoryEnvelope {
  const envelope = composeMemoryEnvelope(input, ctx, { salvage: true });
  if (envelope.salvageNotes.length > 0) {
    log.warn(`extraction write salvaged invalid fields: ${envelope.salvageNotes.join("; ")}`);
  }
  return envelope;
}

/**
 * System marker tags ("shared-promotion", "<target>-promotion", "chunked")
 * must survive the tag cap — the CLI and stats identify chunked parents and
 * promotions through them (#2014/#2017 review round). Normalize the source
 * tags first (same trim/dedupe salvage would apply), reserve one slot for
 * the marker, and warn when source tags are dropped to make room.
 */
export function withReservedMarkerTag(sourceTags: string[], marker: string): string[] {
  // Drop overlong tags BEFORE budgeting (round 3): normalizeTags only
  // trims/dedupes, so a >256-char tag would consume a budget slot here and
  // then be salvage-dropped at compose time — squeezing out a valid later
  // tag for nothing.
  const usable = sourceTags.filter(
    (tag) => typeof tag !== "string" || tag.trim().length <= TAG_LIMITS.maxTagLength,
  );
  const normalized = normalizeTags(usable) ?? [];
  const budget = TAG_LIMITS.maxTags - 1;
  if (normalized.length > budget) {
    log.warn(
      `extraction tags exceed ${budget}+marker cap; keeping the first ${budget} of ${normalized.length} and the ${JSON.stringify(marker)} marker`,
    );
  }
  const capped = normalized.length > budget ? normalized.slice(0, budget) : normalized;
  return [...capped, marker];
}

/**
 * Pure salvage-compose probe: reproduce the SURVIVING entityRef and raw
 * attribute pairs a salvage write of these fields would persist
 * (deterministic, side-effect-free). Returns null when strict envelope
 * preconditions reject (such input never reached a salvage write either) —
 * callers fail open to their raw fields.
 */
export function probeSalvageSurvivingFields(input: {
  content: string;
  category: MemoryWriteInput["category"];
  structuredAttributes?: Record<string, string>;
  entityRef?: string;
}): { entityRef?: string; structuredAttributes?: Record<string, string> } | null {
  try {
    const probe = composeSalvagedExtractionEnvelope(
      {
        content: input.content,
        category: input.category,
        structuredAttributes: input.structuredAttributes,
        entityRef: input.entityRef,
      },
      { source: "bitemporal-backfill-probe" },
    );
    return {
      entityRef: probe.entityRef,
      structuredAttributes: probe.rawStructuredAttributes
        ? { ...probe.rawStructuredAttributes }
        : undefined,
    };
  } catch {
    return null;
  }
}
