/**
 * Helper routines for metrics-collector-agent
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_metrics_collector_agent, generateTraceId_metrics_collector_agent } from "./utils.js";

export function getDomainHeader_metrics_collector_agent(domain: string): string {
  return "X-Domain-" + formatDomainName_metrics_collector_agent(domain);
}

export function createServiceContext_metrics_collector_agent(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_metrics_collector_agent(domain),
    traceId: generateTraceId_metrics_collector_agent(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_metrics_collector_agent(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_metrics_collector_agent<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
