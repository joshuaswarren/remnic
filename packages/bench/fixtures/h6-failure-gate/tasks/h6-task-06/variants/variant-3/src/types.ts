/**
 * Domain type definitions for cyber-telemetry-stream
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_cyber_telemetry_stream {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_cyber_telemetry_stream {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_cyber_telemetry_stream {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_cyber_telemetry_stream {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_cyber_telemetry_stream<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_cyber_telemetry_stream {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
