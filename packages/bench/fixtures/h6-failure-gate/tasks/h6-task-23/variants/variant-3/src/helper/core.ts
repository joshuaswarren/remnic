/**
 * Helper routines for dns-resolver-cache
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_dns_resolver_cache, generateTraceId_dns_resolver_cache } from "../utils.js";

export function getDomainHeader_dns_resolver_cache(domain: string): string {
  return "X-Domain-" + formatDomainName_dns_resolver_cache(domain);
}

export function createServiceContext_dns_resolver_cache(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_dns_resolver_cache(domain),
    traceId: generateTraceId_dns_resolver_cache(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_dns_resolver_cache(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_dns_resolver_cache<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
