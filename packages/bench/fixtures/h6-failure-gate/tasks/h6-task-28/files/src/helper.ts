/**
 * Helper routines for policy-enforcer-engine
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_policy_enforcer_engine, generateTraceId_policy_enforcer_engine } from "./utils.js";

export function getDomainHeader_policy_enforcer_engine(domain: string): string {
  return "X-Domain-" + formatDomainName_policy_enforcer_engine(domain);
}

export function createServiceContext_policy_enforcer_engine(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_policy_enforcer_engine(domain),
    traceId: generateTraceId_policy_enforcer_engine(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_policy_enforcer_engine(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_policy_enforcer_engine<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
