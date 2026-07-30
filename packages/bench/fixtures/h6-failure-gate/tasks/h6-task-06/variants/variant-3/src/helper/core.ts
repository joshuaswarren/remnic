/**
 * Helper routines for cyber-telemetry-stream
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_cyber_telemetry_stream, generateTraceId_cyber_telemetry_stream } from "../utils.js";

export function getDomainHeader_cyber_telemetry_stream(domain: string): string {
  return "X-Domain-" + formatDomainName_cyber_telemetry_stream(domain);
}

export function createServiceContext_cyber_telemetry_stream(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_cyber_telemetry_stream(domain),
    traceId: generateTraceId_cyber_telemetry_stream(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_cyber_telemetry_stream(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_cyber_telemetry_stream<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
