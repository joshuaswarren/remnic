/**
 * Helper routines for event-dispatcher-bus
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_event_dispatcher_bus, generateTraceId_event_dispatcher_bus } from "./utils.js";

export function getDomainHeader_event_dispatcher_bus(domain: string): string {
  return "X-Domain-" + formatDomainName_event_dispatcher_bus(domain);
}

export function createServiceContext_event_dispatcher_bus(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_event_dispatcher_bus(domain),
    traceId: generateTraceId_event_dispatcher_bus(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_event_dispatcher_bus(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_event_dispatcher_bus<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
