/**
 * Helper routines for quantum-order-pipeline
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_quantum_order_pipeline, generateTraceId_quantum_order_pipeline } from "./utils.js";

export function buildResponseEnvelope_quantum_order_pipeline<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}

export function validateDomainHeader_quantum_order_pipeline(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function createServiceContext_quantum_order_pipeline(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_quantum_order_pipeline(domain),
    traceId: generateTraceId_quantum_order_pipeline(),
    timestamp: Date.now(),
  };
}

export function getDomainHeader_quantum_order_pipeline(domain: string): string {
  return "X-Domain-" + formatDomainName_quantum_order_pipeline(domain);
}
