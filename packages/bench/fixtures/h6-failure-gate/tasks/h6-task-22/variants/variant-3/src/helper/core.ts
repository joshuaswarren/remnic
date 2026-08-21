/**
 * Helper routines for audit-logger-stream
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_audit_logger_stream, generateTraceId_audit_logger_stream } from "../utils.js";

export function getDomainHeader_audit_logger_stream(domain: string): string {
  return "X-Domain-" + formatDomainName_audit_logger_stream(domain);
}

export function createServiceContext_audit_logger_stream(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_audit_logger_stream(domain),
    traceId: generateTraceId_audit_logger_stream(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_audit_logger_stream(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_audit_logger_stream<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
