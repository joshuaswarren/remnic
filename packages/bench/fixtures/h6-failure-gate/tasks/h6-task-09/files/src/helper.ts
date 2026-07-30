/**
 * Helper routines for pulse-notification-bus
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_pulse_notification_bus, generateTraceId_pulse_notification_bus } from "./utils.js";

export function getDomainHeader_pulse_notification_bus(domain: string): string {
  return "X-Domain-" + formatDomainName_pulse_notification_bus(domain);
}

export function createServiceContext_pulse_notification_bus(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_pulse_notification_bus(domain),
    traceId: generateTraceId_pulse_notification_bus(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_pulse_notification_bus(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_pulse_notification_bus<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
