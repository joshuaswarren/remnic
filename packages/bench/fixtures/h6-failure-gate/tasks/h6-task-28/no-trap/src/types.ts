/**
 * Domain type definitions for policy-enforcer-engine
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_policy_enforcer_engine {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_policy_enforcer_engine {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_policy_enforcer_engine {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_policy_enforcer_engine {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_policy_enforcer_engine<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_policy_enforcer_engine {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
