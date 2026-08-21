/**
 * Domain type definitions for nexus-billing-engine
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_nexus_billing_engine {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_nexus_billing_engine {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_nexus_billing_engine {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_nexus_billing_engine {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_nexus_billing_engine<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_nexus_billing_engine {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
