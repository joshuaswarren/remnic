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
      && /^(?:suppose|assuming|maybe|perhaps|hypothetically|if|whether|is|are|am|was|were|do|does|did|can|could|will|would|should|has|have|had|what|which|when|where|why|how|who)\b/iu.test(
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
