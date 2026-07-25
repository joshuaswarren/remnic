import type { ExtractionResult } from "./types.js";

const GROUNDING_STOPWORDS: Record<string, true> = {
  a: true,
  an: true,
  and: true,
  are: true,
  as: true,
  at: true,
  be: true,
  been: true,
  being: true,
  but: true,
  by: true,
  can: true,
  could: true,
  did: true,
  do: true,
  does: true,
  for: true,
  from: true,
  had: true,
  has: true,
  have: true,
  he: true,
  her: true,
  here: true,
  hers: true,
  him: true,
  his: true,
  how: true,
  i: true,
  if: true,
  in: true,
  into: true,
  is: true,
  it: true,
  its: true,
  just: true,
  me: true,
  my: true,
  no: true,
  not: true,
  of: true,
  on: true,
  or: true,
  our: true,
  ours: true,
  she: true,
  so: true,
  than: true,
  that: true,
  the: true,
  their: true,
  them: true,
  then: true,
  there: true,
  these: true,
  they: true,
  this: true,
  those: true,
  to: true,
  too: true,
  under: true,
  up: true,
  us: true,
  very: true,
  was: true,
  we: true,
  were: true,
  what: true,
  when: true,
  where: true,
  which: true,
  who: true,
  will: true,
  with: true,
  would: true,
  you: true,
  your: true,
};

const GROUNDING_MIN_SHARED_TOKENS = 2;
const GROUNDING_MIN_COVERAGE = 0.5;

function stemToken(token: string): string {
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of text.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (GROUNDING_STOPWORDS[token] !== true) tokens.add(stemToken(token));
  }
  return tokens;
}

function normalizeForExactMatch(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function hasGroundedTokenCoverage(candidate: string, source: string): boolean {
  const candidateTokens = tokenize(candidate);
  if (candidateTokens.size === 0) return false;
  const sourceTokens = tokenize(source);
  let sharedTokens = 0;
  for (const token of candidateTokens) {
    if (sourceTokens.has(token)) sharedTokens += 1;
  }
  return sharedTokens >= GROUNDING_MIN_SHARED_TOKENS
    && sharedTokens / candidateTokens.size >= GROUNDING_MIN_COVERAGE;
}

function isSourceGrounded(candidate: string, source: string): boolean {
  const candidateText = normalizeForExactMatch(candidate);
  const sourceText = normalizeForExactMatch(source);
  if (candidateText.length === 0 || sourceText.length === 0) return false;
  if (sourceText.includes(candidateText)) return true;
  return hasGroundedTokenCoverage(candidateText, sourceText);
}

function isGroundedQuestion(question: string, context: string, source: string): boolean {
  if (!isSourceGrounded(question, source)) return false;
  const normalizedContext = context.trim();
  return normalizedContext.length === 0
    || isSourceGrounded(normalizedContext, `${source}\n${question}`);
}

export function filterExtractionResultBySource(
  result: ExtractionResult,
  source: string,
): ExtractionResult {
  if (source.trim().length === 0) {
    return {
      ...result,
      facts: [],
      profileUpdates: [],
      questions: [],
    };
  }

  const facts = result.facts.filter((fact) => isSourceGrounded(fact.content, source));
  const profileUpdates = result.profileUpdates.filter((update) => isSourceGrounded(update, source));
  const questions = result.questions.filter((question) =>
    isGroundedQuestion(question.question, question.context, source),
  );

  if (
    facts.length === result.facts.length
    && profileUpdates.length === result.profileUpdates.length
    && questions.length === result.questions.length
  ) {
    return result;
  }

  return {
    ...result,
    facts,
    profileUpdates,
    questions,
  };
}
