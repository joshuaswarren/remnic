/**
 * Helper routines for load-balancer-proxy
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_load_balancer_proxy, generateTraceId_load_balancer_proxy } from "./utils.js";

export function getDomainHeader_load_balancer_proxy(domain: string): string {
  return "X-Domain-" + formatDomainName_load_balancer_proxy(domain);
}

export function createServiceContext_load_balancer_proxy(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_load_balancer_proxy(domain),
    traceId: generateTraceId_load_balancer_proxy(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_load_balancer_proxy(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_load_balancer_proxy<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
