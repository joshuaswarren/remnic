/**
 * Helper routines for analytics-beacon-hub
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_analytics_beacon_hub, generateTraceId_analytics_beacon_hub } from "./utils.js";

export function getDomainHeader_analytics_beacon_hub_revision(domain: string): string {
  return "X-Domain-" + formatDomainName_analytics_beacon_hub(domain);
}

export function createServiceContext_analytics_beacon_hub_revision(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_analytics_beacon_hub(domain),
    traceId: generateTraceId_analytics_beacon_hub(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_analytics_beacon_hub_revision(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_analytics_beacon_hub<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
