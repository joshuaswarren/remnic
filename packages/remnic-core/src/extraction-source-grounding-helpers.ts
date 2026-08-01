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
      && /^(?:suppose|assuming|assume|maybe|perhaps|hypothetically|if|whether|imagine|imagining|presume|presuming|supposing|is|are|am|was|were|do|does|did|can|could|will|would|should|has|have|had|what|which|when|where|why|how|who|whom)\b/iu.test(
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
    && sourceTokensBySentence.some((tokens) =>
      tokens.some((token) => token.replace(/^[\u0000\u0001]/u, "") === candidateRole));
}

export function splitGroundingClauses(
  sentences: ReadonlyArray<string>,
  inheritCoordinatedSubjects = false,
): string[] {
  return sentences.flatMap((sentence) => {
    const clauses = sentence
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
      );
    if (!inheritCoordinatedSubjects || clauses.length < 2) return clauses;

    const firstLexemes = groundingLexemes(clauses[0]!)
      .filter(({ token }) => GROUNDING_STOPWORDS[token] !== true);
    const firstPredicateIndex = firstLexemes.findIndex(({ isPredicate }) => isPredicate);
    let subjectLexemes = firstLexemes
      .slice(0, firstPredicateIndex < 1 ? 1 : firstPredicateIndex)
      .filter(({ token }) => !token.endsWith("ly"));
    let subject = subjectLexemes.map(({ surface }) => surface).join(" ");
    let predicate = firstLexemes[firstPredicateIndex < 1 ? 1 : firstPredicateIndex]?.surface;
    if (subject.length === 0 || predicate === undefined) return clauses;

    const sourceSpans = [clauses[0]!];
    for (const clause of clauses.slice(1)) {
      const clauseLexemes = groundingLexemes(clause)
        .filter(({ token }) => GROUNDING_STOPWORDS[token] !== true);
      const clausePredicateIndex = clauseLexemes.findIndex(({ isPredicate }) => isPredicate);
      const clauseSubjectLexemes = clausePredicateIndex > 0
        ? clauseLexemes
          .slice(0, clausePredicateIndex)
          .filter(({ token }) => !token.endsWith("ly"))
        : [];
      const repeatsSubject = clauseSubjectLexemes.length === subjectLexemes.length
        && subjectLexemes.every(
          ({ token }, index) => clauseSubjectLexemes[index]?.token === token,
        );
      if (repeatsSubject) {
        sourceSpans.push(clause);
        continue;
      }
      if (clauseSubjectLexemes.length > 0) {
        subjectLexemes = clauseSubjectLexemes;
        subject = subjectLexemes.map(({ surface }) => surface).join(" ");
        predicate = clauseLexemes[clausePredicateIndex]?.surface;
        sourceSpans.push(clause);
        continue;
      }
      const prefix = clausePredicateIndex === -1 ? `${subject} ${predicate}` : subject;
      sourceSpans.push(clause, `${prefix} ${clause}`);
    }
    return sourceSpans;
  });
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
  why: true,
  where: true,
  which: true,
  who: true,
  whom: true,
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

export const GROUNDING_COMMON_VERB_FORMS: Record<string, true> = {
  add: true,
  adds: true,
  call: true,
  calls: true,
  contain: true,
  contains: true,
  employ: true,
  deploy: true,
  deploys: true,
  design: true,
  designs: true,
  employs: true,
  fill: true,
  fills: true,
  go: true,
  goes: true,
  gone: true,
  went: true,
  give: true,
  gives: true,
  has: true,
  host: true,
  hosts: true,
  like: true,
  likes: true,
  manage: true,
  manages: true,
  make: true,
  makes: true,
  need: true,
  needs: true,
  own: true,
  owns: true,
  plan: true,
  plans: true,
  prefer: true,
  prefers: true,
  require: true,
  requires: true,
  run: true,
  runs: true,
  sleep: true,
  sleeps: true,
  stop: true,
  stops: true,
  swim: true,
  swims: true,
  share: true,
  shares: true,
  support: true,
  supports: true,
  take: true,
  takes: true,
  try: true,
  tries: true,
  use: true,
  uses: true,
  want: true,
  wants: true,
  work: true,
  works: true,
};


export interface GroundingLexeme {
  token: string;
  surface: string;
  isPredicate: boolean;
  preserveTerminalS: boolean;
}

