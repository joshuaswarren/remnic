/**
 * Domain type definitions for secret-manager-vault
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_secret_manager_vault {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_secret_manager_vault {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_secret_manager_vault {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_secret_manager_vault {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_secret_manager_vault<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_secret_manager_vault {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
