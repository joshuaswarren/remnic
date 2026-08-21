/**
 * Domain type definitions for vector-session-store
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_vector_session_store {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_vector_session_store {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_vector_session_store {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_vector_session_store {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_vector_session_store<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_vector_session_store {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
