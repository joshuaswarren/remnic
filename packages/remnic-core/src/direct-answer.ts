/**
 * Direct-answer retrieval tier eligibility (issue #518 slice 2).
 *
 * This module is a pure decision layer.  It takes a query, a set of
 * caller-resolved candidates (each already decorated with trust-zone,
 * taxonomy-bucket, and importance information), and the direct-answer
 * config, then returns an eligibility verdict.
 *
 * Keeping the module pure means:
 *
 * - Tests do not need a trust-zones store, taxonomy resolver, or importance
 *   scorer on disk.
 * - Slice 3 (retrieval.ts wiring) is responsible for resolving those signals
 *   before calling in; the wiring layer decides where candidates come from
 *   (entity index, token prefilter, etc.).  This module only decides
 *   whether the surfaced candidates add up to a confident direct answer.
 *
 * Not wired into retrieval yet — see slice 3.
 */

import {
  isUnsegmentableRecallChar as isUnsegmentableRecallCodepoint,
  normalizeRecallTokenSet,
  normalizeRecallTokens,
} from "./recall-tokenization.js";
import type { TrustZoneName } from "./trust-zones.js";
import type { MemoryFile, MemoryStatus } from "./types.js";

/**
 * Caller-supplied candidate.
 *
 * `trustZone`, `taxonomyBucket`, and `importanceScore` are resolved outside
 * this module because each comes from a different subsystem.  Passing them
 * as inputs keeps the function deterministic and easy to unit-test.
 *
 * `matchScore` is optional; if omitted, candidates are ranked by
 * token-overlap ratio.  Callers that already computed a better ranking
 * score (e.g. BM25, vector similarity) can supply it to drive the
 * ambiguity check.
 */
export interface DirectAnswerCandidate {
  memory: MemoryFile;
  trustZone: TrustZoneName | null;
  taxonomyBucket: string | null;
  importanceScore: number;
  matchScore?: number;
}

export interface DirectAnswerConfig {
  enabled: boolean;
  tokenOverlapFloor: number;
  importanceFloor: number;
  ambiguityMargin: number;
  eligibleTaxonomyBuckets: string[];
}

export interface DirectAnswerInput {
  query: string;
  candidates: DirectAnswerCandidate[];
  config: DirectAnswerConfig;
  /**
   * Optional entity-ref hints resolved from the query upstream.  When
   * supplied, a candidate with a set `entityRef` must match one of these
   * (case-insensitive) to remain eligible.  Candidates without an
   * `entityRef` are allowed through regardless.
   */
  queryEntityRefs?: string[];
}

export type DirectAnswerReason =
  | "disabled"
  | "empty-query"
  | "no-candidates"
  | "no-eligible-candidates"
  | "below-token-overlap-floor"
  | "ambiguous"
  | "eligible";

export interface DirectAnswerResult {
  eligible: boolean;
  reason: DirectAnswerReason;
  /** Winning candidate when eligible. */
  winner?: DirectAnswerCandidate;
  /** Computed token-overlap ratio (0..1) of the winner. */
  tokenOverlap?: number;
  /**
   * Human-readable summary suitable for
   * `RecallTierExplain.tierReason`.
   */
  narrative: string;
  /**
   * Filter labels that eliminated at least one candidate along the way.
   * Populated regardless of eligibility so the caller can surface the
   * narrowing steps in `RecallTierExplain.filteredBy`.
   */
  filteredBy: string[];
}

/** Filter labels — exported so callers and tests can match them structurally. */
export const FILTER_LABELS = {
  nonActiveStatus: "non-active-status",
  notTrustedZone: "not-trusted-zone",
  ineligibleTaxonomyBucket: "ineligible-taxonomy-bucket",
  belowImportanceFloor: "below-importance-floor",
  entityRefMismatch: "entity-ref-mismatch",
  belowTokenOverlapFloor: "below-token-overlap-floor",
} as const;

const PROMPT_RECALL_WORDS = new Set([
  "what",
  "who",
  "where",
  "when",
  "why",
  "how",
  "is",
  "are",
  "was",
  "were",
  "do",
  "does",
  "did",
  "find",
  "get",
  "show",
  "search",
  "lookup",
  "recall",
  "remember",
  "list",
  "status",
  "include",
  "tell",
  "me",
  "give",
  "about",
  "please",
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "that",
  "this",
  "найди",
  "найти",
  "поиск",
  "покажи",
  "статус",
  "включи",
]);

