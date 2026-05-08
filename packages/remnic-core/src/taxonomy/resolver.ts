/**
 * Resolver decision tree for the MECE taxonomy.
 *
 * Given extracted content and its MemoryCategory, determines which
 * taxonomy category the knowledge should be filed under.
 */

import type { MemoryCategory } from "../types.js";
import type { ResolverDecision, Taxonomy, TaxonomyCategory } from "./types.js";

const DEFAULT_CATEGORY_ID = "facts";

/**
 * Resolve a piece of content to a taxonomy category.
 *
 * Algorithm:
 * 1. Find all taxonomy categories whose `memoryCategories` include
 *    the given `memoryCategory`.
 * 2. If exactly one match, return it with confidence 1.0.
 * 3. If multiple matches, prefer the strongest exact-token keyword
 *    overlap from filing rules. Use priority only as a tie-breaker.
 *    If no filing rules match, choose the explicit/default fallback
 *    category instead of letting low-priority generic terms win.
 * 4. If no match, fall back to the "facts" category (or first
 *    category if "facts" is absent) with low confidence.
 * 5. Always populate `alternatives` with other plausible categories.
 */
export function resolveCategory(
  content: string,
  memoryCategory: MemoryCategory,
  taxonomy: Taxonomy,
): ResolverDecision {
  const contentTokens = tokenizeKeywordText(content);

  // Step 1: find matching categories
  const matches = taxonomy.categories.filter((cat) =>
    cat.memoryCategories.includes(memoryCategory),
  );

  if (matches.length === 0) {
    // No taxonomy category accepts this MemoryCategory — fall back
    const fallback =
      taxonomy.categories.find((c) => c.id === DEFAULT_CATEGORY_ID) ??
      taxonomy.categories[0];
    if (!fallback) {
      return {
        categoryId: DEFAULT_CATEGORY_ID,
        confidence: 0,
        reason: "Taxonomy is empty; using default category",
        alternatives: [],
      };
    }
    const alternatives = taxonomy.categories
      .filter((c) => c.id !== fallback.id)
      .map((c) => ({
        categoryId: c.id,
        reason: c.description,
      }));
    return {
      categoryId: fallback.id,
      confidence: 0.3,
      reason: `No taxonomy category maps to MemoryCategory "${memoryCategory}"; falling back to "${fallback.name}"`,
      alternatives,
    };
  }

  if (matches.length === 1) {
    const match = matches[0]!;
    const alternatives = taxonomy.categories
      .filter((c) => c.id !== match.id)
      .map((c) => ({
        categoryId: c.id,
        reason: c.description,
      }));
    return {
      categoryId: match.id,
      confidence: 1.0,
      reason: `Unique match: MemoryCategory "${memoryCategory}" maps to "${match.name}"`,
      alternatives,
    };
  }

  // Multiple matches — use filing rule keyword heuristics + priority
  const scored = matches.map((cat) => ({
    cat,
    keywordScore: computeKeywordScoreForTokens(contentTokens, cat),
  }));

  // Sort by keyword score descending, then priority ascending (lower wins)
  scored.sort((a, b) => {
    if (b.keywordScore !== a.keywordScore) return b.keywordScore - a.keywordScore;
    return a.cat.priority - b.cat.priority;
  });

  const topScored = scored[0]!;
  const best = topScored.keywordScore > 0
    ? topScored
    : {
        cat: selectFallbackCategory(matches) ?? topScored.cat,
        keywordScore: 0,
      };
  const runnerUp = scored[1];

  // Confidence is higher when keyword match clearly differentiates
  const confidence =
    best.keywordScore > 0 && (!runnerUp || best.keywordScore > runnerUp.keywordScore)
      ? 0.9
      : 0.7;

  const alternatives = taxonomy.categories
    .filter((c) => c.id !== best.cat.id)
    .map((c) => ({
      categoryId: c.id,
      reason: c.description,
    }));

  const reason =
    best.keywordScore > 0
      ? `Filing rules for "${best.cat.name}" matched content keywords (priority ${best.cat.priority})`
      : `No filing rules matched content keywords; using fallback category "${best.cat.name}"`;

  return {
    categoryId: best.cat.id,
    confidence,
    reason,
    alternatives,
  };
}

/**
 * Compute a simple keyword overlap score between content and
 * a category's filing rules + description.
 */
function computeKeywordScoreForTokens(contentTokens: Set<string>, cat: TaxonomyCategory): number {
  let score = 0;
  const ruleText = [...cat.filingRules, cat.description]
    .join(" ")
    .toLowerCase();

  const keywords = tokenizeKeywordText(ruleText);

  for (const kw of keywords) {
    if (contentTokens.has(kw)) {
      score += 1;
    }
  }
  return score;
}

function tokenizeKeywordText(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((word) => word.trim())
      .filter((word) => word.length >= 3 && !TAXONOMY_KEYWORD_STOPWORDS.has(word)),
  );
}

function selectFallbackCategory(
  categories: readonly TaxonomyCategory[],
): TaxonomyCategory | undefined {
  return categories.find((cat) => cat.id === DEFAULT_CATEGORY_ID) ??
    categories.find((cat) => {
      const text = `${cat.id} ${cat.name} ${cat.description} ${cat.filingRules.join(" ")}`.toLowerCase();
      return /\b(general|fallback)\b/.test(text);
    });
}

const TAXONOMY_KEYWORD_STOPWORDS = new Set([
  "about",
  "all",
  "and",
  "are",
  "for",
  "from",
  "has",
  "into",
  "not",
  "the",
  "this",
  "was",
  "with",
]);
