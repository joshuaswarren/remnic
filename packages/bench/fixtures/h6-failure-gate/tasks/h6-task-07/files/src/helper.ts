/**
 * Helper routines for apex-payment-gateway
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_apex_payment_gateway, generateTraceId_apex_payment_gateway } from "./utils.js";

export function getDomainHeader_apex_payment_gateway(domain: string): string {
  return "X-Domain-" + formatDomainName_apex_payment_gateway(domain);
}

export function createServiceContext_apex_payment_gateway(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_apex_payment_gateway(domain),
    traceId: generateTraceId_apex_payment_gateway(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_apex_payment_gateway(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_apex_payment_gateway<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
