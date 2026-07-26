export function isInterrogativeSourceSentence(sentence: string): boolean {
  const normalized = sentence.trim();
  const embeddedQuestionVerbIndex = normalized.search(
    /\b(?:determine|know|wonder|ask(?:ed)?|question|decide|check|confirm|find|figure|understand|unclear)\b/iu,
  );
  const embeddedQuestionMarkerIndex = normalized.search(/\b(?:whether|if)\b/iu);
  const hasEmbeddedQuestion = embeddedQuestionVerbIndex >= 0
    && embeddedQuestionMarkerIndex > embeddedQuestionVerbIndex;
  return normalized.endsWith("?")
    || hasEmbeddedQuestion
    || (
      !normalized.includes(":")
      && /^(?:suppose|assuming|assume|maybe|perhaps|hypothetically|if|whether|imagine|imagining|presume|presuming|supposing|is|are|am|was|were|do|does|did|can|could|will|would|should|has|have|had|what|which|when|where|why|how|who)\b/iu.test(
        normalized,
      )
    );
}

export function containsContiguousGroundingTokens(
  candidateTokens: ReadonlyArray<string>,
  sourceTokens: ReadonlyArray<string>,
): boolean {
  if (candidateTokens.length === 0 || candidateTokens.length > sourceTokens.length) return false;
  return sourceTokens.some((_, start) =>
    candidateTokens.every((token, offset) => sourceTokens[start + offset] === token),
  );
}

export function hasExplicitRoleSubjectToken(
  candidateRole: string | undefined,
  sourceTokensBySentence: ReadonlyArray<ReadonlyArray<string>>,
): boolean {
  return candidateRole !== undefined
    && sourceTokensBySentence.some((tokens) => tokens.includes(candidateRole));
}

