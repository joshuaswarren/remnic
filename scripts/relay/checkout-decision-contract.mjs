export const RELAY_CANONICAL_CHECKOUT_DECISION =
  "Reuse the checkout-session token while it is valid and mint exactly one replacement only after expiry.";

export const RELAY_CHECKOUT_DECISION_CONTRACT_KEY = "checkout-session-reuse-one-post-expiry-replacement";
export const RELAY_STALE_CHECKOUT_DECISION_CONTRACT_KEY = "checkout-token-per-request-and-retry-rotation";

const REUSE_PATTERN = /\breus(?:e|es|ed|ing)\b/;
const RETRY_PATTERN = /\b(?:(?:ordinary|subsequent|later)\s+)?retr(?:y|ies)\b/;
const VALIDITY_PATTERN = /\bwhile\b[^,.;:!?]{0,32}\bvalid\b|\b(?:current|unexpired|valid)\s+(?:checkout\s+)?token\b/;
const EXPIRY_SOURCE = String.raw`expir(?:y|ed|es|ation)`;
const COUNT_SOURCE = String.raw`(?:exactly\s+(?:one|1)|one|a\s+single|single)`;
const REPLACEMENT_ACTION_SOURCE = String.raw`(?:mint(?:s|ed|ing)?|creat(?:e|es|ed|ing)|issu(?:e|es|ed|ing)|refresh(?:es|ed|ing)?|replac(?:e|es|ed|ing))`;
const REPLACEMENT_OBJECT_SOURCE = String.raw`(?:replacement|(?:new\s+)?(?:checkout\s+)?token)`;
const PRE_EXPIRY_REPLACEMENT_OBJECT_SOURCE = String.raw`(?:replacement|(?:(?:new|fresh|current|existing|replacement)\s+)?(?:(?:checkout[- ]session|checkout)\s+)?token)`;
const PRE_EXPIRY_TIMING_SOURCE = String.raw`(?:pre[-\s]?expir(?:y|ation)|(?:before|prior\s+to|ahead\s+of)\s+(?:(?:the|a|its|it)\s+)?(?:(?:checkout[- ]session|checkout)\s+)?(?:token(?:'s)?\s+)?(?:explicit\s+)?${EXPIRY_SOURCE})`;
const REPLACEMENT_ACTION_PATTERN = new RegExp(String.raw`\b${REPLACEMENT_ACTION_SOURCE}\b`);
const PRE_EXPIRY_REPLACEMENT_OBJECT_PATTERN = new RegExp(String.raw`\b${PRE_EXPIRY_REPLACEMENT_OBJECT_SOURCE}\b`);
const IMPLICIT_REPLACEMENT_ACTION_PATTERN =
  /\b(?:mint(?:s|ed|ing)?|refresh(?:es|ed|ing)?|replac(?:e|es|ed|ing)|renew(?:s|ed|ing)?|rotat(?:e|es|ed|ing)|regenerat(?:e|es|ed|ing))\b/;
const ADDITIONAL_REPLACEMENT_PATTERN =
  /\b(?:another|additional|extra|further|second|two|2|multiple|more\s+than\s+one)\b[^,.;:!?]{0,32}\b(?:replacements?|(?:(?:checkout[- ]session|checkout)\s+)?tokens?)\b|\b(?:again|twice)\b/;
const NO_REPLACEMENT_PATTERN =
  /\bno\s+(?:(?:additional|extra|further|second|new|replacement)\s+)?(?:(?:checkout[- ]session|checkout)\s+)?(?:replacements?|tokens?)\b/;
const ROTATION_ACTION_PATTERN =
  /\b(?:mint(?:s|ed|ing)?|creat(?:e|es|ed|ing)|issu(?:e|es|ed|ing)|generat(?:e|es|ed|ing)|provision(?:s|ed|ing)?|allocat(?:e|es|ed|ing)|rotat(?:e|es|ed|ing)|refresh(?:es|ed|ing)?|replac(?:e|es|ed|ing)|renew(?:s|ed|ing)?|regenerat(?:e|es|ed|ing))\b/;
const ROTATION_OBJECT_PATTERN =
  /\b(?:(?:new|fresh|replacement|current)\s+)?(?:(?:checkout[- ]session|checkout)\s+)?tokens?\b/;
