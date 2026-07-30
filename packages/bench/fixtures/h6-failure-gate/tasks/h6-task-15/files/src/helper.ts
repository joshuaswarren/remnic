/**
 * Helper routines for config-server-cluster
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_config_server_cluster, generateTraceId_config_server_cluster } from "./utils.js";

export function getDomainHeader_config_server_cluster(domain: string): string {
  return "X-Domain-" + formatDomainName_config_server_cluster(domain);
}

export function createServiceContext_config_server_cluster(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_config_server_cluster(domain),
    traceId: generateTraceId_config_server_cluster(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_config_server_cluster(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_config_server_cluster<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
