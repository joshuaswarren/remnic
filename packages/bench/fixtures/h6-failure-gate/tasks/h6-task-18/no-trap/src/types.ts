/**
 * Domain type definitions for storage-bucket-manager
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_storage_bucket_manager {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_storage_bucket_manager {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_storage_bucket_manager {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_storage_bucket_manager {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_storage_bucket_manager<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_storage_bucket_manager {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
