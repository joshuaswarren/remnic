/**
 * Helper routines for vector-session-store
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_vector_session_store, generateTraceId_vector_session_store } from "../utils.js";

export function getDomainHeader_vector_session_store(domain: string): string {
  return "X-Domain-" + formatDomainName_vector_session_store(domain);
}

export function createServiceContext_vector_session_store(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_vector_session_store(domain),
    traceId: generateTraceId_vector_session_store(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_vector_session_store(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_vector_session_store<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