export function groundingLexemes(text: string): GroundingLexeme[] {
  const rawTokens = text.normalize("NFKC").match(
    /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?(?:\+\+[\p{L}\p{N}]*|#[\p{L}\p{N}]*)?/gu,
  ) ?? [];
  const tokens = rawTokens.map((rawToken) =>
    rawToken.replaceAll("’", "'").toLocaleLowerCase());
  let predicateIndex = tokens.findIndex((token, index) => {
    const previousToken = tokens[index - 1];
    const followsAuxiliary = previousToken !== undefined
      && GROUNDING_AUXILIARY_TOKENS.has(previousToken);
    let previousMeaningfulIndex = index - 1;
    while (
      previousMeaningfulIndex >= 0
      && !GROUNDING_COPULAR_FORMS.has(tokens[previousMeaningfulIndex] ?? "")
      && (
        GROUNDING_STOPWORDS[tokens[previousMeaningfulIndex] ?? ""] === true
        || (tokens[previousMeaningfulIndex] ?? "").endsWith("ly")
      )
    ) {
      previousMeaningfulIndex -= 1;
    }
    const followsCopularAuxiliary = GROUNDING_COPULAR_FORMS.has(
      tokens[previousMeaningfulIndex] ?? "",
    );
    const capitalized = /^\p{Lu}/u.test(rawTokens[index] ?? "");
    const terminalSInflection = index > 0
      && token.endsWith("s")
      && !token.endsWith("ss")
      && !GROUNDING_AUXILIARY_TOKENS.has(token);
    const capitalizedSubjectHasLaterPredicate = index === 0
      && tokens.some((laterToken, laterIndex) =>
        laterIndex > 0
        && !/^\p{Lu}/u.test(rawTokens[laterIndex] ?? "")
        && (
          GROUNDING_AUXILIARY_TOKENS.has(laterToken)
          || GROUNDING_COMMON_VERB_FORMS[laterToken] === true
          || laterToken.endsWith("ed")
          || laterToken.endsWith("ing")
        ));
    if (capitalized && (index !== 0 || capitalizedSubjectHasLaterPredicate)) return false;
    if (followsCopularAuxiliary && terminalSInflection) return false;
    return GROUNDING_COMMON_VERB_FORMS[token] === true
      || token.endsWith("ed")
      || token.endsWith("ing")
      || (followsAuxiliary && !followsCopularAuxiliary)
      || terminalSInflection;
  });
  if (predicateIndex === -1) {
    const leadingSubjectLength = rawTokens.findIndex((rawToken) => !/^\p{Lu}/u.test(rawToken));
    if (leadingSubjectLength > 0) {
      predicateIndex = tokens.findIndex((token, index) =>
        index >= leadingSubjectLength
        && (
          GROUNDING_AUXILIARY_TOKENS.has(token)
          || (
            GROUNDING_STOPWORDS[token] !== true
            && !/^\p{Lu}/u.test(rawTokens[index] ?? "")
          )
        ));
    }
  }
  return rawTokens.map((rawToken, index) => {
    const token = tokens[index]!;
    const isPredicate = index === predicateIndex;
    return {
      token,
      surface: rawToken,
      preserveTerminalS: !isPredicate && (
        /^\p{Lu}/u.test(rawToken)
        || token.endsWith("s")
      ),
      isPredicate,
    };
  });
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

const STRICT_GROUNDING_TOKEN_PREFIX = "\u0000";
const INFLECTED_GROUNDING_TOKEN_PREFIX = "\u0001";

export function stemToken(
  token: string,
  preserveTerminalS = false,
  markExact = false,
): string {
  if (token.endsWith("'s")) return token.slice(0, -2);
  if (preserveTerminalS) {
    if (!markExact) return token;
    return `${STRICT_GROUNDING_TOKEN_PREFIX}${token}`;
  }
  if (token.length > 5 && token.endsWith("ing")) {
    const stem = token.slice(0, -3);
    const inflectionDoubled = /(.)\1$/u.test(stem) && stem.length > 3 && !/[lsz]$/u.test(stem);
    const normalized = inflectionDoubled ? stem.slice(0, -1) : stem;
    return markExact ? `${INFLECTED_GROUNDING_TOKEN_PREFIX}${normalized}` : normalized;
  }
  if (token.length > 4 && token.endsWith("ied")) {
    const normalized = `${token.slice(0, -3)}y`;
    return markExact ? `${INFLECTED_GROUNDING_TOKEN_PREFIX}${normalized}` : normalized;
  }
  if (token.length > 4 && token.endsWith("ed")) {
    const stem = token.slice(0, -2);
    const inflectionDoubled = /(.)\1$/u.test(stem) && stem.length > 3 && !/[lsz]$/u.test(stem);
    const normalized = inflectionDoubled ? stem.slice(0, -1) : stem;
    return markExact ? `${INFLECTED_GROUNDING_TOKEN_PREFIX}${normalized}` : normalized;
  }
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.endsWith("ies") ? `${token.slice(0, -3)}y` : token.slice(0, -1);
  }
  return token;
}


export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const { token, preserveTerminalS } of groundingLexemes(text)) {
    if (GROUNDING_STOPWORDS[token] !== true) tokens.add(stemToken(token, preserveTerminalS, true));
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
    .map(({ token, preserveTerminalS }) => stemToken(token, preserveTerminalS, true));
}
export function normalizedGroundingAlignmentTokenSequence(text: string): string[] {
  const normalized = normalizedGroundingTokenSequence(text);
  const firstLexeme = groundingLexemes(text)[0];
  if (firstLexeme === undefined || !GROUNDING_SUBJECT_PRONOUNS.has(firstLexeme.token)) {
    return normalized;
  }
  return [stemToken(firstLexeme.token, firstLexeme.preserveTerminalS, true), ...normalized];
}


