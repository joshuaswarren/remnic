/**
 * Domain type definitions for metrics-collector-agent
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_metrics_collector_agent {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_metrics_collector_agent {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_metrics_collector_agent {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_metrics_collector_agent {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_metrics_collector_agent<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_metrics_collector_agent {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