export function splitGroundingClauses(sentences: ReadonlyArray<string>): string[] {
  return sentences.flatMap((sentence) =>
    sentence
      .split(/,\s+(?=[\p{L}][\p{L}\p{N}'’-]*\s+\S)/gu)
      .flatMap((commaClause) =>
        commaClause
          .split(/\s*(?::|[—–])\s+|\s+\/\s+/u)
          .flatMap((delimiterClause) =>
            delimiterClause
              .split(/\s+(?:and|but|or|while|although|because)\s+/gu)
              .map((clause) => clause.trim())
              .filter((clause) => clause.length > 0),
          ),
      ),
  );
}

export const GROUNDING_STOPWORDS: Record<string, true> = {
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
  only: true,
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

export const GROUNDING_NEGATION_TOKENS = new Set([
  "no",
  "not",
  "false",
  "untrue",
  "incorrect",
  "wrong",
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

export const GROUNDING_AUXILIARY_TOKENS = new Set([
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

export const GROUNDING_COPULAR_FORMS = new Set([
  "am",
  "are",
  "be",
  "been",
  "being",
  "is",
  "was",
  "were",
]);

export const GROUNDING_SUBJECT_PRONOUNS = new Set([
  "he",
  "she",
  "they",
  "it",
  "i",
  "we",
  "you",
]);
export const GROUNDING_ENTITY_TYPE_PREFIXES = new Set([
  "person",
  "project",
  "tool",
  "company",
  "place",
  "other",
]);

export const GROUNDING_COMMON_VERB_FORMS = new Set([
  "contains",
  "employs",
  "gives",
  "has",
  "hosts",
  "likes",
  "makes",
  "needs",
  "owns",
  "prefers",
  "requires",
  "runs",
  "shares",
  "supports",
  "takes",
  "uses",
  "wants",
  "works",
]);

export interface GroundingLexeme {
  token: string;
  preserveTerminalS: boolean;
}

export function groundingLexemes(text: string): GroundingLexeme[] {
  return text.normalize("NFKC").match(
    /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?(?:\+\+[\p{L}\p{N}]*|#[\p{L}\p{N}]*)?/gu,
  )
    ?.map((rawToken) => {
      const token = rawToken.replaceAll("’", "'").toLocaleLowerCase();
      return {
        token,
        preserveTerminalS: /^\p{Lu}/u.test(rawToken) && !GROUNDING_COMMON_VERB_FORMS.has(token),
      };
    })
    ?? [];
}

export function tokenSequence(text: string): string[] {
  return groundingLexemes(text).map(({ token }) => token);
}

export function containsExactTokenSequence(candidate: string, source: string): boolean {
  const candidateTokens = tokenSequence(candidate);
  const sourceTokens = tokenSequence(source);
  if (candidateTokens.length === 0 || candidateTokens.length > sourceTokens.length) return false;
  return sourceTokens.some((_, index) =>
    candidateTokens.every((token, offset) => sourceTokens[index + offset] === token),
  );

}

export function isNegationCue(token: string): boolean {
  return GROUNDING_NEGATION_TOKENS.has(token) || token.endsWith("n't");
}

export function isAttachedNegatedAuxiliary(token: string): boolean {
  return token.endsWith("n't")
    || token === "cannot"
    || token === "cant"
    || token === "can't";
}

export function isNegatedAt(tokens: ReadonlyArray<string>, index: number): boolean {
  if (tokens[index - 1] === "only" && tokens[index - 2] === "not") return false;
  const previousStart = Math.max(0, index - 2);
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

export const GROUNDING_MIN_SHARED_TOKENS = 2;
export const GROUNDING_MIN_COVERAGE = 0.5;

export function stemToken(token: string, preserveTerminalS = false): string {
  if (token.endsWith("'s")) return token.slice(0, -2);
  if (preserveTerminalS) return token;
  if (token.length > 5 && token.endsWith("ing")) {
    const stem = token.slice(0, -3);
    return /(.)\1$/u.test(stem) ? stem.slice(0, -1) : stem;
  }
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (
    !preserveTerminalS
    && token.length > 3
    && token.endsWith("s")
    && !token.endsWith("ss")
    && GROUNDING_COMMON_VERB_FORMS.has(token)
  ) {
    return token.slice(0, -1);
  }
  return token;
}


export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const { token, preserveTerminalS } of groundingLexemes(text)) {
    if (GROUNDING_STOPWORDS[token] !== true) tokens.add(stemToken(token, preserveTerminalS));
  }
  return tokens;
}

export function normalizeForExactMatch(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

export function sourceSentences(source: string): string[] {
  const sentences: string[] = [];
  let sentenceStart = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];
    const boundary = character === "!"
      || character === "?"
      || character === ";"
      || character === "\n"
      || (character === "." && (
        nextCharacter === undefined
        || /\s/u.test(nextCharacter)
        || /["')\]}]/u.test(nextCharacter)
      ));
    if (!boundary) continue;
    let sentenceEnd = character === "\n" ? index : index + 1;
    while (/[.!?;\n]/u.test(source[sentenceEnd] ?? "")) sentenceEnd += 1;
    const sentence = source.slice(sentenceStart, sentenceEnd).trim();
    if (sentence.length > 0) sentences.push(sentence);
    sentenceStart = sentenceEnd;
    index = sentenceEnd - 1;
  }
  const trailingSentence = source.slice(sentenceStart).trim();
  if (trailingSentence.length > 0) sentences.push(trailingSentence);
  return sentences.length > 0 ? sentences : [source];
}


export function groundingTokenSequence(text: string): string[] {
  let lexemes = groundingLexemes(text);
  while (lexemes.length > 0 && GROUNDING_AUXILIARY_TOKENS.has(lexemes[0]!.token)) {
    lexemes = lexemes.slice(1);
  }
  return lexemes
    .filter(({ token }) => GROUNDING_STOPWORDS[token] !== true)
    .map(({ token, preserveTerminalS }) => stemToken(token, preserveTerminalS));
}
export function normalizedGroundingAlignmentTokenSequence(text: string): string[] {
  const normalized = normalizedGroundingTokenSequence(text);
  const firstLexeme = groundingLexemes(text)[0];
  if (firstLexeme === undefined || !GROUNDING_SUBJECT_PRONOUNS.has(firstLexeme.token)) {
    return normalized;
  }
  return [stemToken(firstLexeme.token, firstLexeme.preserveTerminalS), ...normalized];
}


export function normalizedGroundingTokenSequence(text: string): string[] {
  return groundingTokenSequence(text).map((token) => token.replace(/'$/u, ""));
}

export function areGroundingTokensCompatible(left: string, right: string): boolean {
  return left === right || `${left}e` === right || left === `${right}e`;
}
