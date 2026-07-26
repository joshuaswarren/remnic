import type { ExtractionResult } from "./types.js";
import { anchorTemporalExpressions } from "./delinearize.js";
import {
  GROUNDING_AUXILIARY_TOKENS,
  GROUNDING_COPULAR_FORMS,
  GROUNDING_ENTITY_TYPE_PREFIXES,
  GROUNDING_MIN_COVERAGE,
  GROUNDING_MIN_SHARED_TOKENS,
  GROUNDING_STOPWORDS,
  areGroundingTokensCompatible,
  containsContiguousGroundingTokens,
  containsExactTokenSequence,
  groundingLexemes,
  groundingTokenSequence,
  hasExplicitRoleSubjectToken,
  isAttachedNegatedAuxiliary,
  isInterrogativeSourceSentence,
  isNegatedAt,
  isNegationCue,
  normalizeForExactMatch,
  normalizedGroundingAlignmentTokenSequence,
  normalizedGroundingTokenSequence,
  sourceSentences,
  splitGroundingClauses,
  stemToken,
  tokenize,
  tokenSequence,
} from "./extraction-source-grounding-helpers.js";

export interface ExtractionSourceGroundingOptions {
  sourceGrounding: boolean;
  anchorTemporalExpressions: boolean;
}

export function applyExtractionSourceGrounding(
  result: ExtractionResult,
  sourceText: string,
  assertionSourceText: string = sourceText,
  roleAssertionSources: ExtractionGroundingRoleSources | undefined,
  messageTimestamp: Date | undefined,
  options: ExtractionSourceGroundingOptions,
): ExtractionResult {
  if (!options.sourceGrounding) return result;
  const anchorSource = (source: string): string =>
    options.anchorTemporalExpressions
      ? anchorTemporalExpressions(source, messageTimestamp ?? new Date())
      : source;
  const anchoredRoleSources = roleAssertionSources === undefined
    ? undefined
    : {
      profile: roleAssertionSources.profile === undefined
        ? undefined
        : anchorSource(roleAssertionSources.profile),
      identity: roleAssertionSources.identity === undefined
        ? undefined
        : anchorSource(roleAssertionSources.identity),
    };
  return filterExtractionResultBySource(
    result,
    anchorSource(sourceText),
    anchorSource(assertionSourceText),
    anchoredRoleSources,
    options.anchorTemporalExpressions ? anchorSource : undefined,
  );
}

