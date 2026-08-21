/**
 * Domain type definitions for audit-logger-stream
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_audit_logger_stream {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_audit_logger_stream {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_audit_logger_stream {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_audit_logger_stream {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_audit_logger_stream<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_audit_logger_stream {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
