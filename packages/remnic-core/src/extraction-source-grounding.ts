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

const GROUNDING_NEGATION_TOKENS = new Set([
  "no",
  "not",
  "never",
  "without",
  "neither",
  "nor",
  "none",
  "cannot",
  "cant",
  "can't",
  "don't",
  "doesn't",
  "didn't",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  "won't",
  "wouldn't",
  "couldn't",
  "shouldn't",
  "haven't",
  "hasn't",
  "hadn't",
]);

const GROUNDING_AUXILIARY_TOKENS = new Set([
  "am",
  "are",
  "be",
  "been",
  "being",
  "can",
  "could",
  "did",
  "do",
  "does",
  "had",
  "has",
  "have",
  "is",
  "was",
  "were",
  "will",
  "would",
  "should",
]);

function tokenSequence(text: string): string[] {
  return text.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu)
    ?.map((token) => token.replaceAll("’", "'"))
    ?? [];
}

function isNegationCue(token: string): boolean {
  return GROUNDING_NEGATION_TOKENS.has(token) || token.endsWith("n't");
}

function isAttachedNegatedAuxiliary(token: string): boolean {
  return token.endsWith("n't")
    || token === "cannot"
    || token === "cant"
    || token === "can't";
}

function isNegatedAt(tokens: ReadonlyArray<string>, index: number): boolean {
  const previousStart = Math.max(0, index - 3);
  for (let i = previousStart; i < index; i += 1) {
    if (isNegationCue(tokens[i])) return true;
  }

  if (tokens[index - 1] === "than" && tokens[index - 2] === "rather") return true;
  if (tokens[index - 1] === "of" && tokens[index - 2] === "instead") return true;

  const next = tokens[index + 1];
  if (next !== undefined && isAttachedNegatedAuxiliary(next)) return true;
  const nextNext = tokens[index + 2];
  return next !== undefined
    && nextNext !== undefined
    && GROUNDING_AUXILIARY_TOKENS.has(next)
    && isNegationCue(nextNext);
}

function hasContradictoryPolarity(candidate: string, source: string): boolean {
  const candidateTokens = tokenSequence(candidate);
  const sourceTokens = tokenSequence(source);
  const sourcePositions = new Map<string, number[]>();
  sourceTokens.forEach((token, index) => {
    const key = stemToken(token);
    const positions = sourcePositions.get(key);
    if (positions) positions.push(index);
    else sourcePositions.set(key, [index]);
  });

  for (const [candidateIndex, token] of candidateTokens.entries()) {
    if (GROUNDING_STOPWORDS[token] === true) continue;
    const positions = sourcePositions.get(stemToken(token));
    if (!positions || positions.length === 0) continue;
    const sourceIndex = positions[positions.length - 1];
    if (isNegatedAt(candidateTokens, candidateIndex) !== isNegatedAt(sourceTokens, sourceIndex)) {
      return true;
    }
  }
  return false;
}

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
  if (hasContradictoryPolarity(candidateText, sourceText)) return false;
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
