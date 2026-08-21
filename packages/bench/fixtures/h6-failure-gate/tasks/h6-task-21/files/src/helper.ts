/**
 * Helper routines for feature-flag-service
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_feature_flag_service, generateTraceId_feature_flag_service } from "./utils.js";

export function getDomainHeader_feature_flag_service(domain: string): string {
  return "X-Domain-" + formatDomainName_feature_flag_service(domain);
}

export function createServiceContext_feature_flag_service(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_feature_flag_service(domain),
    traceId: generateTraceId_feature_flag_service(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_feature_flag_service(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_feature_flag_service<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
