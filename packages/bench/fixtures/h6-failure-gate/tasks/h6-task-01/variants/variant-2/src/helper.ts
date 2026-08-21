/**
 * Helper routines for quillboard-inventory-sync
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_quillboard_inventory_sync, generateTraceId_quillboard_inventory_sync } from "./utils.js";

export function buildResponseEnvelope_quillboard_inventory_sync<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}

export function validateDomainHeader_quillboard_inventory_sync(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function createServiceContext_quillboard_inventory_sync(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_quillboard_inventory_sync(domain),
    traceId: generateTraceId_quillboard_inventory_sync(),
    timestamp: Date.now(),
  };
}

export function getDomainHeader_quillboard_inventory_sync(domain: string): string {
  return "X-Domain-" + formatDomainName_quillboard_inventory_sync(domain);
}
