/**
 * Domain type definitions for feature-flag-service
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_feature_flag_service {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_feature_flag_service {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_feature_flag_service {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_feature_flag_service {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_feature_flag_service<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_feature_flag_service {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