const ANAPHORIC_TOKEN_OBJECT_PATTERN =
  /\b(?:(?:(?:a|the)\s+)?(?:new|fresh|replacement|additional|second|next)\s+one|another(?:\s+one)?|one(?:\s+more)?|anew|(?:it|this|that)(?:\s+one)?|(?:something|anything)\s+(?:new|fresh|different|separate|distinct|alternate)|(?:(?:a|the)\s+)?(?:new|fresh|different|distinct|alternate|separate|replacement|another)\s+(?:value|object|item|thing|secret|identifier|id|handle))\b(?=\s*(?:$|\b(?:on|for|during|across|after|before|prior|ahead|while|when|per|at|each|every)\b))/;
const TOKEN_LIFECYCLE_TARGET_PATTERN =
  /\b(?:replacements?|(?:(?:new|fresh|current|existing|valid|unexpired|expired|replacement)\s+)?(?:(?:checkout[- ]session|checkout|session|access|auth(?:entication|orization)?)\s+)?(?:tokens?|credentials?)|(?:(?:checkout|session)\s+)?keys?|it|this|that)\b/;
const CHECKOUT_SESSION_LIFECYCLE_TARGET_PATTERN = /\b(?:checkout[- ]session|session)\b/;
const DESTRUCTIVE_SESSION_ACTION_PATTERN =
  /\b(?:abort(?:s|ed|ing)?|blacklist(?:s|ed|ing)?|cancel(?:s|ed|ing|led|ling)?|clos(?:e|es|ed|ing)|deactivat(?:e|es|ed|ing)|delet(?:e|es|ed|ing)|destroy(?:s|ed|ing)?|disabl(?:e|es|ed|ing)|discard(?:s|ed|ing)?|drop(?:s|ped|ping)?|end(?:s|ed|ing)?|eras(?:e|es|ed|ing)|expir(?:e|es|ed|ing)|invalidat(?:e|es|ed|ing)|nullif(?:y|ies|ied|ying)|purg(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|reset(?:s|ting)?|retir(?:e|es|ed|ing)|revok(?:e|es|ed|ing)|terminat(?:e|es|ed|ing)|void(?:s|ed|ing)?|wipe(?:s|d|ing)?)\b/;
const OBJECTLESS_ROTATION_FILLER_PATTERN =
  /\b(?:a|an|the|then|we|system|agent|keep|keeps|keeping|continue|continues|continued|continuing|to|will|would|should|must|can|could|may|might|always|more|again|another|additional|extra|several|multiple|many|twice|two|2|batch|batches|anew|afresh|repeatedly|repetitively|continuously|indefinitely|endlessly)\b/g;
const OBJECTLESS_ADDITIONAL_ROTATION_PATTERN =
  /\b(?:keep|keeps|keeping|continue|continues|continued|continuing|always|more|again|another|additional|extra|several|multiple|many|twice|two|2|batch|batches|repeatedly|repetitively|continuously|indefinitely|endlessly)\b/;
const EXPLICIT_ROTATION_CADENCE_PATTERN = /\b(?:every|each|all)\b|\bper[-\s]+/;
const ALLOWED_REUSE_CLAUSE_PATTERN =
  /^(?:then\s+)?reuse\s+(?:(?:the\s+)?(?:(?:current|existing|valid|unexpired)\s+)?(?:(?:checkout[- ]session|checkout|session)\s+)?token|(?:it|this|that)(?:\s+replacement)?|(?:the\s+)?replacement)(?:\s+(?:for|on|during|across)\s+(?:(?:every|each|all)\s+)?(?:(?:checkout\s+)?requests?|(?:(?:ordinary|subsequent|later|failed)\s+)?retr(?:y|ies)(?:\s+attempts?)?))?(?:\s+while\s+(?:it\s+is\s+)?valid)?$/;
const ALLOWED_INITIAL_TOKEN_MINT_CLAUSE_PATTERN =
  /^(?:mint|create|issue)\s+(?:(?:exactly\s+)?one\s+|a\s+|the\s+)?(?:(?:new|initial|first)\s+)?(?:(?:checkout[- ]session|checkout)\s+)?token\s+(?:on|for|at)\s+(?:the\s+)?(?:first|initial)\s+(?:checkout\s+)?request$/;
const ALLOWED_POST_EXPIRY_REPLACEMENT_PATTERNS = [
  new RegExp(
    String.raw`^(?:after|once|upon|following)\s+(?:(?:the|a)\s+(?:checkout\s+)?token\s+)?(?:explicit\s+)?${EXPIRY_SOURCE}\s+${REPLACEMENT_ACTION_SOURCE}\s+${COUNT_SOURCE}\s+(?:replacement(?:\s+token)?|(?:new\s+)?(?:checkout\s+)?token)(?:\s+that\s+(?:later|subsequent)\s+retr(?:y|ies)\s+reuse)?$`
  ),
  new RegExp(
    String.raw`^${REPLACEMENT_ACTION_SOURCE}\s+${COUNT_SOURCE}\s+(?:replacement(?:\s+token)?|(?:new\s+)?(?:checkout\s+)?token)\s+(?:only\s+)?after\s+(?:(?:the|a)\s+(?:checkout\s+)?token\s+)?(?:explicit\s+)?${EXPIRY_SOURCE}(?:\s+that\s+(?:later|subsequent)\s+retr(?:y|ies)\s+reuse)?$`
  ),
];
const ALLOWED_TOKEN_OWNERSHIP_PATTERNS = [
  /^(?:one|a\s+single|single)\s+(?:checkout\s+)?(?:token|credential|key)\s+(?:is\s+)?(?:owned|bound|scoped|assigned)\s+(?:per|to)\s+(?:(?:each|the)\s+)?(?:checkout\s+)?session$/,
  /^(?:(?:each|the)\s+)?(?:checkout\s+)?session\s+(?:owns|has|holds)\s+(?:one|a\s+single|single)\s+(?:checkout\s+)?(?:token|credential|key)$/,
];
const ALLOWED_NATURAL_TOKEN_EXPIRY_PATTERNS = [
  /^(?:let|allow)\s+(?:the\s+)?(?:(?:checkout[- ]session|checkout|session)\s+)?(?:token|credential|key)\s+(?:to\s+)?expir(?:e|es)\s+naturally$/,
  /^(?:the\s+)?(?:(?:checkout[- ]session|checkout|session)\s+)?(?:token|credential|key)\s+expir(?:e|es)\s+naturally$/,
];
const ALLOWED_NEGATED_TOKEN_SAFETY_CLAUSES = new Set([
  "do not rotate tokens on every request",
  "do not mint a new token on every retry",
  "avoid issuing a fresh checkout token",
  "do not mint another replacement before expiry",
  "never refresh the checkout token prior to expiry",
  "the checkout token must not be replaced before it expires",
  "do not mint again while the checkout token is still valid",
  "never rotate the checkout token during its validity",
  "do not refresh the checkout token early",
  "never renew the checkout token prematurely",
  "avoid rotating the checkout token ahead of time",
  "do not issue a fresh checkout token in advance",
  "never preemptively mint a replacement token",
  "do not proactively create a fresh checkout token",
  "do not revoke the checkout token while it is valid",
  "never invalidate the current checkout token",
  "do not delete the checkout-session token before expiry",
  "never disable the checkout token on an ordinary retry",
  "do not force the checkout token to expire early",
  "never mark the checkout token invalid while valid",
  "do not mint another token after expiry",
  "never issue a second replacement after expiry",
  "do not refresh the checkout token again after expiry",
  "no additional checkout tokens are minted after expiry",
]);
const PER_REQUEST_ROTATION_PATTERN =
  /\b(?:(?:on|for|at|during|across)\s+)?(?:every|each|all)\s+(?:checkout\s+)?requests?\b|\bper[-\s]+(?:checkout\s+)?request\b/;
const PER_RETRY_ROTATION_PATTERN =
  /\b(?:including|on|for|during|across)\s+(?:(?:every|each|all)\s+)?(?:(?:ordinary|subsequent|later|failed)\s+)?retr(?:y|ies)(?:\s+attempts?)?\b|\b(?:every|each|all)\s+(?:(?:ordinary|subsequent|later|failed)\s+)?retr(?:y|ies)(?:\s+attempts?)?\b|\bper[-\s]+(?:(?:ordinary|subsequent|later|failed)\s+)?retr(?:y|ies)\b/;
const PREDICATE_CONJUNCTION_PATTERN =
  /\b(?:and|but|whereas|however)\b|\bwhile\b(?=\s+(?:after|once|upon|following|for|on|during|across|every|each|all|per|do|does|never|must|should|cannot|can't|without|not|avoid|reject|reuse|keep|use|mint|create|issue|rotate|refresh|replace|renew|regenerate)\b)/;
const NEGATION_PATTERN =
  /\b(?:do\s+not|does\s+not|don't|doesn't|never|must\s+not|should\s+not|cannot|can't|without|not|forbid(?:s|den)?|disallow(?:s|ed)?|prohibit(?:s|ed)?|avoid(?:s|ed|ing)?|reject(?:s|ed|ing)?|rather\s+than|instead\s+of)\b/;
const POST_EXPIRY_REPLACEMENT_PATTERNS = [
  new RegExp(
    String.raw`\b(?:after|once|upon|following)\s+(?:(?:the|a)\s+(?:checkout\s+)?token\s+)?(?:explicit\s+)?${EXPIRY_SOURCE}\b[^.;:!?]{0,80}\b${REPLACEMENT_ACTION_SOURCE}\b[^.;:!?]{0,48}\b${COUNT_SOURCE}\b[^.;:!?]{0,32}\b${REPLACEMENT_OBJECT_SOURCE}\b`
  ),
  new RegExp(
    String.raw`\b${REPLACEMENT_ACTION_SOURCE}\b[^.;:!?]{0,48}\b${COUNT_SOURCE}\b[^.;:!?]{0,32}\b${REPLACEMENT_OBJECT_SOURCE}\b[^.;:!?]{0,48}\b(?:only\s+)?after\s+(?:(?:the|a)\s+(?:checkout\s+)?token\s+)?(?:explicit\s+)?${EXPIRY_SOURCE}\b`
  ),
];
const PRE_EXPIRY_TIMING_PATTERNS = [
  new RegExp(String.raw`\b${PRE_EXPIRY_TIMING_SOURCE}\b`),
  /\b(?:while|when)\b[^.;:!?]{0,48}\b(?:valid|unexpired)\b/,
  /\bduring\b[^.;:!?]{0,48}\bvalidity\b/,
];
const POST_EXPIRY_TIMING_PATTERN = new RegExp(
  String.raw`\b(?:after|once|upon|following)\s+(?:(?:the|a)\s+(?:checkout\s+)?token\s+)?(?:explicit\s+)?${EXPIRY_SOURCE}\b`
);

function decisionClauseGroups(value) {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .split(/[.;:!?]+/)
    .map((statement) =>
      statement
        .split(/,+/)
        .map((clause) => clause.trim())
        .filter(Boolean)
    )
    .filter((clauses) => clauses.length > 0);
}

function decisionClauses(value) {
  return decisionClauseGroups(value).flat();
}

function hasRotationActionAndObject(clause) {
  return (
    ROTATION_ACTION_PATTERN.test(clause) &&
    (ROTATION_OBJECT_PATTERN.test(clause) || ANAPHORIC_TOKEN_OBJECT_PATTERN.test(clause))
  );
}

function hasObjectlessRotationAction(clause) {
  if (
    ROTATION_OBJECT_PATTERN.test(clause) ||
    ANAPHORIC_TOKEN_OBJECT_PATTERN.test(clause) ||
    PRE_EXPIRY_REPLACEMENT_OBJECT_PATTERN.test(clause) ||
    !ROTATION_ACTION_PATTERN.test(clause)
  ) {
    return false;
  }
  const residual = clause
    .replace(PER_REQUEST_ROTATION_PATTERN, " ")
    .replace(PER_RETRY_ROTATION_PATTERN, " ")
    .replace(ROTATION_ACTION_PATTERN, " ")
    .replace(OBJECTLESS_ROTATION_FILLER_PATTERN, " ")
    .replace(/[\s-]+/g, "");
  return residual.length === 0;
}

function hasRotationActionSignal(clause) {
  return hasRotationActionAndObject(clause) || hasObjectlessRotationAction(clause);
}

function hasTokenLifecycleTarget(clause) {
  return TOKEN_LIFECYCLE_TARGET_PATTERN.test(clause) || ANAPHORIC_TOKEN_OBJECT_PATTERN.test(clause);
}

function hasRotationTarget(clause) {
  return PER_REQUEST_ROTATION_PATTERN.test(clause) || PER_RETRY_ROTATION_PATTERN.test(clause);
}

function hasExplicitRotationCadence(clause) {
  return hasRotationTarget(clause) && EXPLICIT_ROTATION_CADENCE_PATTERN.test(clause);
}

function rotationPredicateClauses(clause) {
  return clause
    .split(PREDICATE_CONJUNCTION_PATTERN)
    .map((predicate) => predicate.trim())
    .filter(Boolean);
}

function isAffirmativeRotationClause(clause) {
  return hasRotationActionSignal(clause) && hasRotationTarget(clause) && !NEGATION_PATTERN.test(clause);
}

function hasAffirmativeRotationPolicy(value) {
  const groupedMatch = decisionClauseGroups(value).some((clauses) => {
    const predicateGroups = clauses.map(rotationPredicateClauses);
    if (predicateGroups.flat().some(isAffirmativeRotationClause)) return true;
    return predicateGroups.some((predicates, index) => {
      const nextPredicates = predicateGroups[index + 1];
      if (!nextPredicates) return false;
      return predicates.some((predicate) =>
        nextPredicates.some((nextPredicate) => {
          if (NEGATION_PATTERN.test(predicate) || NEGATION_PATTERN.test(nextPredicate)) return false;
          return (
            (hasRotationActionSignal(predicate) && hasRotationTarget(nextPredicate)) ||
            (hasRotationTarget(predicate) && hasRotationActionSignal(nextPredicate))
          );
        })
      );
    });
  });
  if (groupedMatch) return true;

  const clauses = decisionClauses(value);
  return clauses.some((clause, index) => {
    const nextClause = clauses[index + 1];
    if (!nextClause || NEGATION_PATTERN.test(clause) || NEGATION_PATTERN.test(nextClause)) return false;
    return (
      (hasExplicitRotationCadence(clause) && hasObjectlessRotationAction(nextClause)) ||
      (hasObjectlessRotationAction(clause) && hasExplicitRotationCadence(nextClause))
    );
  });
}

function hasPreExpiryTiming(clause) {
  return PRE_EXPIRY_TIMING_PATTERNS.some((pattern) => pattern.test(clause));
}

function hasExplicitReplacementActionAndObject(clause) {
  return REPLACEMENT_ACTION_PATTERN.test(clause) && PRE_EXPIRY_REPLACEMENT_OBJECT_PATTERN.test(clause);
}

function hasReplacementActionSignal(clause) {
  return hasExplicitReplacementActionAndObject(clause) || IMPLICIT_REPLACEMENT_ACTION_PATTERN.test(clause);
}

function hasPostExpiryTiming(clause) {
  return POST_EXPIRY_TIMING_PATTERN.test(clause);
}

function hasReplacementPolicyNegation(clause) {
  return NEGATION_PATTERN.test(clause) || NO_REPLACEMENT_PATTERN.test(clause);
}

function isAffirmativePostExpiryReplacementClause(clause) {
  return !hasReplacementPolicyNegation(clause) && hasPostExpiryTiming(clause) && hasReplacementActionSignal(clause);
}

function isAffirmativeAdditionalReplacementClause(clause) {
  return (
    !hasReplacementPolicyNegation(clause) &&
    hasReplacementActionSignal(clause) &&
    ADDITIONAL_REPLACEMENT_PATTERN.test(clause)
  );
}

function postExpiryReplacementSignalCount(value) {
  let count = 0;
  for (const clauses of decisionClauseGroups(value)) {
    const predicateGroups = clauses.map(rotationPredicateClauses);
    count += predicateGroups.flat().filter(isAffirmativePostExpiryReplacementClause).length;
    for (const [index, predicates] of predicateGroups.entries()) {
      const nextPredicates = predicateGroups[index + 1];
      if (!nextPredicates) continue;
      const crossClauseSignal = predicates.some((predicate) =>
        nextPredicates.some((nextPredicate) => {
          if (
            hasReplacementPolicyNegation(predicate) ||
            hasReplacementPolicyNegation(nextPredicate) ||
            isAffirmativePostExpiryReplacementClause(predicate) ||
            isAffirmativePostExpiryReplacementClause(nextPredicate)
          ) {
            return false;
          }
          const timingFirst =
            hasPostExpiryTiming(predicate) &&
            !hasPreExpiryTiming(predicate) &&
            hasReplacementActionSignal(nextPredicate) &&
            !hasPreExpiryTiming(nextPredicate);
          const actionFirst =
            hasExplicitReplacementActionAndObject(predicate) &&
            !hasPreExpiryTiming(predicate) &&
            hasPostExpiryTiming(nextPredicate) &&
            !hasPreExpiryTiming(nextPredicate);
          return timingFirst || actionFirst;
        })
      );
      if (crossClauseSignal) count += 1;
    }
  }
  return count;
}

function hasAffirmativeAdditionalReplacementPolicy(value) {
  return decisionClauseGroups(value)
    .flatMap((clauses) => clauses.flatMap(rotationPredicateClauses))
    .some(
      (clause) =>
        isAffirmativeAdditionalReplacementClause(clause) ||
        (!hasReplacementPolicyNegation(clause) &&
          OBJECTLESS_ADDITIONAL_ROTATION_PATTERN.test(clause) &&
          hasObjectlessRotationAction(clause))
    );
}

function isAllowedInitialTokenMintClause(clause) {
  return ALLOWED_INITIAL_TOKEN_MINT_CLAUSE_PATTERN.test(clause);
}

function isAllowedPostExpiryReplacementClause(clause) {
  return ALLOWED_POST_EXPIRY_REPLACEMENT_PATTERNS.some((pattern) => pattern.test(clause));
}

function isAllowedReuseClause(clause) {
  return ALLOWED_REUSE_CLAUSE_PATTERN.test(clause);
}

function isAllowedTokenOwnershipClause(clause) {
  return ALLOWED_TOKEN_OWNERSHIP_PATTERNS.some((pattern) => pattern.test(clause));
}

function isAllowedNaturalTokenExpiryClause(clause) {
  return ALLOWED_NATURAL_TOKEN_EXPIRY_PATTERNS.some((pattern) => pattern.test(clause));
}

function isAllowedAffirmativeTokenLifecycleClause(clause) {
  return (
    isAllowedReuseClause(clause) ||
    isAllowedInitialTokenMintClause(clause) ||
    isAllowedPostExpiryReplacementClause(clause) ||
    isAllowedTokenOwnershipClause(clause) ||
    isAllowedNaturalTokenExpiryClause(clause)
  );
}

function isAffirmativeDestructiveCheckoutSessionClause(clause) {
  return (
    !hasReplacementPolicyNegation(clause) &&
    CHECKOUT_SESSION_LIFECYCLE_TARGET_PATTERN.test(clause) &&
    DESTRUCTIVE_SESSION_ACTION_PATTERN.test(clause)
  );
}

function hasUnrecognizedAffirmativeTokenMutationPolicy(value) {
  return decisionClauseGroups(value)
    .flatMap((clauses) => clauses.flatMap(rotationPredicateClauses))
    .some((predicate) => {
      if (isAffirmativeDestructiveCheckoutSessionClause(predicate)) return true;
      if (!hasTokenLifecycleTarget(predicate)) return false;
      if (hasReplacementPolicyNegation(predicate)) {
        return !ALLOWED_NEGATED_TOKEN_SAFETY_CLAUSES.has(predicate);
      }
      return !isAllowedAffirmativeTokenLifecycleClause(predicate);
    });
}

function isAffirmativePreExpiryReplacementClause(clause) {
  return !NEGATION_PATTERN.test(clause) && hasPreExpiryTiming(clause) && hasReplacementActionSignal(clause);
}

function hasAffirmativePreExpiryReplacementPolicy(value) {
  return decisionClauseGroups(value).some((clauses) => {
    const predicateGroups = clauses.map(rotationPredicateClauses);
    if (predicateGroups.flat().some(isAffirmativePreExpiryReplacementClause)) return true;
    return predicateGroups.some((predicates, index) => {
      const nextPredicates = predicateGroups[index + 1];
      if (!nextPredicates) return false;
      return predicates.some((predicate) =>
        nextPredicates.some((nextPredicate) => {
          if (NEGATION_PATTERN.test(predicate) || NEGATION_PATTERN.test(nextPredicate)) return false;
          const timingFirst =
            hasPreExpiryTiming(predicate) &&
            !POST_EXPIRY_TIMING_PATTERN.test(predicate) &&
            hasReplacementActionSignal(nextPredicate) &&
            !POST_EXPIRY_TIMING_PATTERN.test(nextPredicate);
          const actionFirst =
            hasExplicitReplacementActionAndObject(predicate) &&
            !POST_EXPIRY_TIMING_PATTERN.test(predicate) &&
            hasPreExpiryTiming(nextPredicate) &&
            !POST_EXPIRY_TIMING_PATTERN.test(nextPredicate);
          return timingFirst || actionFirst;
        })
      );
    });
  });
}

export function relayCheckoutDecisionContractKey(value) {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  const clauses = decisionClauses(value);
  const sessionLifecycle =
    /\bsession\b/.test(normalized) ||
    (/(?:first|initial) (?:checkout )?request/.test(normalized) &&
      /(?:ordinary )?retr(?:y|ies)/.test(normalized) &&
      /(?:current|unexpired|valid) (?:checkout )?token/.test(normalized));
  const positiveReuseLifecycle = clauses.some(
    (clause) =>
      REUSE_PATTERN.test(clause) &&
      (RETRY_PATTERN.test(clause) || VALIDITY_PATTERN.test(clause) || /\bsession\b/.test(clause)) &&
      !NEGATION_PATTERN.test(clause)
  );
  const postExpiryReplacement = clauses.some(
    (clause) =>
      POST_EXPIRY_REPLACEMENT_PATTERNS.some((pattern) => pattern.test(clause)) && !NEGATION_PATTERN.test(clause)
  );
  const negatedRequiredBehavior = clauses.some(
    (clause) =>
      NEGATION_PATTERN.test(clause) &&
      ((REUSE_PATTERN.test(clause) &&
        (RETRY_PATTERN.test(clause) || VALIDITY_PATTERN.test(clause) || /\bsession\b/.test(clause))) ||
        POST_EXPIRY_REPLACEMENT_PATTERNS.some((pattern) => pattern.test(clause)))
  );
  const contradictoryPerUseRotation = hasAffirmativeRotationPolicy(value);
  const contradictoryPreExpiryReplacement = hasAffirmativePreExpiryReplacementPolicy(value);
  const contradictoryAdditionalReplacement =
    hasAffirmativeAdditionalReplacementPolicy(value) || postExpiryReplacementSignalCount(value) > 1;
  const unrecognizedAffirmativeTokenMutation = hasUnrecognizedAffirmativeTokenMutationPolicy(value);
  const matches =
    sessionLifecycle &&
    positiveReuseLifecycle &&
    postExpiryReplacement &&
    !negatedRequiredBehavior &&
    !contradictoryPerUseRotation &&
    !contradictoryPreExpiryReplacement &&
    !contradictoryAdditionalReplacement &&
    !unrecognizedAffirmativeTokenMutation;
  return matches ? RELAY_CHECKOUT_DECISION_CONTRACT_KEY : null;
}

export function assertRelayCheckoutDecision(value, context) {
  const contractKey = relayCheckoutDecisionContractKey(value);
  if (!contractKey) {
    throw new Error(`Relay ${context} decision does not match checkout-session reuse and one post-expiry replacement`);
  }
  return contractKey;
}

export function relayStaleCheckoutDecisionContractKey(value) {
  if (typeof value !== "string") return null;
  const clauses = decisionClauses(value);
  const rotatesEveryUse = hasAffirmativeRotationPolicy(value);
  const statesCompleteCanonicalPolicy =
    clauses.some(
      (clause) =>
        REUSE_PATTERN.test(clause) &&
        (RETRY_PATTERN.test(clause) || VALIDITY_PATTERN.test(clause) || /\bsession\b/.test(clause)) &&
        !NEGATION_PATTERN.test(clause)
    ) &&
    clauses.some(
      (clause) =>
        POST_EXPIRY_REPLACEMENT_PATTERNS.some((pattern) => pattern.test(clause)) && !NEGATION_PATTERN.test(clause)
    );
  return rotatesEveryUse && !statesCompleteCanonicalPolicy ? RELAY_STALE_CHECKOUT_DECISION_CONTRACT_KEY : null;
}

export function assertRelayStaleCheckoutDecision(value, context) {
  const contractKey = relayStaleCheckoutDecisionContractKey(value);
  if (!contractKey) {
    throw new Error(`Relay ${context} decision does not match per-request and per-retry token rotation`);
  }
  return contractKey;
}
