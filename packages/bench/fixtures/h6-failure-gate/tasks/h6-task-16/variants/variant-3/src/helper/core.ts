/**
 * Helper routines for search-index-cluster
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_search_index_cluster, generateTraceId_search_index_cluster } from "../utils.js";

export function getDomainHeader_search_index_cluster(domain: string): string {
  return "X-Domain-" + formatDomainName_search_index_cluster(domain);
}

export function createServiceContext_search_index_cluster(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_search_index_cluster(domain),
    traceId: generateTraceId_search_index_cluster(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_search_index_cluster(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_search_index_cluster<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
