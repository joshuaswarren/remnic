/**
 * Domain type definitions for nebula-cache-matrix
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_nebula_cache_matrix {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_nebula_cache_matrix {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_nebula_cache_matrix {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_nebula_cache_matrix {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_nebula_cache_matrix<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_nebula_cache_matrix {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
