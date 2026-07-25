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

const GROUNDING_ENTITY_TYPE_PREFIXES = new Set([
  "person",
  "project",
  "tool",
  "company",
  "place",
  "other",
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

function sourceSentences(source: string): string[] {
  const sentences = source.match(/[^.!?;]+(?:[.!?;]+(?=\s|$)|$)/gu)
    ?.map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  return sentences && sentences.length > 0 ? sentences : [source];
}

function isInterrogativeSourceSentence(sentence: string): boolean {
  const normalized = sentence.trim();
  return normalized.endsWith("?")
    || /^(?:if|whether|suppose|assuming|maybe|perhaps|hypothetically|is|are|am|was|were|do|does|did|can|could|will|would|should|has|have|had|what|which|when|where|why|how|who)\b/iu.test(
      normalized,
    );
}

function groundedTokenScore(candidate: string, source: string): number {
  const candidateTokens = tokenize(candidate);
  if (candidateTokens.size === 0) return 0;
  const sourceTokens = tokenize(source);
  let sharedTokens = 0;
  for (const token of candidateTokens) {
    if (sourceTokens.has(token)) sharedTokens += 1;
  }
  return sharedTokens >= GROUNDING_MIN_SHARED_TOKENS
    && sharedTokens / candidateTokens.size >= GROUNDING_MIN_COVERAGE
    ? sharedTokens / candidateTokens.size
    : 0;
}

function candidateClauses(candidate: string): string[] {
  return candidate
    .split(/\s+(?:and|but|or|while|although|because)\s+/gu)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

function isSourceGroundedClause(
  candidate: string,
  source: string,
  includeInterrogativeSource = false,
): boolean {
  let bestSupportedScore = 0;
  let bestContradictedScore = 0;
  for (const sentence of sourceSentences(source)) {
    if (!includeInterrogativeSource && isInterrogativeSourceSentence(sentence)) continue;
    const sentenceText = normalizeForExactMatch(sentence);
    if (sentenceText.includes(candidate)) {
      if (!hasContradictoryPolarity(candidate, sentenceText)) return true;
      bestContradictedScore = Math.max(bestContradictedScore, 1);
      continue;
    }
    const score = groundedTokenScore(candidate, sentenceText);
    if (score === 0) continue;
    if (hasContradictoryPolarity(candidate, sentenceText)) {
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
  const sourceText = normalizeForExactMatch(source);
  if (candidateText.length === 0 || sourceText.length === 0) return false;

  if (
    sourceText.includes(candidateText)
    && (includeInterrogativeSource || !isInterrogativeSourceSentence(sourceText))
    && !hasContradictoryPolarity(candidateText, sourceText)
  ) {
    return true;
  }
  const hasSupportedExactMatch = sourceSentences(sourceText).some((sentence) => {
    if (!includeInterrogativeSource && isInterrogativeSourceSentence(sentence)) return false;
    const sentenceText = normalizeForExactMatch(sentence);
    return sentenceText.includes(candidateText)
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
  const tokens = tokenSequence(identifier)
    .filter((token) => GROUNDING_STOPWORDS[token] !== true)
    .map(stemToken);
  return tokens.length > 1 && GROUNDING_ENTITY_TYPE_PREFIXES.has(tokens[0] ?? "")
    ? tokens.slice(1)
    : tokens;
}

function isGroundedEntityName(name: string, source: string): boolean {
  const nameTokens = normalizedEntityIdentifierTokens(name);
  const sourceTokens = tokenize(source);
  return nameTokens.length > 0 && nameTokens.every((token) => sourceTokens.has(token));
}

function hasGroundingAnchor(candidate: string, assertionSource: string): boolean {
  const candidateTokens = tokenize(candidate);
  const assertionTokens = tokenize(assertionSource);
  return [...candidateTokens].some((token) => assertionTokens.has(token));
}

function isGroundedCandidate(
  candidate: string,
  source: string,
  assertionSource: string | undefined,
  includeInterrogativeSource = false,
): boolean {
  const allowInterrogativeSource = includeInterrogativeSource
    || (
      assertionSource !== undefined
      && normalizeForExactMatch(assertionSource) !== normalizeForExactMatch(source)
    );
  if (!isSourceGrounded(candidate, source, allowInterrogativeSource)) return false;
  if (assertionSource === undefined) return true;
  const clauses = candidateClauses(candidate);
  return clauses.length > 0 && clauses.every((clause) => hasGroundingAnchor(clause, assertionSource));
}

function filterGroundedFact(
  fact: ExtractionResult["facts"][number],
  source: string,
  assertionSource: string | undefined,
): ExtractionResult["facts"][number] | undefined {
  if (!isGroundedCandidate(fact.content, source, assertionSource)) return undefined;

  const groundedAttributes = fact.structuredAttributes
    ? Object.fromEntries(
      Object.entries(fact.structuredAttributes)
        .filter(([key, value]) => isGroundedCandidate(`${key}: ${value}`, source, assertionSource)),
    )
    : undefined;
  const groundedProcedureSteps = fact.procedureSteps
    ? fact.procedureSteps.flatMap((step) => {
      if (!isGroundedCandidate(step.intent, source, assertionSource)) return [];
      const expectedOutcome = step.expectedOutcome
        && isGroundedCandidate(step.expectedOutcome, source, assertionSource)
        ? step.expectedOutcome
        : undefined;
      const toolCall = step.toolCall
        && isGroundedCandidate(step.toolCall.signature, source, assertionSource)
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
    && isGroundedCandidate(fact.reasoningTrace.finalAnswer, source, assertionSource)
    && fact.reasoningTrace.steps.every((step) =>
      isGroundedCandidate(step.description, source, assertionSource),
    )
    ? {
      steps: fact.reasoningTrace.steps,
      finalAnswer: fact.reasoningTrace.finalAnswer,
      ...(fact.reasoningTrace.observedOutcome
        && isGroundedCandidate(fact.reasoningTrace.observedOutcome, source, assertionSource)
        ? { observedOutcome: fact.reasoningTrace.observedOutcome }
        : {}),
    }
    : undefined;
  const groundedEventTime = fact.eventTime
    && isGroundedCandidate(fact.eventTime, source, assertionSource)
    ? fact.eventTime
    : undefined;
  const {
    structuredAttributes: _structuredAttributes,
    procedureSteps: _procedureSteps,
    reasoningTrace: _reasoningTrace,
    eventTime: _eventTime,
    ...factWithoutGroundingFields
  } = fact;
  return {
    ...factWithoutGroundingFields,
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

function isGroundedRelationship(
  relationship: NonNullable<ExtractionResult["relationships"]>[number],
  source: string,
  assertionSource: string | undefined,
): boolean {
  return isGroundedEntityName(relationship.source, source)
    && isGroundedEntityName(relationship.target, source)
    && isGroundedCandidate(
      `${relationship.source} ${relationship.label} ${relationship.target}`,
      source,
      assertionSource,
    );
}

function isQuestionAnsweredBySource(question: string, source: string): boolean {
  const questionTokens = tokenize(question);
  if (questionTokens.size === 0) return false;
  const isYesNoQuestion = /^(?:is|are|am|was|were|do|does|did|can|could|will|would|should|has|have|had)\b/iu
    .test(question.trim());
  return sourceSentences(source).some((sentence) => {
    if (isInterrogativeSourceSentence(sentence)) return false;
    const score = groundedTokenScore(question, sentence);
    if (score === 0) return false;
    const sentenceTokens = tokenize(sentence);
    return isYesNoQuestion && score === 1
      || [...sentenceTokens].some((token) => !questionTokens.has(token));
  });
}

function isGroundedQuestion(
  question: string,
  context: string,
  source: string,
  assertionSource: string | undefined,
): boolean {
  if (isQuestionAnsweredBySource(question, source)) return false;
  if (!isGroundedCandidate(question, source, assertionSource, true)) return false;
  const normalizedContext = context.trim();
  return normalizedContext.length === 0
    || isGroundedCandidate(normalizedContext, `${source}\n${question}`, assertionSource, true);
}

export function filterExtractionResultBySource(
  result: ExtractionResult,
  source: string,
  assertionSource?: string,
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
    const grounded = filterGroundedFact(fact, source, assertionSource);
    return grounded === undefined ? [] : [grounded];
  });
  const profileUpdates = result.profileUpdates.filter((update) =>
    isGroundedCandidate(update, source, assertionSource),
  );
  const entities = result.entities.flatMap((entity) => {
    const grounded = filterGroundedEntity(entity, source, assertionSource);
    return grounded === undefined ? [] : [grounded];
  });
  const questions = result.questions.filter((question) =>
    isGroundedQuestion(question.question, question.context, source, assertionSource),
  );
  const relationships = result.relationships?.filter((relationship) =>
    isGroundedRelationship(relationship, source, assertionSource),
  );
  const identityReflection = result.identityReflection
    && isGroundedCandidate(result.identityReflection, source, assertionSource)
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
