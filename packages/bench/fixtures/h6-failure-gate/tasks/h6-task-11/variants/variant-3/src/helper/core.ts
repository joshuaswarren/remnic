/**
 * Helper routines for crypto-wallet-core
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_crypto_wallet_core, generateTraceId_crypto_wallet_core } from "../utils.js";

export function getDomainHeader_crypto_wallet_core(domain: string): string {
  return "X-Domain-" + formatDomainName_crypto_wallet_core(domain);
}

export function createServiceContext_crypto_wallet_core(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_crypto_wallet_core(domain),
    traceId: generateTraceId_crypto_wallet_core(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_crypto_wallet_core(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_crypto_wallet_core<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
