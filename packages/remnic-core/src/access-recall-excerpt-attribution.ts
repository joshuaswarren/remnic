/**
 * access-recall-excerpt-attribution.ts — per-result raw excerpt attribution
 * (issue #3546). Pure helpers extracted from access-recall-surface.ts to
 * keep that file under its structural-ratchet ceiling.
 *
 * Every memory extracted since #1575 carries verbatim
 * `frontmatter.sources[].quote` spans — the same utterance text the LCM
 * archive stores — so an excerpt whose content contains a result's quote
 * is attributed to that result (earliest matching result wins). Excerpts
 * no result claims stay anchored to the first result: query-relevant
 * transcript context with no provenance match keeps the pre-#3546
 * placement, and no excerpt is silently dropped. Memories without
 * provenance quotes (legacy, or spans disabled) claim nothing; an empty
 * excerpt set attaches as `[]` to the first result exactly as before.
 */

import type { EngramAccessMemorySummary } from "./access-service.js";
import type { MemoryFile } from "./types.js";

/**
 * Minimum length for a provenance quote to attribute an excerpt. A very
 * short quote ("the", "it") substring-matches unrelated transcript text,
 * producing false attributions — such quotes are ignored and their
 * excerpts keep the first-result fallback. 24 chars is roughly a short
 * phrase; real extraction spans are sentences or longer.
 */
const MIN_ATTRIBUTION_QUOTE_CHARS = 24;

export function attributeRawExcerpts(
  memories: readonly MemoryFile[],
  excerpts: EngramAccessMemorySummary["rawExcerpts"] | undefined,
): Array<EngramAccessMemorySummary["rawExcerpts"] | undefined> {
  const attributed: Array<EngramAccessMemorySummary["rawExcerpts"] | undefined> =
    memories.map(() => undefined);
  if (!excerpts) return attributed;
  if (excerpts.length === 0 || memories.length === 0) {
    if (memories.length > 0) attributed[0] = excerpts;
    return attributed;
  }
  const claimed = new Set<number>();
  const claimedIndices: number[][] = memories.map(() => []);
  memories.forEach((memory, index) => {
    const quotes = (memory.frontmatter.sources ?? [])
      .map((source) => source.quote?.trim())
      .filter(
        (quote): quote is string =>
          quote !== undefined && quote.length >= MIN_ATTRIBUTION_QUOTE_CHARS,
      );
    if (quotes.length === 0) return;
    for (const [excerptIndex, excerpt] of excerpts.entries()) {
      if (claimed.has(excerptIndex)) continue;
      if (quotes.some((quote) => excerpt.content.includes(quote))) {
        claimed.add(excerptIndex);
        claimedIndices[index].push(excerptIndex);
      }
    }
  });
  for (const [index, indices] of claimedIndices.entries()) {
    if (index !== 0 && indices.length > 0) {
      attributed[index] = indices.map((excerptIndex) => excerpts[excerptIndex]);
    }
  }
  // First result: its own matches plus every unclaimed excerpt, restored
  // to transcript order.
  attributed[0] = excerpts.filter(
    (_, excerptIndex) => claimedIndices[0].includes(excerptIndex) || !claimed.has(excerptIndex),
  );
  return attributed;
}
