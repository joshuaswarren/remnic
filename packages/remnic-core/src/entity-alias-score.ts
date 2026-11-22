import { normalizeEntityText } from "./entity-schema.js";
import { containsPhrase } from "./entity-retrieval-boundaries.js";

export function tokenize(value: string): string[] {
  return normalizeEntityText(value).split(/\s+/).filter((token) => token.length >= 2);
}

export interface AliasQuery {
  normalized: string;
  tokens: Set<string>;
}

export function prepareAliasQuery(query: string): AliasQuery {
  const normalized = normalizeEntityText(query);
  return { normalized, tokens: new Set(tokenize(normalized)) };
}

export function scoreAliasMatch(query: AliasQuery, alias: string): number {
  const normalizedAlias = normalizeEntityText(alias);
  if (!normalizedAlias) return 0;
  if (query.normalized === normalizedAlias) return 10;
  if (containsPhrase(query.normalized, normalizedAlias)) return 8 + Math.min(normalizedAlias.split(/\s+/).length, 3);
  const aliasTokens = tokenize(normalizedAlias);
  if (aliasTokens.length === 0) return 0;
  const overlap = aliasTokens.filter((token) => query.tokens.has(token)).length;
  if (overlap === 0) return 0;
  // aliases, partial-token overlap that hits ONLY shared common tokens
  // (like "person" in "Person-A1" / "Person-B1") would surface every
  // similarly-prefixed entity for a query that named only one. Require
  // that the overlap include at least one DISTINCTIVE alias token —
  // i.e. a token that does not also appear in any other entity's
  // alias-token vocabulary. Since this function is pure / per-pair, we
  // approximate "distinctive" by requiring the overlap to include at
  // least one token that is not a substring-of common identifier
  // affixes. The aliasTokens with length > 1 must contribute at least
  // one non-affix overlap. "Alice Example" (["alice", "example"])
  // matched by query "Tell me about Alice" → overlap = 1 on "alice",
  // and "alice" is not an affix → score = 1. "Person-A1" tokens
  // ["person", "a1"] matched by query "Who is Person-B1?" → overlap =
  // 1 on "person", and "person" IS an affix → score = 0.
  if (aliasTokens.length > 1) {
    const nonAffixOverlap = aliasTokens.filter(
      (token) => query.tokens.has(token) && !isAliasAffixToken(token),
    ).length;
    if (nonAffixOverlap === 0) return 0;
  }
  return overlap;
}

/**
 * Tokens that look like type prefixes / generic role identifiers and
 * therefore should not, on their own, count as evidence that a
 * multi-token alias matches a query (#682 PR 2/3 R-2).
 *
 * Kept as a small explicit list rather than a regex so additions are
 * deliberate. The list mirrors the entity types listed in
 * `entity-schema.ts` plus the most common generic role identifiers
 * that frequently appear as the leading token of a display name.
 */
const ALIAS_AFFIX_TOKENS = new Set<string>([
  "person", "people", "user", "users", "team", "teams",
  "project", "projects", "topic", "topics",
  "org", "orgs", "organization", "organizations", "company", "companies",
  "place", "places", "tool", "tools", "service", "services",
  "system", "systems", "agent", "agents", "bot", "bots",
]);

function isAliasAffixToken(token: string): boolean {
  return ALIAS_AFFIX_TOKENS.has(token);
}
