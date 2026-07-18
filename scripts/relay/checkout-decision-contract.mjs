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
const PRE_EXPIRY_REPLACEMENT_OBJECT_PATTERN = new RegExp(
  String.raw`\b${PRE_EXPIRY_REPLACEMENT_OBJECT_SOURCE}\b`
);
const IMPLICIT_REPLACEMENT_ACTION_PATTERN =
  /\b(?:mint(?:s|ed|ing)?|refresh(?:es|ed|ing)?|replac(?:e|es|ed|ing)|renew(?:s|ed|ing)?|rotat(?:e|es|ed|ing)|regenerat(?:e|es|ed|ing))\b/;
const ADDITIONAL_REPLACEMENT_PATTERN =
  /\b(?:another|additional|extra|further|second|two|2|multiple|more\s+than\s+one)\b[^,.;:!?]{0,32}\b(?:replacements?|(?:(?:checkout[- ]session|checkout)\s+)?tokens?)\b|\b(?:again|twice)\b/;
const NO_REPLACEMENT_PATTERN =
  /\bno\s+(?:(?:additional|extra|further|second|new|replacement)\s+)?(?:(?:checkout[- ]session|checkout)\s+)?(?:replacements?|tokens?)\b/;
const ROTATION_ACTION_PATTERN =
  /\b(?:mint(?:s|ed|ing)?|creat(?:e|es|ed|ing)|issu(?:e|es|ed|ing)|rotat(?:e|es|ed|ing)|refresh(?:es|ed|ing)?|replac(?:e|es|ed|ing)|renew(?:s|ed|ing)?|regenerat(?:e|es|ed|ing))\b/;
const ROTATION_OBJECT_PATTERN =
  /\b(?:(?:new|fresh|replacement|current)\s+)?(?:(?:checkout[- ]session|checkout)\s+)?tokens?\b/;
const PER_REQUEST_ROTATION_PATTERN =
  /\b(?:(?:on|for|at|during|across)\s+)?(?:every|each|all)\s+(?:checkout\s+)?requests?\b|\bper[-\s]+(?:checkout\s+)?request\b/;
const PER_RETRY_ROTATION_PATTERN =
  /\b(?:including|on|for|during|across)\s+(?:(?:every|each|all)\s+)?(?:(?:ordinary|subsequent|later|failed)\s+)?retr(?:y|ies)(?:\s+attempts?)?\b|\b(?:every|each|all)\s+(?:(?:ordinary|subsequent|later|failed)\s+)?retr(?:y|ies)(?:\s+attempts?)?\b|\bper[-\s]+(?:(?:ordinary|subsequent|later|failed)\s+)?retr(?:y|ies)\b/;
const PREDICATE_CONJUNCTION_PATTERN =
  /\b(?:and|but|while|whereas|however)\b(?=\s+(?:after|once|upon|following|for|on|during|across|every|each|all|per|do|does|never|must|should|cannot|can't|without|not|avoid|reject|reuse|keep|use|mint|create|issue|rotate|refresh|replace|renew|regenerate)\b)/;
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
  return ROTATION_ACTION_PATTERN.test(clause) && ROTATION_OBJECT_PATTERN.test(clause);
}

function hasRotationTarget(clause) {
  return PER_REQUEST_ROTATION_PATTERN.test(clause) || PER_RETRY_ROTATION_PATTERN.test(clause);
}

function rotationPredicateClauses(clause) {
  return clause
    .split(PREDICATE_CONJUNCTION_PATTERN)
    .map((predicate) => predicate.trim())
    .filter(Boolean);
}

function isAffirmativeRotationClause(clause) {
  return (
    hasRotationActionAndObject(clause) &&
    hasRotationTarget(clause) &&
    !NEGATION_PATTERN.test(clause)
  );
}

function hasAffirmativeRotationPolicy(value) {
  return decisionClauseGroups(value).some((clauses) => {
    const predicateGroups = clauses.map(rotationPredicateClauses);
    if (predicateGroups.flat().some(isAffirmativeRotationClause)) return true;
    return predicateGroups.some((predicates, index) => {
      const nextPredicates = predicateGroups[index + 1];
      if (!nextPredicates) return false;
      return predicates.some((predicate) =>
        nextPredicates.some((nextPredicate) => {
          if (NEGATION_PATTERN.test(predicate) || NEGATION_PATTERN.test(nextPredicate)) return false;
          return (
            (hasRotationActionAndObject(predicate) && hasRotationTarget(nextPredicate)) ||
            (hasRotationTarget(predicate) && hasRotationActionAndObject(nextPredicate))
          );
        })
      );
    });
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
    .some(isAffirmativeAdditionalReplacementClause);
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
  const matches =
    sessionLifecycle &&
    positiveReuseLifecycle &&
    postExpiryReplacement &&
    !negatedRequiredBehavior &&
    !contradictoryPerUseRotation &&
    !contradictoryPreExpiryReplacement &&
    !contradictoryAdditionalReplacement;
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
