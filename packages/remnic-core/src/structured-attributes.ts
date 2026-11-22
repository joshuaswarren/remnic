
import { sanitizeMemoryContent } from "./sanitize.js";

/**
 * Remove the `[Attributes: …]` suffix `writeMemory` appends to the stored
 * body when structuredAttributes are present, yielding the raw fact/card text
 * for content comparison or client display. Inverse companion of
 * `normalizeAttributePairs` enrichment in `storage.ts`.
 *
 * Returns the stripped (trimmed) body when the marker opens the final
 * non-empty line and its inner payload contains no premature `]` or newline
 * (mirrors the exact shape `normalizeAttributePairs` emits). Otherwise
 * returns the trimmed input unchanged — never truncates legitimate content.
 */
export function stripAttributesSuffix(content: string): string {
  const trimmed = content.trimEnd();
  if (!trimmed.endsWith("]")) return content.trim();
  const marker = "\n[Attributes: ";
  const markerIndex = trimmed.lastIndexOf(marker);
  if (markerIndex === -1) return content.trim();
  const inner = trimmed.slice(markerIndex + marker.length, -1);
  if (inner.includes("]") || inner.includes("\n")) return content.trim();
  return trimmed.slice(0, markerIndex).trim();
}

/** Return stored-body identity forms, from raw semantic content to full body. */
export function storedContentIdentityCandidates(
  content: string,
  stripCitation: (value: string) => string,
): string[] {
  const fullBody = content.trim();
  const bodyWithoutAttributes = stripAttributesSuffix(fullBody);
  const rawBody = stripCitation(bodyWithoutAttributes);
  return [...new Set([rawBody, bodyWithoutAttributes, fullBody])];
}
// ---------------------------------------------------------------------------
//

/**
 * Canonical `key: value; …` rendering of structured attributes. Keys are
 * trimmed + lowercased, values trimmed, pairs sorted by normalized key.
 * Moved verbatim from `storage.ts` (which re-exports it for API stability);
 * used at the write path, the dedup-lookup path, and envelope assembly.
 */
export function normalizeAttributePairs(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([k, v]) => [k.trim().toLowerCase(), v.trim()] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
}

export interface AssembledPersistBody {
  /** The exact body persistence writes: enriched then sanitized. */
  text: string;
  /** False when sanitization redacted injection-bearing text. */
  clean: boolean;
  /** Matched injection pattern sources (for the storage warn log). */
  violations: string[];
}

export function assemblePersistedBody(
  content: string,
  structuredAttributes?: Record<string, string>,
): AssembledPersistBody {
  let enriched = content;
  if (structuredAttributes && Object.keys(structuredAttributes).length > 0) {
    enriched = `${content}\n[Attributes: ${normalizeAttributePairs(structuredAttributes)}]`;
  }
  const sanitized = sanitizeMemoryContent(enriched);
  return { text: sanitized.text, clean: sanitized.clean, violations: sanitized.violations };
}
