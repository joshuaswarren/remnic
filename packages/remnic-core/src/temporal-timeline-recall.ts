import { renderAuthorityBoundContent } from "./recall-context-composition.js";
import type { MemoryFile } from "./types.js";

export interface TemporalTimelineRecallItem {
  memory: MemoryFile;
  eventAt: string;
  observedAt?: string;
  sessionKey?: string;
  validUntil?: string;
}

export interface TemporalTimelineRecallOptions {
  items: readonly TemporalTimelineRecallItem[];
  query: string;
  maxChars: number;
  maxItems: number;
  title?: string;
  originAuthorityEnabled?: boolean;
  untrustedOrigins?: readonly string[];
}

const QUERY_STOPWORDS = new Set([
  "a", "an", "and", "did", "do", "first", "happened", "how", "i", "in",
  "is", "it", "last", "many", "most", "my", "of", "on", "or", "recent",
  "recently", "the", "to", "was", "what", "when", "which", "who", "with",
]);

function queryTerms(query: string): string[] {
  return [...new Set(
    query
      .toLowerCase()
      .match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu)
      ?.filter((term) => term.length > 1 && !QUERY_STOPWORDS.has(term)) ?? [],
  )];
}

function relevanceScore(item: TemporalTimelineRecallItem, terms: readonly string[]): number {
  if (terms.length === 0) return 1;
  const haystack = `${item.memory.content} ${(item.memory.frontmatter.tags ?? []).join(" ")} ${item.memory.frontmatter.entityRef ?? ""}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

function compareChronology(
  left: TemporalTimelineRecallItem,
  right: TemporalTimelineRecallItem,
): number {
  const eventOrder = left.eventAt.localeCompare(right.eventAt);
  if (eventOrder !== 0) return eventOrder;
  const observedOrder = (left.observedAt ?? "").localeCompare(right.observedAt ?? "");
  if (observedOrder !== 0) return observedOrder;
  return left.memory.frontmatter.id.localeCompare(right.memory.frontmatter.id);
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Build a query-focused timeline from ingest-indexed memory primitives.
 * Selection is relevance-first; presentation is always event-time ordered.
 */
export function buildTemporalTimelineRecallSection(
  options: TemporalTimelineRecallOptions,
): string {
  const maxChars = Number.isFinite(options.maxChars) ? Math.floor(options.maxChars) : 0;
  const maxItems = Number.isFinite(options.maxItems) ? Math.floor(options.maxItems) : 0;
  if (maxChars <= 0 || maxItems <= 0 || options.items.length === 0) return "";

  const terms = queryTerms(options.query);
  const uniqueById = new Map<string, TemporalTimelineRecallItem>();
  for (const item of options.items) {
    const id = item.memory.frontmatter.id;
    const current = uniqueById.get(id);
    if (!current || compareChronology(item, current) < 0) uniqueById.set(id, item);
  }

  const scored = [...uniqueById.values()].map((item) => ({
    item,
    score: relevanceScore(item, terms),
  }));
  const relevant = scored.some(({ score }) => score > 0)
    ? scored.filter(({ score }) => score > 0)
    : scored;
  const selected = relevant
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return compareChronology(left.item, right.item);
    })
    .slice(0, maxItems)
    .map(({ item }) => item)
    .sort(compareChronology);

  const title = options.title ?? "Cross-session temporal timeline";
  const lines = [
    `## ${title}`,
    "Ordered by event time across source sessions; event time is distinct from ingest time.",
  ];
  for (const item of selected) {
    const provenance = [
      `event=${item.eventAt}`,
      item.validUntil ? `until<${item.validUntil}` : "",
      item.observedAt ? `observed=${item.observedAt}` : "",
      item.sessionKey ? `session=${item.sessionKey}` : "",
    ].filter(Boolean).join(", ");
    const content = renderAuthorityBoundContent(
      item.memory.content.trim(),
      item.memory.frontmatter.origin,
      {
        enabled: options.originAuthorityEnabled === true,
        untrustedOrigins: options.untrustedOrigins ?? [],
      },
    );
    lines.push(`- [${provenance}] ${content}`);
  }
  return clip(lines.join("\n"), maxChars);
}
