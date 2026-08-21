import type { LedgerClaim, LedgerRetrievalCandidate, LedgerRetrievalOptions, LedgerStore } from "./types.js";
import { normalizeIsoTimestamp } from "./schema.js";

const DEFAULT_LIMIT = 8;
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
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
  "will",
  "with",
]);

export async function retrievePriorClaims(
  query: LedgerClaim,
  store: LedgerStore,
  options: LedgerRetrievalOptions = {}
): Promise<LedgerRetrievalCandidate[]> {
  const limit = normalizeLimit(options.limit);
  const referenceTimeMs = Date.parse(normalizeIsoTimestamp("retrieval.now", options.now ?? query.createdAt));
  const includeStatuses = options.includeStatuses ?? ["active", "snoozed"];
  const claims = (await store.listClaims({ statuses: includeStatuses }))
    .filter((claim) => claim.id !== query.id)
    .filter((claim) => isRetrievableAt(claim, referenceTimeMs));

  const semanticScores = options.semantic
    ? await collectSemanticScores(query, claims, limit, options)
    : new Map<string, number>();

  const candidates = claims
    .map((claim) => scoreCandidate(query, claim, semanticScores.get(claim.id), referenceTimeMs))
    .filter((candidate) => candidate.score > 0)
    .sort(compareCandidates);

  const sliced = candidates.slice(0, limit);
  if (!options.reranker) return sliced;

  const reranked = await options.reranker.rerank({ query, candidates: sliced, limit });
  return reranked.slice(0, limit);
}

function isRetrievableAt(claim: LedgerClaim, referenceTimeMs: number): boolean {
  if (claim.status !== "snoozed" || !claim.snoozedUntil) return true;
  return Date.parse(claim.snoozedUntil) <= referenceTimeMs;
}

function scoreCandidate(
  query: LedgerClaim,
  claim: LedgerClaim,
  semanticScore: number | undefined,
  referenceTimeMs: number
): LedgerRetrievalCandidate {
  let score = 0;
  let hasTopicalMatch = false;
  const reasons: string[] = [];

  const lexical = jaccard(tokenize(query.statement), tokenize(claim.statement));
  if (lexical > 0) {
    hasTopicalMatch = true;
    const lexicalScore = lexical * 4;
    score += lexicalScore;
    reasons.push(`lexical:${round(lexicalScore)}`);
  }

  const entityOverlap = overlap(query.scope.entities.map(normalizeText), claim.scope.entities.map(normalizeText));
  if (entityOverlap > 0) {
    hasTopicalMatch = true;
    const entityScore = entityOverlap * 3;
    score += entityScore;
    reasons.push(`entity:${entityOverlap}`);
  }

  if (
    query.scope.domain &&
    claim.scope.domain &&
    normalizeText(query.scope.domain) === normalizeText(claim.scope.domain)
  ) {
    hasTopicalMatch = true;
    score += 2;
    reasons.push("domain");
  }

  if (query.stance !== claim.stance && query.stance !== "uncertain" && claim.stance !== "uncertain") {
    score += 1;
    reasons.push("stance-diff");
  }

  const recency = recencyScore(claim.updatedAt, referenceTimeMs);
  if (recency > 0) {
    score += recency;
    reasons.push(`recency:${round(recency)}`);
  }

  if (semanticScore !== undefined) {
    const semantic = Math.max(0, Math.min(1, semanticScore)) * 5;
    if (semantic > 0) hasTopicalMatch = true;
    score += semantic;
    reasons.push(`semantic:${round(semantic)}`);
  }

  return { claim, score: hasTopicalMatch ? round(score) : 0, reasons };
}

function compareCandidates(a: LedgerRetrievalCandidate, b: LedgerRetrievalCandidate): number {
  const scoreOrder = b.score - a.score;
  if (scoreOrder !== 0) return scoreOrder;
  const updatedOrder = Date.parse(b.claim.updatedAt) - Date.parse(a.claim.updatedAt);
  if (updatedOrder !== 0) return updatedOrder;
  return a.claim.id.localeCompare(b.claim.id);
}

async function collectSemanticScores(
  query: LedgerClaim,
  candidates: LedgerClaim[],
  limit: number,
  options: LedgerRetrievalOptions
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!options.semantic || candidates.length === 0) return result;
  const scored = await options.semantic.scoreClaims({ query, candidates, limit });
  for (const item of scored) {
    if (!item.claimId.trim()) continue;
    if (!Number.isFinite(item.score)) continue;
    result.set(item.claimId, Math.max(0, Math.min(1, item.score)));
  }
  return result;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error(`retrieval limit must be an integer in [1, 100], got ${String(value)}`);
  }
  return value;
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2)
    .filter((token) => !STOPWORDS.has(token));
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function jaccard(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection += 1;
  }
  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function overlap(left: string[], right: string[]): number {
  const rightSet = new Set(right.filter(Boolean));
  let count = 0;
  for (const item of new Set(left.filter(Boolean))) {
    if (rightSet.has(item)) count += 1;
  }
  return count;
}

function recencyScore(updatedAt: string, referenceTimeMs: number): number {
  const ageMs = referenceTimeMs - Date.parse(updatedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0;
  const ageDays = ageMs / (24 * 60 * 60 * 1_000);
  if (ageDays > 365) return 0;
  return (365 - ageDays) / 365;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
