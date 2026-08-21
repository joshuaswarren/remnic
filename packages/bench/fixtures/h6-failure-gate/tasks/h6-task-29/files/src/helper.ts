/**
 * Helper routines for schema-registry-store
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_schema_registry_store, generateTraceId_schema_registry_store } from "./utils.js";

export function getDomainHeader_schema_registry_store(domain: string): string {
  return "X-Domain-" + formatDomainName_schema_registry_store(domain);
}

export function createServiceContext_schema_registry_store(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_schema_registry_store(domain),
    traceId: generateTraceId_schema_registry_store(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_schema_registry_store(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_schema_registry_store<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