export function normalizedGroundingTokenSequence(text: string): string[] {
  return groundingTokenSequence(text).map((token) => token.replace(/'$/u, ""));
}

export function areGroundingTokensCompatible(left: string, right: string): boolean {
  const leftPrefix = left[0];
  const rightPrefix = right[0];
  const leftMarked = leftPrefix === STRICT_GROUNDING_TOKEN_PREFIX
    || leftPrefix === INFLECTED_GROUNDING_TOKEN_PREFIX;
  const rightMarked = rightPrefix === STRICT_GROUNDING_TOKEN_PREFIX
    || rightPrefix === INFLECTED_GROUNDING_TOKEN_PREFIX;
  const leftToken = leftMarked ? left.slice(1) : left;
  const rightToken = rightMarked ? right.slice(1) : right;
  if (leftToken === rightToken) {
    const strictToInflected = (
      leftPrefix === STRICT_GROUNDING_TOKEN_PREFIX
      && rightPrefix === INFLECTED_GROUNDING_TOKEN_PREFIX
    ) || (
      rightPrefix === STRICT_GROUNDING_TOKEN_PREFIX
      && leftPrefix === INFLECTED_GROUNDING_TOKEN_PREFIX
    );
    return !strictToInflected;
  }
  if (leftPrefix === STRICT_GROUNDING_TOKEN_PREFIX || rightPrefix === STRICT_GROUNDING_TOKEN_PREFIX) {
    return false;
  }
  return `${leftToken}e` === rightToken || leftToken === `${rightToken}e`;
}
const GROUNDING_DENIAL_REPORTING_VERBS = new Set([
  "deny",
  "denied",
  "denies",
  "denying",
  "dispute",
  "disputed",
  "disputes",
  "disputing",
  "reject",
  "rejected",
  "rejects",
  "rejecting",
  "refute",
  "refuted",
  "refutes",
  "refuting",
  "contradict",
  "contradicted",
  "contradicts",
  "contradicting",
  "disprove",
  "disproved",
  "disproves",
  "disproving",
]);

function isDenialReportingVerb(token: string): boolean {
  return GROUNDING_DENIAL_REPORTING_VERBS.has(token);
}
const GROUNDING_NON_ASSERTIVE_REPORTING_VERBS = new Set([
  "allege",
  "alleged",
  "alleges",
  "alleging",
  "allegedly",
  "assert",
  "asserted",
  "asserts",
  "asserting",
  "believe",
  "believed",
  "believes",
  "believing",
  "claim",
  "claimed",
  "claims",
  "claiming",
  "doubt",
  "doubted",
  "doubts",
  "doubting",
  "uncertain",
  "unsure",
  "unclear",
  "unknown",
  "possibly",
  "probably",
  "imagine",
  "imagined",
  "imagines",
  "imagining",
  "report",
  "reported",
  "reports",
  "reporting",
  "reportedly",
  "say",
  "said",
  "says",
  "saying",
  "speculate",
  "speculated",
  "speculates",
  "speculating",
  "suspect",
  "suspected",
  "suspects",
  "suspecting",
  "suppose",
  "supposed",
  "supposes",
  "supposing",
  "supposedly",
  "think",
  "thought",
  "thinks",
  "thinking",
]);

function isNonAssertiveReportingVerb(token: string): boolean {
  return GROUNDING_NON_ASSERTIVE_REPORTING_VERBS.has(token);
}

function isGroundingClauseBoundary(token: string): boolean {
  return token === "and"
    || token === "but"
    || token === "or"
    || token === "while"
    || token === "although"
    || token === "because";
}

function isNonAssertiveReportingAt(tokens: ReadonlyArray<string>, index: number): boolean {
  let boundary = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (isGroundingClauseBoundary(tokens[cursor]!)) boundary = cursor + 1;
  }
  for (let cursor = index - 1; cursor >= boundary; cursor -= 1) {
    if (
      tokens[cursor] === "that"
      && cursor > boundary
      && isNonAssertiveReportingVerb(tokens[cursor - 1]!)
    ) {
      return true;
    }
    if (isNonAssertiveReportingVerb(tokens[cursor]!) && index - cursor <= 5) return true;
  }
  return false;
}

function isDeniedAt(tokens: ReadonlyArray<string>, index: number): boolean {
  let boundary = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (isGroundingClauseBoundary(tokens[cursor]!)) boundary = cursor + 1;
  }
  for (let cursor = index - 1; cursor >= boundary; cursor -= 1) {
    const token = tokens[cursor];
    if (token === "that" && cursor > boundary && isDenialReportingVerb(tokens[cursor - 1]!)) {
      return true;
    }
    if (isDenialReportingVerb(token) && index - cursor <= 5) return true;
  }
  return false;
}

