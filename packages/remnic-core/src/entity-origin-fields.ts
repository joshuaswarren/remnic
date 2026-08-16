import type { EntityStructuredSection } from "./types.js";

type OriginatedEntry = { text: string; origin?: string };
type SanitizedFacts = { facts: string[]; origins: Array<string | undefined> };

export type EntityOriginStructuredSection = EntityStructuredSection & {
  factOrigins?: Array<string | undefined>;
};

export function sanitizeOriginatedFacts(
  entries: readonly OriginatedEntry[],
  sanitize: (value: string) => string,
  compact: (value: string, maxLength: number) => string,
  deduplicate: boolean,
): SanitizedFacts {
  const result: SanitizedFacts = { facts: [], origins: [] };
  for (const entry of entries) {
    const clean = sanitize(entry.text);
    if (!clean) continue;
    const fact = compact(clean, 180);
    const index = deduplicate ? result.facts.indexOf(fact) : -1;
    if (index < 0) {
      result.facts.push(fact);
      result.origins.push(entry.origin);
    } else if (result.origins[index] !== entry.origin) {
      result.origins[index] = undefined;
    }
  }
  return result;
}

export function buildOriginStructuredSections(
  sections: readonly EntityStructuredSection[],
  recallFacts: (section: EntityStructuredSection) => string[],
  sanitize: (value: string) => string,
  compact: (value: string, maxLength: number) => string,
): EntityOriginStructuredSection[] {
  return sections
    .map((section) => {
      const entries = recallFacts(section).map((text) => ({
        text,
        origin: section.factOrigins?.[section.facts.indexOf(text)],
      }));
      const result = sanitizeOriginatedFacts(entries, sanitize, compact, false);
      return {
        key: section.key,
        title: section.title,
        facts: result.facts,
        ...(result.origins.some((origin) => origin !== undefined) ? { factOrigins: result.origins } : {}),
      };
    })
    .filter((section) => section.facts.length > 0);
}