export interface ExtractionGroundingRoleSources {
  profile?: string;
  identity?: string;
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

function isGroundingClauseBoundary(token: string): boolean {
  return token === "and"
    || token === "but"
    || token === "or"
    || token === "while"
    || token === "although"
    || token === "because";
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


interface GroundingCopularClaim {
  subject: string;
  predicate: string;
}

function groundingCopularClaim(text: string): GroundingCopularClaim | undefined {
  const lexemes = groundingLexemes(text);
  const copulaIndex = lexemes.findIndex(({ token }) => GROUNDING_COPULAR_FORMS.has(token));
  if (copulaIndex <= 0) return undefined;

  let subjectIndex = copulaIndex - 1;
  while (
    subjectIndex >= 0
    && GROUNDING_AUXILIARY_TOKENS.has(lexemes[subjectIndex]!.token)
  ) {
    subjectIndex -= 1;
  }
  const subjectLexeme = lexemes[subjectIndex];
  const predicateLexeme = lexemes
    .slice(copulaIndex + 1)
    .find(({ token }) => GROUNDING_STOPWORDS[token] !== true);
  if (subjectLexeme === undefined || predicateLexeme === undefined) return undefined;

  return {
    subject: stemToken(subjectLexeme.token, subjectLexeme.preserveTerminalS),
    predicate: stemToken(predicateLexeme.token, predicateLexeme.preserveTerminalS),
  };
}

function hasCopularPredicateEvidence(candidate: string, source: string): boolean {
  const candidateClaim = groundingCopularClaim(candidate);
  if (candidateClaim === undefined) return true;
  const sourceClaim = groundingCopularClaim(source);
  return sourceClaim !== undefined
    && areGroundingTokensCompatible(candidateClaim.subject, sourceClaim.subject)
    && areGroundingTokensCompatible(candidateClaim.predicate, sourceClaim.predicate);
}
const GROUNDING_ALIGNMENT_MODIFIERS = new Set([
  "actively",
  "again",
  "already",
  "currently",
  "eventually",
  "finally",
  "generally",
  "mainly",
  "newly",
  "now",
  "often",
  "previously",
  "primarily",
  "quickly",
  "recently",
  "repeatedly",
  "simply",
  "slowly",
  "sometimes",
  "still",
  "successfully",
  "typically",
  "usually",
]);

function isGroundingAlignmentModifier(token: string): boolean {
  return GROUNDING_ALIGNMENT_MODIFIERS.has(token);
}


function hasAlignedSubjectPredicateOverlap(candidate: string, source: string): boolean {
  const candidateTokens = normalizedGroundingAlignmentTokenSequence(candidate);
  const sourceTokens = normalizedGroundingAlignmentTokenSequence(source);
  if (candidateTokens.length < 3 || sourceTokens.length < 3) {
    return hasCopularPredicateEvidence(candidate, source);
  }

  const candidateSubject = candidateTokens[0];
  if (candidateSubject === undefined) return false;
  const hasCorrectionReordering = /\b(?:rather\s+than|instead\s+of)\b/iu.test(candidate)
    && /\b(?:not|rather\s+than|instead\s+of)\b/iu.test(source);
  for (let sourceSubjectIndex = 0; sourceSubjectIndex < sourceTokens.length; sourceSubjectIndex += 1) {
    if (!areGroundingTokensCompatible(candidateSubject, sourceTokens[sourceSubjectIndex]!)) continue;
    let sourceCursor = sourceSubjectIndex + 1;
    let foundAlignedToken = false;
    let aligned = true;
    for (let candidateIndex = 1; candidateIndex < candidateTokens.length; candidateIndex += 1) {
      const candidateToken = candidateTokens[candidateIndex]!;
      const sourceIndex = sourceTokens.findIndex(
        (sourceToken, index) =>
          index >= sourceCursor && areGroundingTokensCompatible(candidateToken, sourceToken),
      );
      if (sourceIndex === -1) {
        if (hasCorrectionReordering) continue;
        aligned = false;
        break;
      }
      foundAlignedToken = true;
      const candidateNext = candidateTokens[candidateIndex + 1];
      const sourceNext = sourceTokens[sourceIndex + 1];
      if (
        candidateNext !== undefined
        && sourceNext !== undefined
        && !hasCorrectionReordering
        && !areGroundingTokensCompatible(candidateNext, sourceNext)
        && !isGroundingAlignmentModifier(sourceNext)
      ) {
        aligned = false;
        break;
      }
      sourceCursor = sourceIndex + 1;
    }
    if (aligned && foundAlignedToken) return true;
  }
  return false;
}

function groundedTokenScore(
  candidate: string,
  source: string,
  requireAlignedArguments = true,
  requireAllCandidateTokensGrounded = true,
): number {
  const candidateTokens = tokenize(candidate);
  if (candidateTokens.size === 0) return 0;
  const sourceTokens = tokenize(source);
  const allowCorrectionReordering = /\b(?:rather\s+than|instead\s+of)\b/iu.test(candidate);
  let sharedTokens = 0;
  let allCandidateTokensGrounded = true;
  for (const token of candidateTokens) {
    if ([...sourceTokens].some((sourceToken) => areGroundingTokensCompatible(token, sourceToken))) {
      sharedTokens += 1;
    } else if (!allowCorrectionReordering && token !== "rather" && token !== "instead") {
      allCandidateTokensGrounded = false;
    }
  }
  if (
    (requireAllCandidateTokensGrounded && !allCandidateTokensGrounded)
    || sharedTokens < GROUNDING_MIN_SHARED_TOKENS
    || sharedTokens / candidateTokens.size < GROUNDING_MIN_COVERAGE
  ) {
    return 0;
  }
  if (requireAlignedArguments && !hasAlignedSubjectPredicateOverlap(candidate, source)) return 0;
  return sharedTokens / candidateTokens.size;
}

function candidateClauses(candidate: string): string[] {
  return splitGroundingClauses(sourceSentences(candidate));
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
    if (isYesNoAnswer(sentence)) {
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
    const sentenceText = normalizeForExactMatch(sentence);
    const isExplanatoryLabel = sentenceText.startsWith(`${normalizeForExactMatch(candidate)}:`)
      && !sentence.trim().endsWith("?");
    if (!includeInterrogativeSource && isInterrogativeSourceSentence(sentence) && !isExplanatoryLabel) {
      continue;
    }
    const sourceSpans = /\b(?:rather\s+than|instead\s+of)\b/iu.test(candidate)
      ? [sentence]
      : splitGroundingClauses([sentence]);
    for (const sourceSpan of sourceSpans) {
      const sourceSpanText = normalizeForExactMatch(sourceSpan);
      if (containsExactTokenSequence(candidate, sourceSpanText)) {
        if (!hasContradictoryPolarity(candidate, sourceSpan)) return true;
        bestContradictedScore = Math.max(bestContradictedScore, 1);
        continue;
      }
      const score = groundedTokenScore(
        candidate,
        sourceSpan,
        !includeInterrogativeSource,
        !includeInterrogativeSource,
      );
      if (score === 0) continue;
      if (hasContradictoryPolarity(candidate, sourceSpan)) {
        bestContradictedScore = Math.max(bestContradictedScore, score);
      } else {
        bestSupportedScore = Math.max(bestSupportedScore, score);
      }
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
    const isExplanatoryLabel = sentenceText.startsWith(`${candidateText}:`)
      && !sentence.trim().endsWith("?");
    if (!includeInterrogativeSource && isInterrogativeSourceSentence(sentence) && !isExplanatoryLabel) return false;
    return containsExactTokenSequence(candidateText, sentenceText)
      && !hasContradictoryPolarity(candidateText, sentenceText);
  });
  if (hasSupportedExactMatch) return true;

  const clauses = candidateClauses(candidateText);
  if (clauses.length > 1) {
    return clauses.every((clause) =>
      isSourceGroundedClause(clause, sourceText, includeInterrogativeSource));
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
  return nameTokens.length > 0 && sourceSentences(source).some((sentence) => {
    const sentenceTokens = groundingLexemes(sentence)
      .filter(({ token }) => GROUNDING_STOPWORDS[token] !== true)
      .map(({ token, preserveTerminalS }) => stemToken(token, preserveTerminalS));
    return containsContiguousGroundingTokens(nameTokens, sentenceTokens);
  });
}
function buildEntitySupportSource(name: string, source: string): string {
  const nameTokens = normalizedEntityIdentifierTokens(name);
  if (nameTokens.length === 0) return "";
  return sourceSentences(source)
    .filter((sentence) => {
      const sentenceTokens = groundingLexemes(sentence)
        .filter(({ token }) => GROUNDING_STOPWORDS[token] !== true)
        .map(({ token, preserveTerminalS }) => stemToken(token, preserveTerminalS));
      return containsContiguousGroundingTokens(nameTokens, sentenceTokens);
    })
    .join(" ");
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
    const sourceSpans = /\b(?:rather\s+than|instead\s+of)\b/iu.test(candidate)
      ? [sentence]
      : splitGroundingClauses([sentence]);
    return sourceSpans.some((sourceSpan) => {
      const exactMatch = containsExactTokenSequence(candidate, sourceSpan)
        && !hasContradictoryPolarity(candidate, sourceSpan);
      if (exactMatch) return true;
      if (requirePredicateSupport && !hasGroundedPredicateAnchor(candidate, sourceSpan)) return false;
      return groundedTokenScore(candidate, sourceSpan) > 0
        || hasRoleNormalizedGrounding(candidate, sourceSpan);
    });
  });
}

function hasAnswerSupport(
  candidate: string,
  source: string,
  assertionSource: string,
): boolean {
  const assertedAnswerSentences = new Set(
    sourceSentences(assertionSource)
      .filter((sentence) => {
        const answerToken = tokenSequence(sentence)[0];
        return answerToken === "yes" || answerToken === "no";
      })
      .map((sentence) => normalizeForExactMatch(sentence)),
  );
  if (assertedAnswerSentences.size === 0) return false;
  const sentences = sourceSentences(source);
  return sentences.some((sentence, index) => {
    const answerToken = tokenSequence(sentence)[0];
    if (answerToken !== "yes" && answerToken !== "no") return false;
    if (!assertedAnswerSentences.has(normalizeForExactMatch(sentence))) return false;
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
  fallbackSource?: string;
  fallbackAssertionSource?: string;
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
    fallbackSource: source,
    fallbackAssertionSource: assertionSource,
  };
}

function selectGroundingContext(candidate: string, context: GroundingContext): GroundingContext {
  if (isGroundedCandidate(
    candidate,
    context.source,
    context.assertionSource,
    false,
    context.allowRoleNormalization,
  )) {
    return context;
  }
  if (
    context.fallbackSource === undefined
    || !hasExplicitRoleSubjectToken(
      groundingTokenSequence(candidate)[0],
      sourceSentences(context.fallbackSource).map((sentence) => groundingTokenSequence(sentence)),
    )
  ) return context;
  const fallbackContext: GroundingContext = {
    source: context.fallbackSource,
    assertionSource: context.fallbackAssertionSource,
    allowRoleNormalization: false,
  };
  return isGroundedCandidate(
    candidate,
    fallbackContext.source,
    fallbackContext.assertionSource,
    false,
    fallbackContext.allowRoleNormalization,
  )
    ? fallbackContext
    : context;
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

function buildFactSupportSource(
  source: string,
  supportingSentences: ReadonlyArray<string>,
): string {
  const sentences = sourceSentences(source);
  const selectedIndices = new Set<number>();
  for (const supportingSentence of supportingSentences) {
    const supportIndex = sentences.indexOf(supportingSentence);
    if (supportIndex < 0) continue;
    let endIndex = supportIndex;
    while (
      endIndex < sentences.length - 1
      && sentences[endIndex]!.trimEnd().endsWith(";")
      && /^(?:its|their|this|that|these|those)\b/iu.test(
        sentences[endIndex + 1]!.trimStart(),
      )
    ) {
      endIndex += 1;
    }
    for (let index = supportIndex; index <= endIndex; index += 1) {
      selectedIndices.add(index);
    }
  }
  return [...selectedIndices]
    .sort((left, right) => left - right)
    .map((index) => sentences[index]!)
    .join(" ");
}
function buildProcedureSupportSource(
  fact: ExtractionResult["facts"][number],
  source: string,
  factSupportSource: string,
): string {
  if (fact.category !== "procedure" || fact.procedureSteps === undefined) return factSupportSource;
  const parentSupportSentences = new Set(
    sourceSentences(factSupportSource).map((sentence) => normalizeForExactMatch(sentence)),
  );
  const parentGroundedSteps = fact.procedureSteps.filter((step) =>
    isGroundedCandidate(step.intent, factSupportSource, undefined, false),
  );
  if (parentGroundedSteps.length === 0) return factSupportSource;
  return sourceSentences(source)
    .filter((sentence) => {
      if (parentSupportSentences.has(normalizeForExactMatch(sentence))) return true;
      const sentenceTokens = tokenize(sentence);
      return parentGroundedSteps.some((step) =>
        [...tokenize(step.intent)].some((token) =>
          [...sentenceTokens].some((sourceToken) => areGroundingTokensCompatible(token, sourceToken)),
        ),
      );
    })
    .join(" ");
}
function filterGroundedFact(
  fact: ExtractionResult["facts"][number],
  source: string,
  assertionSource: string | undefined,
  roleAssertionSources: ExtractionGroundingRoleSources | undefined,
  eventTimeNormalizer: ((eventTime: string) => string) | undefined,
): ExtractionResult["facts"][number] | undefined {
  const factContext = selectGroundingContext(
    fact.content,
    resolveGroundingContext(fact.content, source, assertionSource, roleAssertionSources),
  );
  if (!isGroundedCandidate(
    fact.content,
    factContext.source,
    factContext.assertionSource,
    false,
    factContext.allowRoleNormalization,
  )) return undefined;
  const factEventTime = fact.eventTime;
  const groundedFactEventTime = factEventTime === undefined
    ? undefined
    : eventTimeNormalizer?.(factEventTime) ?? factEventTime;
  const factSupportingSentences = sourceSentences(factContext.assertionSource ?? factContext.source).filter(
    (sentence) =>
    isGroundedCandidate(
      fact.content,
      sentence,
      undefined,
      false,
      factContext.allowRoleNormalization,
    ),
  );
  const factSupportingSource = factEventTime === undefined
    ? factSupportingSentences[0]
    : factSupportingSentences.find((sentence) =>
      isGroundedCandidate(
        groundedFactEventTime ?? factEventTime,
        sentence,
        undefined,
        false,
        factContext.allowRoleNormalization,
      ),
    ) ?? factSupportingSentences[0];
  const eventTimeSource = factSupportingSource ?? factContext.source;
  const eventTimeAssertionSource = factSupportingSource === undefined
    ? factContext.assertionSource
    : undefined;

  const factSupportSource = buildFactSupportSource(
    factContext.assertionSource ?? factContext.source,
    factSupportingSentences,
  );
  const groundedAttributes = fact.structuredAttributes
    ? Object.fromEntries(
      Object.entries(fact.structuredAttributes)
        .filter(([key, value]) =>
          isGroundedCandidate(
            `${key}: ${value}`,
            factSupportSource,
            undefined,
            false,
            factContext.allowRoleNormalization,
          ),
        ),
    )
    : undefined;
  const procedureGroundingSource = buildProcedureSupportSource(
    fact,
    factContext.assertionSource ?? factContext.source,
    factSupportSource,
  );
  const groundedProcedureSteps = fact.procedureSteps
    ? fact.procedureSteps.flatMap((step) => {
      if (!isGroundedCandidate(step.intent, procedureGroundingSource, undefined, false)) return [];
      const expectedOutcome = step.expectedOutcome
        && isGroundedCandidate(step.expectedOutcome, procedureGroundingSource, undefined, false)
        ? step.expectedOutcome
        : undefined;
      const toolCall = step.toolCall
        && isGroundedCandidate(step.toolCall.signature, procedureGroundingSource, undefined, false)
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
    && isGroundedCandidate(
      fact.reasoningTrace.finalAnswer,
      factContext.source,
      factContext.assertionSource,
      false,
      factContext.allowRoleNormalization,
    )
    && fact.reasoningTrace.steps.every((step) =>
      isGroundedCandidate(
        step.description,
        factContext.source,
        factContext.assertionSource,
        false,
        factContext.allowRoleNormalization,
      ),
    )
    ? {
      steps: fact.reasoningTrace.steps,
      finalAnswer: fact.reasoningTrace.finalAnswer,
      ...(fact.reasoningTrace.observedOutcome
        && isGroundedCandidate(
          fact.reasoningTrace.observedOutcome,
          factContext.source,
          factContext.assertionSource,
          false,
          factContext.allowRoleNormalization,
        )
        ? { observedOutcome: fact.reasoningTrace.observedOutcome }
        : {}),
    }
    : undefined;
  const groundedEventTime = groundedFactEventTime
    && isGroundedCandidate(groundedFactEventTime, eventTimeSource, eventTimeAssertionSource)
    ? factEventTime
    : undefined;
  const groundedEntityRef = fact.entityRef !== undefined
    && isGroundedEntityName(fact.entityRef, factSupportSource)
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
  const entitySource = buildEntitySupportSource(entity.name, source);
  const entityAssertionSource = assertionSource === undefined
    ? undefined
    : buildEntitySupportSource(entity.name, assertionSource);
  const facts = entity.facts.filter((fact) =>
    isGroundedCandidate(fact, entitySource, entityAssertionSource),
  );
  const structuredSections = entity.structuredSections
    ?.flatMap((section) => {
      const groundedFacts = section.facts.filter((fact) =>
        isGroundedCandidate(fact, entitySource, entityAssertionSource),
      );
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
const GROUNDING_TEMPORAL_WORDS = new Set([
  "today",
  "yesterday",
  "tomorrow",
  "now",
  "recently",
  "earlier",
  "later",
  "soon",
  "morning",
  "afternoon",
  "evening",
  "tonight",
  "night",
  "noon",
  "midnight",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "q1",
  "q2",
  "q3",
  "q4",
]);
const GROUNDING_TEMPORAL_CLOCK_PATTERN = /\b\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?\b/iu;
const GROUNDING_TEMPORAL_DURATION_PATTERN = new RegExp(
  "\\b(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten)\\s+"
    + "(?:seconds?|minutes?|hours?|days?|weeks?|months?|quarters?|years?)\\b",
  "iu",
);

function isWhenQuestion(question: string): boolean {
  return /^(?:when|what\s+(?:time|date)|which\s+day)\b/iu.test(question.trim());
}
function isWhyQuestion(question: string): boolean {
  return /^why\b/iu.test(question.trim());
}

function hasCausalAnswerEvidence(question: string, sentence: string): boolean {
  if (!isWhyQuestion(question)) return true;
  return /\b(?:because|since|due\s+to|owing\s+to|thanks\s+to|therefore|thus|hence|so)\b/iu.test(
    sentence,
  );
}

function hasTemporalAnswerEvidence(question: string, sentence: string): boolean {
  if (!isWhenQuestion(question)) return true;
  return groundingLexemes(sentence).some(({ token }) =>
    GROUNDING_TEMPORAL_WORDS.has(token) || /^(?:19|20)\d{2}$/u.test(token),
  )
    || GROUNDING_TEMPORAL_CLOCK_PATTERN.test(sentence)
    || GROUNDING_TEMPORAL_DURATION_PATTERN.test(sentence);
}


function isUnknownAnswerSentence(sentence: string): boolean {
  return /\b(?:unknown|unclear|unsure|unresolved|unanswered|not\s+(?:known|sure|available)|don't\s+know|do\s+not\s+know|no\s+idea|pending)\b/iu
    .test(sentence);
}

function isYesNoAnswer(sentence: string): boolean {
  return /^(?:yes|no)(?:[.!?]|,\s*(?:absolutely|definitely|indeed|exactly|correct|of\s+course|use\s+that|do\s+that)[.!?]?)?$/iu
    .test(sentence.trim());
}

function hasWhAnswerRoleAlignment(question: string, sentence: string): boolean {
  const normalizedQuestion = question.trim();
  const objectQuestionMatch = /^(?:what|which)\s+.+?\s+(?:is|are|was|were|do|does|did|can|could|will|would|should|has|have|had)\s+(.+?)\s+([^\s?]+)\??$/iu
    .exec(normalizedQuestion);
  const sourceTokens = normalizedGroundingTokenSequence(sentence);
  if (objectQuestionMatch !== null) {
    const subjectTokens = groundingTokenSequence(objectQuestionMatch[1] ?? "");
    const predicateTokens = groundingTokenSequence(objectQuestionMatch[2] ?? "");
    if (subjectTokens.length === 0 || predicateTokens.length === 0) return true;
    let sourceIndex = 0;
    for (const token of [...subjectTokens, ...predicateTokens]) {
      const matchedIndex = sourceTokens.indexOf(token, sourceIndex);
      if (matchedIndex === -1) return false;
      sourceIndex = matchedIndex + 1;
    }
    return true;
  }

  const subjectQuestionMatch = /^(?:who|what)\s+([^\s?]+)\s+(.+?)\??$/iu.exec(normalizedQuestion);
  if (subjectQuestionMatch === null) return true;
  const predicateTokens = groundingTokenSequence(subjectQuestionMatch[1] ?? "");
  const objectTokens = groundingTokenSequence(subjectQuestionMatch[2] ?? "");
  if (predicateTokens.length === 0 || objectTokens.length === 0) return true;
  const predicateStart = sourceTokens.indexOf(predicateTokens[0]!);
  if (predicateStart === -1) return false;
  let sourceIndex = predicateStart + predicateTokens.length;
  for (const objectToken of objectTokens) {
    const objectIndex = sourceTokens.indexOf(objectToken, sourceIndex);
    if (objectIndex === -1) return false;
    sourceIndex = objectIndex + 1;
  }
  return true;
}

function isQuestionAnsweredBySource(
  question: string,
  source: string,
  assertionSource: string | undefined,
): boolean {
  const questionTokens = tokenize(question);
  if (questionTokens.size === 0) return false;
  const isYesNoQuestion = /^(?:is|are|am|was|were|do|does|did|can|could|will|would|should|has|have|had)\b/iu
    .test(question.trim());
  const assertedSentences = new Set(sourceSentences(assertionSource ?? source).map((sentence) => normalizeForExactMatch(sentence)));
  const sentences = sourceSentences(source);
  return sentences.some((sentence, index) => {
    if (!assertedSentences.has(normalizeForExactMatch(sentence))) return false;
    if (isInterrogativeSourceSentence(sentence)) return false;
    if (isYesNoAnswer(sentence)) {
      const precedingSentence = sentences[index - 1];
      return precedingSentence !== undefined
        && isInterrogativeSourceSentence(precedingSentence)
        && groundedTokenScore(question, precedingSentence) === 1;
    }
    if (isUnknownAnswerSentence(sentence)) return false;
    const score = groundedTokenScore(question, sentence, false);
    if (score !== 1) return false;
    const sentenceTokens = tokenize(sentence);
    const hasAnswerToken = [...sentenceTokens].some((token) => !questionTokens.has(token));
    return (isYesNoQuestion || hasAnswerToken)
      && hasTemporalAnswerEvidence(question, sentence)
      && hasCausalAnswerEvidence(question, sentence)
      && hasWhAnswerRoleAlignment(question, sentence);
  });
}

function groundQuestion(
  question: ExtractionResult["questions"][number],
  source: string,
  assertionSource: string | undefined,
): ExtractionResult["questions"][number] | undefined {
  if (isQuestionAnsweredBySource(question.question, source, assertionSource)) return undefined;
  if (!isGroundedCandidate(question.question, source, assertionSource, true)) return undefined;
  const normalizedContext = question.context.trim();
  if (
    normalizedContext.length > 0
    && !isGroundedCandidate(normalizedContext, assertionSource ?? source, undefined, false)
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
  eventTimeNormalizer?: (eventTime: string) => string,
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
    const grounded = filterGroundedFact(
      fact,
      source,
      assertionSource,
      roleAssertionSources,
      eventTimeNormalizer,
    );
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
