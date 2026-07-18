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
const ROTATION_ACTION_PATTERN =
  /\b(?:mint(?:s|ed|ing)?|creat(?:e|es|ed|ing)|issu(?:e|es|ed|ing)|rotat(?:e|es|ed|ing))\b/;
const NEGATION_PATTERN =
  /\b(?:do\s+not|does\s+not|don't|doesn't|never|must\s+not|should\s+not|cannot|can't|without|not|forbid(?:s|den)?|disallow(?:s|ed)?|prohibit(?:s|ed)?)\b/;
const POST_EXPIRY_REPLACEMENT_PATTERNS = [
  new RegExp(
    String.raw`\b(?:after|once|upon|following)\s+(?:(?:the|a)\s+(?:checkout\s+)?token\s+)?(?:explicit\s+)?${EXPIRY_SOURCE}\b[^.;:!?]{0,80}\b${REPLACEMENT_ACTION_SOURCE}\b[^.;:!?]{0,48}\b${COUNT_SOURCE}\b[^.;:!?]{0,32}\b${REPLACEMENT_OBJECT_SOURCE}\b`
  ),
  new RegExp(
    String.raw`\b${REPLACEMENT_ACTION_SOURCE}\b[^.;:!?]{0,48}\b${COUNT_SOURCE}\b[^.;:!?]{0,32}\b${REPLACEMENT_OBJECT_SOURCE}\b[^.;:!?]{0,48}\b(?:only\s+)?after\s+(?:(?:the|a)\s+(?:checkout\s+)?token\s+)?(?:explicit\s+)?${EXPIRY_SOURCE}\b`
  ),
];

function decisionClauses(value) {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .split(/[,.;:!?]+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function hasNegatedClause(clauses, targetPattern) {
  return clauses.some((clause) => targetPattern.test(clause) && NEGATION_PATTERN.test(clause));
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
  const matches = sessionLifecycle && positiveReuseLifecycle && postExpiryReplacement && !negatedRequiredBehavior;
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
  const rotatesEveryRequest = clauses.some(
    (clause) =>
      ROTATION_ACTION_PATTERN.test(clause) &&
      /\b(?:new\s+)?(?:checkout\s+)?token\b/.test(clause) &&
      /\bevery (?:checkout )?request\b/.test(clause) &&
      /\bevery (?:ordinary )?retr(?:y|ies)\b/.test(clause) &&
      !NEGATION_PATTERN.test(clause)
  );
  const negatedRotation = hasNegatedClause(clauses, ROTATION_ACTION_PATTERN);
  return rotatesEveryRequest && !negatedRotation ? RELAY_STALE_CHECKOUT_DECISION_CONTRACT_KEY : null;
}

export function assertRelayStaleCheckoutDecision(value, context) {
  const contractKey = relayStaleCheckoutDecisionContractKey(value);
  if (!contractKey) {
    throw new Error(`Relay ${context} decision does not match per-request and per-retry token rotation`);
  }
  return contractKey;
}
