/**
 * Helper routines for rate-limiter-filter
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_rate_limiter_filter, generateTraceId_rate_limiter_filter } from "./utils.js";

export function getDomainHeader_rate_limiter_filter_revision(domain: string): string {
  return "X-Domain-" + formatDomainName_rate_limiter_filter(domain);
}

export function createServiceContext_rate_limiter_filter_revision(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_rate_limiter_filter(domain),
    traceId: generateTraceId_rate_limiter_filter(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_rate_limiter_filter_revision(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_rate_limiter_filter<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
