import path from "node:path";

export const RELAY_CANONICAL_CHECKOUT_DECISION =
  "Reuse the checkout-session token while it is valid and mint exactly one replacement only after expiry.";

export const RELAY_CHECKOUT_DECISION_CONTRACT_KEY = "checkout-session-reuse-one-post-expiry-replacement";

const AUTHORITATIVE_SOURCE_LOCATORS = new Set([
  "CONTRACT.md",
  "src/reference-token-policy.mjs",
  "test/token-policy.contract.test.mjs",
]);

export function normalizeRelaySourceLocator(value: string): string {
  const withoutLocator = value.trim().replace(/:\d+(?:-\d+)?$/, "");
  const candidate = withoutLocator.replace(/^\.\//, "").replaceAll("\\", "/");
  const normalized = path.posix.normalize(candidate);
  if (
    !candidate ||
    normalized !== candidate ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Relay evidence locator must be a canonical repository-relative path: ${value}`);
  }
  return normalized;
}

export function relayCheckoutDecisionContractKey(value: string): string | null {
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

export function assertRelayCheckoutDecision(value: string, context: string): string {
  const contractKey = relayCheckoutDecisionContractKey(value);
  if (!contractKey) {
    throw new Error(`Relay ${context} decision does not match checkout-session reuse and one post-expiry replacement`);
  }
  return contractKey;
}

export function assertRelaySourceLocators(locators: string[], context: string): string[] {
  const normalized = locators.map(normalizeRelaySourceLocator);
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`Relay ${context} source grounding contains duplicate locators`);
  }
  for (const locator of normalized) {
    if (!AUTHORITATIVE_SOURCE_LOCATORS.has(locator)) {
      throw new Error(`Relay ${context} source grounding cites a non-authoritative fixture path: ${locator}`);
    }
  }
  if (!normalized.includes("CONTRACT.md")) {
    throw new Error(`Relay ${context} source grounding must cite the authoritative CONTRACT.md`);
  }
  if (
    !["src/reference-token-policy.mjs", "test/token-policy.contract.test.mjs"].some((item) => normalized.includes(item))
  ) {
    throw new Error(`Relay ${context} source grounding must cite executable reference code or its contract test`);
  }
  return normalized;
}
