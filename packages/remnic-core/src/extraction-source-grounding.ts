import type { ExtractionResult } from "./types.js";

export interface ExtractionGroundingRoleSources {
  profile?: string;
  identity?: string;
}

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

const GROUNDING_ENTITY_TYPE_PREFIXES = new Set([
  "person",
  "project",
  "tool",
  "company",
  "place",
  "other",
]);

const GROUNDING_COMMON_VERB_FORMS = new Set([
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

interface GroundingLexeme {
  token: string;
  preserveTerminalS: boolean;
}

function groundingLexemes(text: string): GroundingLexeme[] {
  return text.normalize("NFKC").match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu)
    ?.map((rawToken) => {
      const token = rawToken.replaceAll("’", "'").toLocaleLowerCase();
      return {
        token,
        preserveTerminalS: /^\p{Lu}/u.test(rawToken) && !GROUNDING_COMMON_VERB_FORMS.has(token),
      };
    })
    ?? [];
}

function tokenSequence(text: string): string[] {
  return groundingLexemes(text).map(({ token }) => token);
}

function containsExactTokenSequence(candidate: string, source: string): boolean {
  const candidateTokens = tokenSequence(candidate);
  const sourceTokens = tokenSequence(source);
  if (candidateTokens.length === 0 || candidateTokens.length > sourceTokens.length) return false;
  return sourceTokens.some((_, index) =>
    candidateTokens.every((token, offset) => sourceTokens[index + offset] === token),
  );

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

function hasContradictoryPolarity(candidate: string, source: string): boolean {
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
      if (isNegatedAt(candidateTokens, candidateIndex) !== isNegatedAt(sourceTokens, sourceIndex)) {
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
    if (isNegatedAt(candidateTokens, candidateIndex) !== isNegatedAt(sourceTokens, sourceIndex)) {
      return true;
    }
  }
  return false;
}

const GROUNDING_MIN_SHARED_TOKENS = 2;
const GROUNDING_MIN_COVERAGE = 0.5;

function stemToken(token: string, preserveTerminalS = false): string {
  if (token.endsWith("'s")) return token.slice(0, -2);
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (!preserveTerminalS && token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const { token, preserveTerminalS } of groundingLexemes(text)) {
    if (GROUNDING_STOPWORDS[token] !== true) tokens.add(stemToken(token, preserveTerminalS));
  }
  return tokens;
}

function normalizeForExactMatch(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function sourceSentences(source: string): string[] {
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

function isInterrogativeSourceSentence(sentence: string): boolean {
  const normalized = sentence.trim();
  return normalized.endsWith("?")
    || /\b(?:whether|if)\b/iu.test(normalized)
    || /^(?:suppose|assuming|maybe|perhaps|hypothetically|is|are|am|was|were|do|does|did|can|could|will|would|should|has|have|had|what|which|when|where|why|how|who)\b/iu.test(
      normalized,
    );
}

function groundingTokenSequence(text: string): string[] {
  let lexemes = groundingLexemes(text);
  while (lexemes.length > 0 && GROUNDING_AUXILIARY_TOKENS.has(lexemes[0]!.token)) {
    lexemes = lexemes.slice(1);
  }
  return lexemes
    .filter(({ token }) => GROUNDING_STOPWORDS[token] !== true)
    .map(({ token, preserveTerminalS }) => stemToken(token, preserveTerminalS));
}

function normalizedGroundingTokenSequence(text: string): string[] {
  return groundingTokenSequence(text).map((token) => token.replace(/'$/u, ""));
}

function hasAlignedSubjectPredicateOverlap(candidate: string, source: string): boolean {
  const candidateTokens = normalizedGroundingTokenSequence(candidate);
  const sourceTokens = normalizedGroundingTokenSequence(source);
  if (candidateTokens.length < 3 || sourceTokens.length < 3) return true;

  const subjectAligned = candidateTokens[0] === sourceTokens[0];
  let foundAlignedToken = false;
  const sharedLength = Math.min(candidateTokens.length, sourceTokens.length);
  for (let index = 1; index < sharedLength; index += 1) {
    if (candidateTokens[index] !== sourceTokens[index]) continue;
    foundAlignedToken = true;
    const candidateNext = candidateTokens[index + 1];
    const sourceNext = sourceTokens[index + 1];
    if (candidateNext !== undefined && sourceNext !== undefined && candidateNext !== sourceNext) {
      return false;
    }
  }
  return subjectAligned && foundAlignedToken;
}

function groundedTokenScore(
  candidate: string,
  source: string,
  requireAlignedArguments = true,
): number {
  const candidateTokens = tokenize(candidate);
  if (candidateTokens.size === 0) return 0;
  const sourceTokens = tokenize(source);
  let sharedTokens = 0;
  for (const token of candidateTokens) {
    if (sourceTokens.has(token)) sharedTokens += 1;
  }
  if (
    sharedTokens < GROUNDING_MIN_SHARED_TOKENS
    || sharedTokens / candidateTokens.size < GROUNDING_MIN_COVERAGE
  ) {
    return 0;
  }
  if (requireAlignedArguments && !hasAlignedSubjectPredicateOverlap(candidate, source)) return 0;
  return sharedTokens / candidateTokens.size;
}

function candidateClauses(candidate: string): string[] {
  return sourceSentences(candidate).flatMap((sentence) =>
    sentence
      .split(/\s+(?:and|but|or|while|although|because)\s+/gu)
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0),
  );
}

function isSourceGroundedClause(
  candidate: string,
  source: string,
  includeInterrogativeSource = false,
): boolean {
  let bestSupportedScore = 0;
  let bestContradictedScore = 0;
  const sentences = sourceSentences(source);
  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index];
    if (isBareYesNoAnswer(sentence)) {
      const precedingSentence = sentences[index - 1];
      const answerToken = tokenSequence(sentence)[0];
      const contradictoryPolarity = precedingSentence !== undefined
        ? hasContradictoryPolarity(candidate, precedingSentence)
        : false;
      if (
        precedingSentence !== undefined
        && isInterrogativeSourceSentence(precedingSentence)
        && groundedTokenScore(candidate, precedingSentence) === 1
        && (
          (answerToken === "yes" && !contradictoryPolarity)
          || (answerToken === "no" && contradictoryPolarity)
        )
      ) {
        return true;
      }
      continue;
    }
    if (!includeInterrogativeSource && isInterrogativeSourceSentence(sentence)) continue;
    const sentenceText = normalizeForExactMatch(sentence);
    if (containsExactTokenSequence(candidate, sentenceText)) {
      if (!hasContradictoryPolarity(candidate, sentence)) return true;
      bestContradictedScore = Math.max(bestContradictedScore, 1);
      continue;
    }
    const score = groundedTokenScore(candidate, sentence, !includeInterrogativeSource);
    if (score === 0) continue;
    if (hasContradictoryPolarity(candidate, sentence)) {
      bestContradictedScore = Math.max(bestContradictedScore, score);
    } else {
      bestSupportedScore = Math.max(bestSupportedScore, score);
    }
  }
  return bestSupportedScore > bestContradictedScore;
}
function isSourceGrounded(
  candidate: string,
  source: string,
  includeInterrogativeSource = false,
): boolean {
  const candidateText = normalizeForExactMatch(candidate);
  const sourceText = source.normalize("NFKC").trim();
  if (candidateText.length === 0 || sourceText.length === 0) return false;

  const hasSupportedExactMatch = sourceSentences(sourceText).some((sentence) => {
    const sentenceText = normalizeForExactMatch(sentence);
    const isExplanatoryLabel = sentenceText.startsWith(`${candidateText}:`);
    if (!includeInterrogativeSource && isInterrogativeSourceSentence(sentence) && !isExplanatoryLabel) return false;
    return containsExactTokenSequence(candidateText, sentenceText)
      && !hasContradictoryPolarity(candidateText, sentenceText);
  });
  if (hasSupportedExactMatch) return true;

  const clauses = candidateClauses(candidateText);
  if (
    clauses.length > 1
    && clauses.some((clause) => !isSourceGroundedClause(clause, sourceText, includeInterrogativeSource))
  ) {
    return false;
  }
  return isSourceGroundedClause(candidateText, sourceText, includeInterrogativeSource);
}

function normalizedEntityIdentifierTokens(name: string): string[] {
  const identifier = normalizeForExactMatch(name).replace(/[-_]+/gu, " ");
  const tokens = groundingLexemes(identifier)
    .filter(({ token }) => GROUNDING_STOPWORDS[token] !== true)
    .map(({ token }) => stemToken(token, true));
  return tokens.length > 1 && GROUNDING_ENTITY_TYPE_PREFIXES.has(tokens[0] ?? "")
    ? tokens.slice(1)
    : tokens;
}

function isGroundedEntityName(name: string, source: string): boolean {
  const nameTokens = normalizedEntityIdentifierTokens(name);
  const sourceTokens = tokenize(source);
  return nameTokens.length > 0 && nameTokens.every((token) => sourceTokens.has(token));
}

function hasGroundedPredicateAnchor(candidate: string, sentence: string): boolean {
  const candidateTokens = normalizedGroundingTokenSequence(candidate);
  const sourceTokens = normalizedGroundingTokenSequence(sentence);
  const comparableCandidateTokens = GROUNDING_ROLE_SUBJECT_TOKENS.has(candidateTokens[0] ?? "")
    ? candidateTokens.slice(1)
    : candidateTokens;
  if (comparableCandidateTokens.length < 2) return false;
  const subjectToken = comparableCandidateTokens[0];
  if (subjectToken === undefined || !sourceTokens.includes(subjectToken)) {
    return false;
  }
  const candidatePredicateTokens = comparableCandidateTokens.slice(1);
  const sourceTokenSet = new Set(sourceTokens);
  const sharedPredicateTokens = candidatePredicateTokens.filter((token) => sourceTokenSet.has(token));
  const requiredSharedTokens = Math.min(2, candidatePredicateTokens.length);
  return sharedPredicateTokens.length >= requiredSharedTokens;
}
function hasGroundingAnchor(
  candidate: string,
  assertionSource: string,
  includeInterrogativeSource = false,
  requirePredicateSupport = false,
): boolean {
  return sourceSentences(assertionSource).some((sentence) => {
    if (!includeInterrogativeSource && isInterrogativeSourceSentence(sentence)) return false;
    const exactMatch = containsExactTokenSequence(candidate, sentence)
      && !hasContradictoryPolarity(candidate, sentence);
    if (exactMatch) return true;
    if (requirePredicateSupport && !hasGroundedPredicateAnchor(candidate, sentence)) return false;
    return groundedTokenScore(candidate, sentence) > 0
      || hasRoleNormalizedGrounding(candidate, sentence);
  });
}

function hasAnswerSupport(
  candidate: string,
  source: string,
  assertionSource: string,
): boolean {
  const assertionAnswers = new Set(
    tokenSequence(assertionSource).filter((token) => token === "yes" || token === "no"),
  );
  if (assertionAnswers.size === 0) return false;
  const sentences = sourceSentences(source);
  return sentences.some((sentence, index) => {
    const answerToken = tokenSequence(sentence)[0];
    if (answerToken !== "yes" && answerToken !== "no" || !assertionAnswers.has(answerToken)) return false;
    const precedingSentence = sentences[index - 1];
    if (
      precedingSentence === undefined
      || !isInterrogativeSourceSentence(precedingSentence)
      || groundedTokenScore(candidate, precedingSentence) !== 1
    ) {
      return false;
    }
    const contradictoryPolarity = hasContradictoryPolarity(candidate, precedingSentence);
    return answerToken === "yes" ? !contradictoryPolarity : contradictoryPolarity;
  });
}

const GROUNDING_ROLE_SUBJECT_TOKENS = new Set(["assistant", "user"]);

function hasRoleNormalizedGrounding(candidate: string, source: string): boolean {
  const candidateTokens = groundingTokenSequence(candidate);
  if (!GROUNDING_ROLE_SUBJECT_TOKENS.has(candidateTokens[0] ?? "")) return false;
  const claimTokens = candidateTokens.slice(1);
  if (claimTokens.length === 0) return false;

  return sourceSentences(source).some((sentence) => {
    if (isInterrogativeSourceSentence(sentence)) return false;
    const sourceTokens = groundingTokenSequence(sentence);
    const requiredSharedTokens = Math.min(GROUNDING_MIN_SHARED_TOKENS, claimTokens.length);
    let sourceIndex = 0;
    let sharedTokens = 0;
    for (const claimToken of claimTokens) {
      const matchingIndex = sourceTokens.indexOf(claimToken, sourceIndex);
      if (matchingIndex === -1) continue;
      sharedTokens += 1;
      sourceIndex = matchingIndex + 1;
    }
    return sharedTokens >= requiredSharedTokens
      && !hasContradictoryPolarity(candidate, sentence);
  });
}

interface GroundingContext {
  source: string;
  assertionSource: string | undefined;
  allowRoleNormalization: boolean;
}

function resolveGroundingContext(
  candidate: string,
  source: string,
  assertionSource: string | undefined,
  roleAssertionSources: ExtractionGroundingRoleSources | undefined,
): GroundingContext {
  const candidateRole = groundingTokenSequence(candidate)[0];
  if (!GROUNDING_ROLE_SUBJECT_TOKENS.has(candidateRole ?? "")) {
    return { source, assertionSource, allowRoleNormalization: false };
  }
  if (roleAssertionSources === undefined) {
    return { source, assertionSource, allowRoleNormalization: true };
  }
  const roleSource = candidateRole === "user"
    ? roleAssertionSources.profile
    : roleAssertionSources.identity;
  return {
    source: roleSource ?? "",
    assertionSource: roleSource ?? "",
    allowRoleNormalization: true,
  };
}

function isGroundedCandidate(
  candidate: string,
  source: string,
  assertionSource: string | undefined,
  includeInterrogativeSource = false,
  allowRoleNormalization = false,
): boolean {
  const allowInterrogativeSource = includeInterrogativeSource
    || (
      assertionSource !== undefined
      && normalizeForExactMatch(assertionSource) !== normalizeForExactMatch(source)
    );
  const sourceGrounded = isSourceGrounded(candidate, source, allowInterrogativeSource);
  const roleGrounded = allowRoleNormalization && hasRoleNormalizedGrounding(candidate, source);
  const candidateTokens = groundingTokenSequence(candidate);
  const roleNormalizedCandidate = allowRoleNormalization
    && GROUNDING_ROLE_SUBJECT_TOKENS.has(candidateTokens[0] ?? "");
  if (roleNormalizedCandidate && !roleGrounded) return false;
  if (!sourceGrounded && !roleGrounded) return false;
  if (assertionSource === undefined) return true;
  const clauses = candidateClauses(candidate);
  const requirePredicateSupport = !includeInterrogativeSource
    && assertionSource !== undefined
    && normalizeForExactMatch(assertionSource) !== normalizeForExactMatch(source);
  return clauses.length > 0
    && (
      clauses.every((clause) =>
        hasGroundingAnchor(clause, assertionSource, includeInterrogativeSource, requirePredicateSupport))
      || hasAnswerSupport(candidate, source, assertionSource)
    );
}

function filterGroundedFact(
  fact: ExtractionResult["facts"][number],
  source: string,
  assertionSource: string | undefined,
  roleAssertionSources: ExtractionGroundingRoleSources | undefined,
): ExtractionResult["facts"][number] | undefined {
  const factContext = resolveGroundingContext(fact.content, source, assertionSource, roleAssertionSources);
  if (!isGroundedCandidate(
    fact.content,
    factContext.source,
    factContext.assertionSource,
    false,
    factContext.allowRoleNormalization,
  )) return undefined;

  const groundedAttributes = fact.structuredAttributes
    ? Object.fromEntries(
      Object.entries(fact.structuredAttributes)
        .filter(([key, value]) => {
          const attribute = `${key}: ${value}`;
          const attributeContext = resolveGroundingContext(
            attribute,
            source,
            assertionSource,
            roleAssertionSources,
          );
          return isGroundedCandidate(
            attribute,
            attributeContext.source,
            attributeContext.assertionSource,
            false,
            attributeContext.allowRoleNormalization,
          );
        }),
    )
    : undefined;
  const groundedProcedureSteps = fact.procedureSteps
    ? fact.procedureSteps.flatMap((step) => {
      if (!isGroundedCandidate(step.intent, source, assertionSource, true)) return [];
      const expectedOutcome = step.expectedOutcome
        && isGroundedCandidate(step.expectedOutcome, source, assertionSource, true)
        ? step.expectedOutcome
        : undefined;
      const toolCall = step.toolCall
        && isGroundedCandidate(step.toolCall.signature, source, assertionSource, true)
        ? step.toolCall
        : undefined;
      const {
        expectedOutcome: _expectedOutcome,
        toolCall: _toolCall,
        ...stepWithoutOptionalFields
      } = step;
      return [{
        ...stepWithoutOptionalFields,
        ...(expectedOutcome !== undefined ? { expectedOutcome } : {}),
        ...(toolCall !== undefined ? { toolCall } : {}),
      }];
    })
    : undefined;
  const groundedReasoningTrace = fact.reasoningTrace
    && fact.reasoningTrace.steps.length > 0
    && isGroundedCandidate(fact.reasoningTrace.finalAnswer, source, assertionSource, true)
    && fact.reasoningTrace.steps.every((step) =>
      isGroundedCandidate(step.description, source, assertionSource, true),
    )
    ? {
      steps: fact.reasoningTrace.steps,
      finalAnswer: fact.reasoningTrace.finalAnswer,
      ...(fact.reasoningTrace.observedOutcome
        && isGroundedCandidate(fact.reasoningTrace.observedOutcome, source, assertionSource, true)
        ? { observedOutcome: fact.reasoningTrace.observedOutcome }
        : {}),
    }
    : undefined;
  const groundedEventTime = fact.eventTime
    && isGroundedCandidate(fact.eventTime, source, assertionSource)
    ? fact.eventTime
    : undefined;
  const entityRefSource = factContext.assertionSource ?? factContext.source;
  const groundedEntityRef = fact.entityRef !== undefined
    && isGroundedEntityName(fact.entityRef, entityRefSource)
    ? fact.entityRef
    : undefined;
  const {
    entityRef: _entityRef,
    structuredAttributes: _structuredAttributes,
    procedureSteps: _procedureSteps,
    reasoningTrace: _reasoningTrace,
    eventTime: _eventTime,
    ...factWithoutGroundingFields
  } = fact;
  return {
    ...factWithoutGroundingFields,
    ...(groundedEntityRef !== undefined ? { entityRef: groundedEntityRef } : {}),
    ...(groundedAttributes && Object.keys(groundedAttributes).length > 0
      ? { structuredAttributes: groundedAttributes }
      : {}),
    ...(groundedProcedureSteps && groundedProcedureSteps.length > 0
      ? { procedureSteps: groundedProcedureSteps }
      : {}),
    ...(groundedReasoningTrace !== undefined ? { reasoningTrace: groundedReasoningTrace } : {}),
    ...(groundedEventTime !== undefined ? { eventTime: groundedEventTime } : {}),
  };
}

function filterGroundedEntity(
  entity: ExtractionResult["entities"][number],
  source: string,
  assertionSource: string | undefined,
): ExtractionResult["entities"][number] | undefined {
  if (!isGroundedEntityName(entity.name, source)) return undefined;
  const facts = entity.facts.filter((fact) => isGroundedCandidate(fact, source, assertionSource));
  const structuredSections = entity.structuredSections
    ?.flatMap((section) => {
      const groundedFacts = section.facts.filter((fact) => isGroundedCandidate(fact, source, assertionSource));
      return groundedFacts.length > 0
        ? [{ ...section, facts: groundedFacts }]
        : [];
    });
  if (facts.length === 0 && (structuredSections === undefined || structuredSections.length === 0)) {
    return undefined;
  }
  const { structuredSections: _structuredSections, ...entityWithoutSections } = entity;
  return {
    ...entityWithoutSections,
    facts,
    ...(structuredSections && structuredSections.length > 0 ? { structuredSections } : {}),
  };
}

function normalizedEntitySourceText(name: string): string {
  return normalizedEntityIdentifierTokens(name).join(" ");
}

function isGroundedRelationship(
  relationship: NonNullable<ExtractionResult["relationships"]>[number],
  source: string,
  assertionSource: string | undefined,
): boolean {
  const sourceName = normalizedEntitySourceText(relationship.source);
  const targetName = normalizedEntitySourceText(relationship.target);
  const labelTokens = tokenize(relationship.label);
  if (sourceName.length === 0 || targetName.length === 0 || labelTokens.size === 0) return false;
  const relationText = `${sourceName} ${relationship.label} ${targetName}`;
  const hasCoherentSourceSpan = sourceSentences(source).some((sentence) => {
    if (isInterrogativeSourceSentence(sentence)) return false;
    return groundedTokenScore(relationText, sentence) === 1
      && !hasContradictoryPolarity(relationText, sentence);
  });
  return hasCoherentSourceSpan
    && isGroundedCandidate(relationText, source, assertionSource);
}

function isUnknownAnswerSentence(sentence: string): boolean {
  return /\b(?:unknown|unclear|unsure|unresolved|unanswered|not\s+(?:known|sure|available)|don't\s+know|do\s+not\s+know|no\s+idea|pending)\b/iu
    .test(sentence);
}

function isBareYesNoAnswer(sentence: string): boolean {
  return /^(?:yes|no)[.!]?$/iu.test(sentence.trim());
}

function isQuestionAnsweredBySource(question: string, source: string): boolean {
  const questionTokens = tokenize(question);
  if (questionTokens.size === 0) return false;
  const isYesNoQuestion = /^(?:is|are|am|was|were|do|does|did|can|could|will|would|should|has|have|had)\b/iu
    .test(question.trim());
  const sentences = sourceSentences(source);
  return sentences.some((sentence, index) => {
    if (isInterrogativeSourceSentence(sentence)) return false;
    if (isBareYesNoAnswer(sentence)) {
      const precedingSentence = sentences[index - 1];
      return precedingSentence !== undefined
        && isInterrogativeSourceSentence(precedingSentence)
        && groundedTokenScore(question, precedingSentence) === 1;
    }
    if (isUnknownAnswerSentence(sentence)) return false;
    const score = groundedTokenScore(question, sentence);
    if (score !== 1) return false;
    const sentenceTokens = tokenize(sentence);
    const hasAnswerToken = [...sentenceTokens].some((token) => !questionTokens.has(token));
    return isYesNoQuestion || hasAnswerToken;
  });
}

function groundQuestion(
  question: ExtractionResult["questions"][number],
  source: string,
  assertionSource: string | undefined,
): ExtractionResult["questions"][number] | undefined {
  if (isQuestionAnsweredBySource(question.question, source)) return undefined;
  if (!isGroundedCandidate(question.question, source, assertionSource, true)) return undefined;
  const normalizedContext = question.context.trim();
  if (
    normalizedContext.length > 0
    && !isGroundedCandidate(normalizedContext, `${source}\n${question.question}`, assertionSource, true)
  ) {
    return { ...question, context: "" };
  }
  return question;
}

export function filterExtractionResultBySource(
  result: ExtractionResult,
  source: string,
  assertionSource?: string,
  roleAssertionSources?: ExtractionGroundingRoleSources,
): ExtractionResult {
  if (source.trim().length === 0) {
    return {
      ...result,
      facts: [],
      profileUpdates: [],
      entities: [],
      questions: [],
      ...(result.relationships !== undefined ? { relationships: [] } : {}),
      identityReflection: undefined,
    };
  }

  const facts = result.facts.flatMap((fact) => {
    const grounded = filterGroundedFact(fact, source, assertionSource, roleAssertionSources);
    return grounded === undefined ? [] : [grounded];
  });
  const profileGroundingSource = roleAssertionSources?.profile ?? source;
  const profileAssertionSource = roleAssertionSources?.profile ?? assertionSource;
  const profileUpdates = result.profileUpdates.filter((update) =>
    isGroundedCandidate(update, profileGroundingSource, profileAssertionSource, false, true),
  );
  const entities = result.entities.flatMap((entity) => {
    const grounded = filterGroundedEntity(entity, source, assertionSource);
    return grounded === undefined ? [] : [grounded];
  });
  const questions = result.questions.flatMap((question) => {
    const grounded = groundQuestion(question, source, assertionSource);
    return grounded === undefined ? [] : [grounded];
  });
  const relationships = result.relationships?.filter((relationship) =>
    isGroundedRelationship(relationship, source, assertionSource),
  );
  const identityGroundingSource = roleAssertionSources?.identity ?? source;
  const identityAssertionSource = roleAssertionSources?.identity ?? assertionSource;
  const identityReflection = result.identityReflection
    && isGroundedCandidate(
      result.identityReflection,
      identityGroundingSource,
      identityAssertionSource,
      false,
      true,
    )
    ? result.identityReflection
    : undefined;

  return {
    ...result,
    facts,
    profileUpdates,
    entities,
    questions,
    ...(result.relationships !== undefined ? { relationships } : {}),
    ...(identityReflection !== undefined ? { identityReflection } : { identityReflection: undefined }),
  };
}
