/**
 * Domain type definitions for starlight-auth-vault
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_starlight_auth_vault {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_starlight_auth_vault {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_starlight_auth_vault {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_starlight_auth_vault {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_starlight_auth_vault<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_starlight_auth_vault {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