interface ScoredCandidate {
  candidate: DirectAnswerCandidate;
  tokenOverlap: number;
  requiredTokenMismatch: boolean;
}

function hasUnsegmentableRecallChar(token: string): boolean {
  return [...token].some((ch) => isUnsegmentableRecallCodepoint(ch));
}

function requiredCjkPhraseTokens(query: string): string[] {
  const phrases = new Set<string>();
  let segment = "";

  const addPhrase = (phrase: string) => {
    if ([...phrase].length >= 4) {
      phrases.add(phrase);
    }
  };

  const flushSegment = () => {
    let buffered = "";
    for (const run of segment.split(/\s+/)) {
      if (!run) continue;
      if ([...run].length >= 4) {
        addPhrase(buffered);
        buffered = "";
        addPhrase(run);
        continue;
      }
      buffered += run;
    }
    addPhrase(buffered);
    segment = "";
  };

  for (const ch of query.toLowerCase().normalize("NFC")) {
    if (hasUnsegmentableRecallChar(ch)) {
      segment += ch;
      continue;
    }
    if (/\p{M}/u.test(ch) && segment.length > 0 && !/\s$/u.test(segment)) {
      segment += ch;
      continue;
    }
    if (/\s/u.test(ch)) {
      segment += " ";
      continue;
    }
    flushSegment();
  }
  flushSegment();

  return [...phrases];
}

function requiredMixedScriptTokens(query: string): string[] {
  const required = new Set<string>();
  const parts: string[] = [];
  let segment = "";

  const flushSegment = () => {
    if (segment) {
      parts.push(segment);
    }
    segment = "";
  };

  const segmentableRecallTokens = (value: string) => {
    const tokens = new Set<string>();
    let segment = "";
    const flushSegmentableSegment = () => {
      for (const token of normalizeRecallTokenSet(segment, [], { minTokenLength: 1 })) {
        tokens.add(token);
      }
      segment = "";
    };

    for (const ch of value) {
      if (/[\p{L}\p{N}]/u.test(ch) && !hasUnsegmentableRecallChar(ch)) {
        segment += ch;
        continue;
      }
      if (/\p{M}/u.test(ch) && segment.length > 0) {
        segment += ch;
        continue;
      }
      flushSegmentableSegment();
    }
    flushSegmentableSegment();
    return tokens;
  };

  const hasRequiredSegmentableToken = (value: string) => {
    return segmentableRecallTokens(value).size > 0;
  };

  const hasBoundarySegmentableToken = (value: string) => {
    for (const token of segmentableRecallTokens(value)) {
      if (PROMPT_RECALL_WORDS.has(token)) {
        continue;
      }
      const hasNonAsciiCodepoint = [...token].some((ch) => (ch.codePointAt(0) ?? 0) > 0x7f);
      if (token.length >= 3 || /\p{N}/u.test(token) || hasNonAsciiCodepoint) {
        return true;
      }
    }
    return false;
  };

  const addRequiredTokens = (value: string) => {
    for (const token of normalizeRecallTokenSet(value, [], { minTokenLength: 1 })) {
      required.add(token);
    }
  };

  for (const ch of query.toLowerCase().normalize("NFC")) {
    if (/[\p{L}\p{N}\p{M}]/u.test(ch) || hasUnsegmentableRecallChar(ch)) {
      segment += ch;
      continue;
    }
    flushSegment();
  }
  flushSegment();

  for (const part of parts) {
    if (hasUnsegmentableRecallChar(part) && hasRequiredSegmentableToken(part)) {
      addRequiredTokens(part);
    }
  }

  for (let i = 0; i < parts.length - 1; i += 1) {
    const current = parts[i];
    const next = parts[i + 1];
    const currentHasUnsegmentable = hasUnsegmentableRecallChar(current);
    const nextHasUnsegmentable = hasUnsegmentableRecallChar(next);
    if (currentHasUnsegmentable === nextHasUnsegmentable) {
      continue;
    }
    const segmentablePart = currentHasUnsegmentable ? next : current;
    if (!hasBoundarySegmentableToken(segmentablePart)) {
      continue;
    }
    addRequiredTokens(current);
    addRequiredTokens(next);
  }

  for (let i = 1; i < parts.length - 1; i += 1) {
    const prev = parts[i - 1];
    const current = parts[i];
    const next = parts[i + 1];
    if (!hasUnsegmentableRecallChar(prev) || hasUnsegmentableRecallChar(current) || !hasUnsegmentableRecallChar(next)) {
      continue;
    }
    if (!hasRequiredSegmentableToken(current)) {
      continue;
    }
    addRequiredTokens(prev);
    addRequiredTokens(current);
    addRequiredTokens(next);
  }

  return [...required];
}

