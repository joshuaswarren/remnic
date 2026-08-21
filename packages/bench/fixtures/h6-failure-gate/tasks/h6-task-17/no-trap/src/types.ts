/**
 * Domain type definitions for workflow-runner-engine
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_workflow_runner_engine {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_workflow_runner_engine {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_workflow_runner_engine {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_workflow_runner_engine {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_workflow_runner_engine<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_workflow_runner_engine {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
