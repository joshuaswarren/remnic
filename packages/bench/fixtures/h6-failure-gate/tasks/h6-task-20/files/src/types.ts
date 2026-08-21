/**
 * Domain type definitions for rate-limiter-filter
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_rate_limiter_filter {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_rate_limiter_filter {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_rate_limiter_filter {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_rate_limiter_filter {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_rate_limiter_filter<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_rate_limiter_filter {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