function requiredSegmentableUnicodeTokens(queryTokens: Set<string>): string[] {
  const segmentableTokens = [...queryTokens].filter((token) => !hasUnsegmentableRecallChar(token));
  const hasSegmentableUnicodeToken = segmentableTokens.some((token) =>
    [...token].some((ch) => (ch.codePointAt(0) ?? 0) > 0x7f)
  );
  if (!hasSegmentableUnicodeToken) {
    return [];
  }
  return segmentableTokens.filter((token) => {
    if (PROMPT_RECALL_WORDS.has(token)) {
      return false;
    }
    const hasNonAsciiCodepoint = [...token].some((ch) => (ch.codePointAt(0) ?? 0) > 0x7f);
    if (hasNonAsciiCodepoint) {
      return true;
    }
    if (!/^[a-z0-9]+$/u.test(token)) {
      return false;
    }
    return token.length >= 3 || /\p{N}/u.test(token);
  });
}

function countTokenOverlap(queryTokens: Set<string>, valueTokens: Set<string>): number {
  let matches = 0;
  for (const token of queryTokens) {
    if (valueTokens.has(token)) matches += 1;
  }
  return matches;
}

/**
 * Determine whether a query can be served by the direct-answer tier.
 *
 * Decision ladder, in order:
 *
 *   1. config.enabled === false → "disabled"
 *   2. empty query tokens → "empty-query"
 *   3. empty candidates → "no-candidates"
 *   4. hard filters drop all candidates → "no-eligible-candidates"
 *   5. token-overlap floor drops all → "below-token-overlap-floor"
 *   6. top two candidates within ambiguityMargin → "ambiguous"
 *   7. otherwise → "eligible"
 */
