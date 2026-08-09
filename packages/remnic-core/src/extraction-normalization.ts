import { EXTRACTION_RESPONSE_PLACEHOLDERS } from "./extraction-prompt.js";
import { normalizeRecallTokens } from "./recall-tokenization.js";
import { sanitizeMemoryContent } from "./sanitize.js";
import type { ExtractedFact } from "./types.js";

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function containsExtractionPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return EXTRACTION_RESPONSE_PLACEHOLDERS[value.trim()] === true;
  if (Array.isArray(value)) return value.some(containsExtractionPlaceholder);
  return isPlainRecord(value) && Object.values(value).some(containsExtractionPlaceholder);
}

export function extractionText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 && !containsExtractionPlaceholder(text) ? text : undefined;
}

export function extractionAttributes(value: unknown): Record<string, string> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const attributes: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    const normalizedKey = extractionText(key);
    const normalizedValue = extractionText(candidate);
    if (normalizedKey !== undefined && normalizedValue !== undefined) {
      attributes[normalizedKey] = normalizedValue;
    }
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

const EXTRACTION_CUE_ANCHOR_TYPES = new Set(["entity", "file", "tool", "outcome", "constraint", "date"]);

export function extractionCueAnchors(value: unknown): NonNullable<ExtractedFact["cueAnchors"]> | undefined {
  if (!Array.isArray(value)) return undefined;
  const anchorsByIdentity = new Map<string, NonNullable<ExtractedFact["cueAnchors"]>[number]>();
  for (const candidate of value) {
    if (!isPlainRecord(candidate)) continue;
    const type = extractionText(candidate.type);
    const anchorValue = extractionText(candidate.value);
    const sanitizedAnchor = anchorValue === undefined ? undefined : sanitizeMemoryContent(anchorValue);
    const sanitizedAnchorValue = sanitizedAnchor?.clean === true ? sanitizedAnchor.text.trim() : undefined;
    if (
      type === undefined ||
      sanitizedAnchorValue === undefined ||
      sanitizedAnchorValue.length === 0 ||
      sanitizedAnchorValue.length > 120 ||
      !EXTRACTION_CUE_ANCHOR_TYPES.has(type)
    ) {
      continue;
    }
    const normalizedCue = normalizeRecallTokens(sanitizedAnchorValue).join(" ");
    if (normalizedCue.length === 0) continue;
    const identity = `${type}:${normalizedCue}`;
    const existing = anchorsByIdentity.get(identity);
    if (!existing || sanitizedAnchorValue.localeCompare(existing.value) < 0) {
      anchorsByIdentity.set(identity, {
        type: type as NonNullable<ExtractedFact["cueAnchors"]>[number]["type"],
        value: sanitizedAnchorValue,
      });
    }
  }
  const anchors = [...anchorsByIdentity.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 3)
    .map(([, anchor]) => anchor);
  return anchors.length > 0 ? anchors : undefined;
}
