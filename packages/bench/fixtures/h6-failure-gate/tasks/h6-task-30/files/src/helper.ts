/**
 * Helper routines for secret-manager-vault
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_secret_manager_vault, generateTraceId_secret_manager_vault } from "./utils.js";

export function getDomainHeader_secret_manager_vault(domain: string): string {
  return "X-Domain-" + formatDomainName_secret_manager_vault(domain);
}

export function createServiceContext_secret_manager_vault(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_secret_manager_vault(domain),
    traceId: generateTraceId_secret_manager_vault(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_secret_manager_vault(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_secret_manager_vault<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
