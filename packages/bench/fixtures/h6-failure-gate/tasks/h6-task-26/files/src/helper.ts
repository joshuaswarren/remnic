/**
 * Helper routines for queue-worker-daemon
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_queue_worker_daemon, generateTraceId_queue_worker_daemon } from "./utils.js";

export function getDomainHeader_queue_worker_daemon(domain: string): string {
  return "X-Domain-" + formatDomainName_queue_worker_daemon(domain);
}

export function createServiceContext_queue_worker_daemon(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_queue_worker_daemon(domain),
    traceId: generateTraceId_queue_worker_daemon(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_queue_worker_daemon(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_queue_worker_daemon<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
