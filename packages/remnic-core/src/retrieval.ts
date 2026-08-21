import { clamp01 } from "./lifecycle.js";

export interface QueryExpansionOptions {
  maxQueries: number;
  minTokenLen: number;
}

export interface RuntimeRetrievalPolicy {
  recencyWeight?: number;
}

const DEFAULT_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "with",
]);

function tokenize(query: string, minTokenLen: number): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= minTokenLen)
    .filter((t) => !DEFAULT_STOPWORDS.has(t));
}

export function applyRuntimeRetrievalPolicy(
  base: { recencyWeight: number },
  runtime: RuntimeRetrievalPolicy | null,
): { recencyWeight: number } {
  const fromRuntime = runtime?.recencyWeight;
  if (typeof fromRuntime !== "number") {
    return { recencyWeight: clamp01(base.recencyWeight) };
  }
  return { recencyWeight: clamp01(fromRuntime) };
}

/**
 * Cheap, deterministic query expansion.
 * Produces additional queries biased toward the most salient tokens in the input.
 */
export function expandQuery(
  query: string,
  options: QueryExpansionOptions,
): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [query];

  const maxQueries = Math.max(1, Math.min(20, options.maxQueries));
  const tokens = tokenize(trimmed, options.minTokenLen);

  // Keep deterministic ordering: first-seen tokens win.
  const seen = new Set<string>();
  const uniqTokens: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    uniqTokens.push(t);
  }

  const expansions: string[] = [query];
  if (uniqTokens.length === 0) return expansions;

  const top = uniqTokens.slice(0, 6);

  const candidates = [
    top.slice(0, 3).join(" "),
    top.slice(0, 2).join(" "),
    top[0],
    top[1],
    top[2],
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (expansions.length >= maxQueries) break;
    if (c && !expansions.includes(c)) expansions.push(c);
  }

  return expansions.slice(0, maxQueries);
}
