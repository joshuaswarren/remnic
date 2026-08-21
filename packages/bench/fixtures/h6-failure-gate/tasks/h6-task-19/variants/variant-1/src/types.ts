/**
 * Domain type definitions for scheduler-daemon-service
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_scheduler_daemon_service {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_scheduler_daemon_service {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_scheduler_daemon_service {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_scheduler_daemon_service {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_scheduler_daemon_service<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_scheduler_daemon_service {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