export function hasContradictoryPolarity(candidate: string, source: string): boolean {
  const candidateLexemes = groundingLexemes(candidate);
  const candidateTokens = candidateLexemes.map(({ token }) => token);
  let coherentContradiction = false;
  for (const clause of sourceSentences(source).flatMap((sentence) =>
    sentence.split(/\s+(?:and|but|or|while|although|because)\s+/gu))) {
    const sourceLexemes = groundingLexemes(clause);
    const sourceTokens = sourceLexemes.map(({ token }) => token);
    let sourceCursor = 0;
    let allTokensFound = true;
    let contradiction = false;
    for (const [candidateIndex, candidateToken] of candidateTokens.entries()) {
      if (GROUNDING_STOPWORDS[candidateToken] === true) continue;
      const sourceIndex = sourceTokens.findIndex(
        (sourceToken, index) =>
          index >= sourceCursor
          && stemToken(sourceToken, sourceLexemes[index]?.preserveTerminalS === true)
            === stemToken(candidateToken, candidateLexemes[candidateIndex]?.preserveTerminalS === true),
      );
      if (sourceIndex === -1) {
        allTokensFound = false;
        break;
      }
      const candidateNegated = isNegatedAt(candidateTokens, candidateIndex)
        || isDeniedAt(candidateTokens, candidateIndex);
      const sourceNegated = isNegatedAt(sourceTokens, sourceIndex)
        || isDeniedAt(sourceTokens, sourceIndex);
      const candidateNonAssertive = isNonAssertiveReportingAt(candidateTokens, candidateIndex);
      const sourceNonAssertive = isNonAssertiveReportingAt(sourceTokens, sourceIndex);
      if (
        candidateNegated !== sourceNegated
        || candidateNonAssertive !== sourceNonAssertive
      ) {
        contradiction = true;
      }
      sourceCursor = sourceIndex + 1;
    }
    if (allTokensFound) {
      if (!contradiction) return false;
      coherentContradiction = true;
    }
  }
  if (coherentContradiction) return true;

  const sourceLexemes = groundingLexemes(source);
  const sourceTokens = sourceLexemes.map(({ token }) => token);
  const sourcePositions = new Map<string, number[]>();
  sourceLexemes.forEach(({ token, preserveTerminalS }, index) => {
    const key = stemToken(token, preserveTerminalS);
    const positions = sourcePositions.get(key);
    if (positions) positions.push(index);
    else sourcePositions.set(key, [index]);
  });
  for (const [candidateIndex, token] of candidateTokens.entries()) {
    if (GROUNDING_STOPWORDS[token] === true) continue;
    const positions = sourcePositions.get(
      stemToken(token, candidateLexemes[candidateIndex]?.preserveTerminalS === true),
    );
    if (!positions || positions.length === 0) continue;
    const sourceIndex = positions[positions.length - 1];
    const candidateNegated = isNegatedAt(candidateTokens, candidateIndex)
      || isDeniedAt(candidateTokens, candidateIndex);
    const sourceNegated = isNegatedAt(sourceTokens, sourceIndex)
      || isDeniedAt(sourceTokens, sourceIndex);
    const candidateNonAssertive = isNonAssertiveReportingAt(candidateTokens, candidateIndex);
    const sourceNonAssertive = isNonAssertiveReportingAt(sourceTokens, sourceIndex);
    if (
      candidateNegated !== sourceNegated
      || candidateNonAssertive !== sourceNonAssertive
    ) {
      return true;
    }
  }
  return false;
}
