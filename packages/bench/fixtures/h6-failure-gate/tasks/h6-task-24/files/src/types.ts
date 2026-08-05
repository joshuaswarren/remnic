/**
 * Domain type definitions for load-balancer-proxy
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_load_balancer_proxy {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_load_balancer_proxy {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_load_balancer_proxy {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_load_balancer_proxy {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_load_balancer_proxy<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_load_balancer_proxy {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
