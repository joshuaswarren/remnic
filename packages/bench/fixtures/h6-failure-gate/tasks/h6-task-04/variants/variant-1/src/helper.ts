/**
 * Helper routines for nebula-cache-matrix
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_nebula_cache_matrix, generateTraceId_nebula_cache_matrix } from "./utils.js";

export function getDomainHeader_nebula_cache_matrix_revision(domain: string): string {
  return "X-Domain-" + formatDomainName_nebula_cache_matrix(domain);
}

export function createServiceContext_nebula_cache_matrix_revision(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_nebula_cache_matrix(domain),
    traceId: generateTraceId_nebula_cache_matrix(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_nebula_cache_matrix_revision(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_nebula_cache_matrix<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
