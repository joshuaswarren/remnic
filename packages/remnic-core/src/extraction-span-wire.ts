/**
 * Extraction seam for span mode (issue #2333 leftover slice + #2952).
 *
 * Default off. Callers pass `enabled` to `applySpanMode`. The provider JSON
 * schema is mode-aware so off-mode structured output cannot advertise `span`.
 */

import { z } from "zod";
import type { ExtractionSpanConfig } from "./extraction-span-config.js";
import { parseSpanOffsets, type ParsedSpan } from "./extraction-span.js";
import { ExtractionProviderOutputSchema } from "./schemas.js";

export function applySpanMode(opts: {
  enabled?: boolean | 0 | 1;
  text: string;
  start: number;
  end: number;
}): ParsedSpan {
  return parseSpanOffsets(opts.text, { start: opts.start, end: opts.end }, opts.enabled);
}

// zod 4 ships toJSONSchema natively; zod-to-json-schema emits an empty
// document for v4 schemas, so the dependency is dropped here. `io: "input"`
// matches the old effectStrategy: "input" (advertise the input shape of
// transforms/preprocess to providers).
// SAFETY: z.toJSONSchema returns a JSON-Schema document — always an object at
// the root; the record shape is what omitFactSpan walks.
const EXTRACTION_PROVIDER_JSON_SCHEMA_WITH_SPAN = z.toJSONSchema(
  ExtractionProviderOutputSchema,
  { target: "draft-7", io: "input" },
) as Record<string, unknown>;
type FactItems = {
  properties?: Record<string, unknown>;
  required?: string[];
};

function omitFactSpan(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(schema) as {
    properties?: { facts?: { items?: FactItems } };
  };
  const items = clone.properties?.facts?.items;
  if (!items?.properties || !("span" in items.properties)) {
    throw new Error("extraction provider schema is missing facts.items.properties.span");
  }
  delete items.properties.span;
  if (Array.isArray(items.required)) {
    items.required = items.required.filter((key) => key !== "span");
  }
  return clone as Record<string, unknown>;
}

const EXTRACTION_PROVIDER_JSON_SCHEMA_WITHOUT_SPAN = omitFactSpan(
  EXTRACTION_PROVIDER_JSON_SCHEMA_WITH_SPAN,
);

/** Provider JSON schema: `span` is present in on/shadow, absent in off. */
export function extractionProviderJsonSchema(
  spanMode: ExtractionSpanConfig["spanMode"] = "off",
): Record<string, unknown> {
  return spanMode === "off"
    ? EXTRACTION_PROVIDER_JSON_SCHEMA_WITHOUT_SPAN
    : EXTRACTION_PROVIDER_JSON_SCHEMA_WITH_SPAN;
}
