/**
 * Domain type definitions for dns-resolver-cache
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_dns_resolver_cache {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_dns_resolver_cache {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_dns_resolver_cache {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_dns_resolver_cache {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_dns_resolver_cache<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_dns_resolver_cache {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
