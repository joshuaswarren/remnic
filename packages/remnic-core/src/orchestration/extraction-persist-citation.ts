import { ContentHashIndex } from "../index.js";
import { sanitizeMemoryContent } from "../sanitize.js";
import {
  attachCitation,
  type CitationContext,
  hasCitationForTemplate,
  stripCitationForTemplate,
} from "../source-attribution.js";

export function normalizeStoredHashSource(
  raw: string,
  citationEnabled: boolean,
  citationTemplate: string,
  citationHistory: readonly string[] = [],
): string {
  return ContentHashIndex.normalizeContent(
    sanitizeMemoryContent(
      citationEnabled && hasCitationForTemplate(raw, citationTemplate, citationHistory)
        ? stripCitationForTemplate(raw, citationTemplate, citationHistory)
        : raw,
    ).text,
  );
}

export function applyInlineCitation(
  content: string,
  citationEnabled: boolean,
  citationTemplate: string,
  citationContextBase: Omit<CitationContext, "ts">,
  citationHistory: readonly string[] = [],
): string {
  if (!citationEnabled) return content;
  if (typeof content !== "string" || content.length === 0) return content;
  const citationContext: CitationContext = {
    ...citationContextBase,
    ts: new Date().toISOString(),
  };
  return attachCitation(content, citationContext, citationTemplate, citationHistory);
}
