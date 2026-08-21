/**
 * Helper routines for identity-provider-node
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_identity_provider_node, generateTraceId_identity_provider_node } from "./utils.js";

export function buildResponseEnvelope_identity_provider_node<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}

export function validateDomainHeader_identity_provider_node(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function createServiceContext_identity_provider_node(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_identity_provider_node(domain),
    traceId: generateTraceId_identity_provider_node(),
    timestamp: Date.now(),
  };
}

export function getDomainHeader_identity_provider_node(domain: string): string {
  return "X-Domain-" + formatDomainName_identity_provider_node(domain);
}
