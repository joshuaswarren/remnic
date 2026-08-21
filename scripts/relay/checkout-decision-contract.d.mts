export const RELAY_CANONICAL_CHECKOUT_DECISION: string;
export const RELAY_CHECKOUT_DECISION_CONTRACT_KEY: string;
export const RELAY_STALE_CHECKOUT_DECISION_CONTRACT_KEY: string;

export function relayCheckoutDecisionContractKey(value: unknown): string | null;
export function assertRelayCheckoutDecision(value: unknown, context: string): string;
export function relayStaleCheckoutDecisionContractKey(value: unknown): string | null;
export function assertRelayStaleCheckoutDecision(value: unknown, context: string): string;
