export const RELAY_CANONICAL_CHECKOUT_DECISION =
  "Reuse the checkout-session token while it is valid and mint exactly one replacement only after expiry.";

export const RELAY_CHECKOUT_DECISION_CONTRACT_KEY = "checkout-session-reuse-one-post-expiry-replacement";
export const RELAY_STALE_CHECKOUT_DECISION_CONTRACT_KEY = "checkout-token-per-request-and-retry-rotation";

export function relayCheckoutDecisionContractKey(value) {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  const sessionLifecycle =
    /session/.test(normalized) ||
    (/(?:first|initial) (?:checkout )?request/.test(normalized) &&
      /(?:ordinary )?retr(?:y|ies)/.test(normalized) &&
      /(?:current|unexpired|valid) (?:checkout )?token/.test(normalized));
  const matches =
    /reus(?:e|es|ed|ing)/.test(normalized) &&
    sessionLifecycle &&
    /expir(?:y|ed|es|ation)/.test(normalized) &&
    /(one|exactly 1|single)/.test(normalized) &&
    /(mint|replacement|refresh)/.test(normalized);
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
  const normalized = value.toLowerCase();
  const rotatesEveryRequest =
    /(?:mint|create|issue|rotate).{0,80}(?:new )?(?:checkout )?token/.test(normalized) &&
    /every (?:checkout )?request/.test(normalized) &&
    /every (?:ordinary )?retr(?:y|ies)/.test(normalized);
  return rotatesEveryRequest ? RELAY_STALE_CHECKOUT_DECISION_CONTRACT_KEY : null;
}

export function assertRelayStaleCheckoutDecision(value, context) {
  const contractKey = relayStaleCheckoutDecisionContractKey(value);
  if (!contractKey) {
    throw new Error(`Relay ${context} decision does not match per-request and per-retry token rotation`);
  }
  return contractKey;
}