export function isDirectAnswerEligible(input: DirectAnswerInput): DirectAnswerResult {
  const { query, candidates, config, queryEntityRefs } = input;

  if (!config.enabled) {
    return {
      eligible: false,
      reason: "disabled",
      narrative: "direct-answer tier is disabled",
      filteredBy: [],
    };
  }

  const queryTokens = new Set(normalizeRecallTokens(query));
  if (queryTokens.size === 0) {
    return {
      eligible: false,
      reason: "empty-query",
      narrative: "query has no searchable tokens after normalization",
      filteredBy: [],
    };
  }

  if (candidates.length === 0) {
    return {
      eligible: false,
      reason: "no-candidates",
      narrative: "no candidates supplied",
      filteredBy: [],
    };
  }

  const filteredBy: string[] = [];
  let working: DirectAnswerCandidate[] = candidates;

  working = applyFilter(working, filteredBy, FILTER_LABELS.nonActiveStatus, (c) => {
    const status: MemoryStatus = c.memory.frontmatter.status ?? "active";
    return status === "active";
  });

  working = applyFilter(working, filteredBy, FILTER_LABELS.notTrustedZone, (c) => c.trustZone === "trusted");

  working = applyFilter(
    working,
    filteredBy,
    FILTER_LABELS.ineligibleTaxonomyBucket,
    (c) => c.taxonomyBucket !== null && config.eligibleTaxonomyBuckets.includes(c.taxonomyBucket)
  );

  working = applyFilter(working, filteredBy, FILTER_LABELS.belowImportanceFloor, (c) => {
    if (c.memory.frontmatter.verificationState === "user_confirmed") return true;
    return c.importanceScore >= config.importanceFloor;
  });

  if (queryEntityRefs && queryEntityRefs.length > 0) {
    const normRefs = new Set(queryEntityRefs.map((r) => r.toLowerCase()));
    working = applyFilter(working, filteredBy, FILTER_LABELS.entityRefMismatch, (c) => {
      const ref = c.memory.frontmatter.entityRef;
      if (!ref) return true;
      return normRefs.has(ref.toLowerCase());
    });
  }

  if (working.length === 0) {
    return {
      eligible: false,
      reason: "no-eligible-candidates",
      narrative: "no candidates survived eligibility filters",
      filteredBy,
    };
  }

  const scored: ScoredCandidate[] = working.map((candidate) => {
    const searchable = `${candidate.memory.frontmatter.tags?.join(" ") ?? ""} ${candidate.memory.content}`.trim();
    const searchableTokens = normalizeRecallTokenSet(searchable);
    const requiredSearchableTokens = normalizeRecallTokenSet(searchable, [], { minTokenLength: 1 });
    const requiredPhrases = requiredCjkPhraseTokens(query);
    const requiredMixedTokens = requiredMixedScriptTokens(query);
    const requiredUnicodeTokens = requiredSegmentableUnicodeTokens(queryTokens);
    const hasRequiredPhrase =
      requiredPhrases.length === 0 || requiredPhrases.every((token) => searchableTokens.has(token));
    const hasRequiredMixedTokens =
      requiredMixedTokens.length === 0 || requiredMixedTokens.every((token) => requiredSearchableTokens.has(token));
    const hasRequiredUnicodeTokens =
      requiredUnicodeTokens.length === 0 || requiredUnicodeTokens.every((token) => searchableTokens.has(token));
    const requiredTokenMismatch = !hasRequiredPhrase || !hasRequiredMixedTokens || !hasRequiredUnicodeTokens;
    const matches = requiredTokenMismatch ? 0 : countTokenOverlap(queryTokens, searchableTokens);
    return { candidate, tokenOverlap: matches / queryTokens.size, requiredTokenMismatch };
  });

  const overlapSurvivors = scored.filter((s) => !s.requiredTokenMismatch && s.tokenOverlap >= config.tokenOverlapFloor);
  if (overlapSurvivors.length < scored.length) {
    filteredBy.push(FILTER_LABELS.belowTokenOverlapFloor);
  }

  if (overlapSurvivors.length === 0) {
    return {
      eligible: false,
      reason: "below-token-overlap-floor",
      narrative: `no candidate met token-overlap floor ${config.tokenOverlapFloor}`,
      filteredBy,
    };
  }

  overlapSurvivors.sort(compareScored);

  if (overlapSurvivors.length >= 2) {
    const topScore = scoreFor(overlapSurvivors[0]);
    const secondScore = scoreFor(overlapSurvivors[1]);
    if (topScore - secondScore < config.ambiguityMargin) {
      return {
        eligible: false,
        reason: "ambiguous",
        narrative: `top two candidates within ambiguityMargin ${config.ambiguityMargin}`,
        filteredBy,
      };
    }
  }

  const winner = overlapSurvivors[0];
  const bucket = winner.candidate.taxonomyBucket ?? "unknown";
  return {
    eligible: true,
    reason: "eligible",
    winner: winner.candidate,
    tokenOverlap: winner.tokenOverlap,
    narrative: `trusted ${bucket}, unambiguous, token-overlap ${winner.tokenOverlap.toFixed(2)}`,
    filteredBy,
  };
}

function applyFilter(
  working: DirectAnswerCandidate[],
  filteredBy: string[],
  label: string,
  keep: (c: DirectAnswerCandidate) => boolean
): DirectAnswerCandidate[] {
  const before = working.length;
  const next = working.filter(keep);
  if (next.length < before) filteredBy.push(label);
  return next;
}

function scoreFor(s: ScoredCandidate): number {
  return s.candidate.matchScore ?? s.tokenOverlap;
}

function compareScored(a: ScoredCandidate, b: ScoredCandidate): number {
  const diff = scoreFor(b) - scoreFor(a);
  if (diff !== 0) return diff;
  // Stable secondary key on path so the comparator returns 0 only for equal
  // entries (CLAUDE.md rule 19).
  return a.candidate.memory.path.localeCompare(b.candidate.memory.path);
}
