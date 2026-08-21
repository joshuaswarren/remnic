/**
 * Helper routines for hyperion-router-mesh
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_hyperion_router_mesh, generateTraceId_hyperion_router_mesh } from "./utils.js";

export function buildResponseEnvelope_hyperion_router_mesh<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}

export function validateDomainHeader_hyperion_router_mesh(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function createServiceContext_hyperion_router_mesh(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_hyperion_router_mesh(domain),
    traceId: generateTraceId_hyperion_router_mesh(),
    timestamp: Date.now(),
  };
}

export function getDomainHeader_hyperion_router_mesh(domain: string): string {
  return "X-Domain-" + formatDomainName_hyperion_router_mesh(domain);
}
