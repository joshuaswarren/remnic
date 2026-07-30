/**
 * Domain type definitions for queue-worker-daemon
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_queue_worker_daemon {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_queue_worker_daemon {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_queue_worker_daemon {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_queue_worker_daemon {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_queue_worker_daemon<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_queue_worker_daemon {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
