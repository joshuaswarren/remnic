/**
 * Helper routines for starlight-auth-vault
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_starlight_auth_vault, generateTraceId_starlight_auth_vault } from "./utils.js";

export function buildResponseEnvelope_starlight_auth_vault<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}

export function validateDomainHeader_starlight_auth_vault(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function createServiceContext_starlight_auth_vault(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_starlight_auth_vault(domain),
    traceId: generateTraceId_starlight_auth_vault(),
    timestamp: Date.now(),
  };
}

export function getDomainHeader_starlight_auth_vault(domain: string): string {
  return "X-Domain-" + formatDomainName_starlight_auth_vault(domain);
}
