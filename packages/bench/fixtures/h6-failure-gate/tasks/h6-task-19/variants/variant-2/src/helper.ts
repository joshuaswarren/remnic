/**
 * Helper routines for scheduler-daemon-service
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_scheduler_daemon_service, generateTraceId_scheduler_daemon_service } from "./utils.js";

export function buildResponseEnvelope_scheduler_daemon_service<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}

export function validateDomainHeader_scheduler_daemon_service(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function createServiceContext_scheduler_daemon_service(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_scheduler_daemon_service(domain),
    traceId: generateTraceId_scheduler_daemon_service(),
    timestamp: Date.now(),
  };
}

export function getDomainHeader_scheduler_daemon_service(domain: string): string {
  return "X-Domain-" + formatDomainName_scheduler_daemon_service(domain);
}
