/**
 * Helper routines for storage-bucket-manager
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_storage_bucket_manager, generateTraceId_storage_bucket_manager } from "./utils.js";

export function buildResponseEnvelope_storage_bucket_manager<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}

export function validateDomainHeader_storage_bucket_manager(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function createServiceContext_storage_bucket_manager(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_storage_bucket_manager(domain),
    traceId: generateTraceId_storage_bucket_manager(),
    timestamp: Date.now(),
  };
}

export function getDomainHeader_storage_bucket_manager(domain: string): string {
  return "X-Domain-" + formatDomainName_storage_bucket_manager(domain);
}
