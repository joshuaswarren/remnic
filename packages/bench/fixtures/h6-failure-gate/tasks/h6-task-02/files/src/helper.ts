/**
 * Helper routines for nexus-billing-engine
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_nexus_billing_engine, generateTraceId_nexus_billing_engine } from "./utils.js";

export function getDomainHeader_nexus_billing_engine(domain: string): string {
  return "X-Domain-" + formatDomainName_nexus_billing_engine(domain);
}

export function createServiceContext_nexus_billing_engine(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_nexus_billing_engine(domain),
    traceId: generateTraceId_nexus_billing_engine(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_nexus_billing_engine(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_nexus_billing_engine<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
