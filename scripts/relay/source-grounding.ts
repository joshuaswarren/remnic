import path from "node:path";

export {
  RELAY_CANONICAL_CHECKOUT_DECISION,
  RELAY_CHECKOUT_DECISION_CONTRACT_KEY,
  RELAY_STALE_CHECKOUT_DECISION_CONTRACT_KEY,
  assertRelayCheckoutDecision,
  assertRelayStaleCheckoutDecision,
  relayCheckoutDecisionContractKey,
  relayStaleCheckoutDecisionContractKey,
} from "./checkout-decision-contract.mjs";

export const RELAY_AUTHORITATIVE_SOURCE_LOCATORS = [
  "CONTRACT.md",
  "src/reference-token-policy.mjs",
  "test/token-policy.contract.test.mjs",
] as const;
const AUTHORITATIVE_SOURCE_LOCATORS = new Set<string>(RELAY_AUTHORITATIVE_SOURCE_LOCATORS);

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

export function assertRelaySourceLocators(locators: string[], context: string): string[] {
  const normalized = locators.map(normalizeRelaySourceLocator);
  for (const locator of normalized) {
    if (!AUTHORITATIVE_SOURCE_LOCATORS.has(locator)) {
      throw new Error(`Relay ${context} source grounding cites a non-authoritative fixture path: ${locator}`);
    }
  }
  const unique = new Set(normalized);
  const missing = RELAY_AUTHORITATIVE_SOURCE_LOCATORS.filter((locator) => !unique.has(locator));
  if (missing.length > 0) {
    throw new Error(`Relay ${context} source grounding omitted authoritative fixture paths: ${missing.join(", ")}`);
  }
  return [...RELAY_AUTHORITATIVE_SOURCE_LOCATORS];
}
