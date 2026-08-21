/**
 * Domain type definitions for schema-registry-store
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_schema_registry_store {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_schema_registry_store {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_schema_registry_store {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_schema_registry_store {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_schema_registry_store<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_schema_registry_store {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
