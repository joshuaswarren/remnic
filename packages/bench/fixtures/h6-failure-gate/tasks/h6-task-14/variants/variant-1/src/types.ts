/**
 * Domain type definitions for identity-provider-node
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_identity_provider_node {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_identity_provider_node {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_identity_provider_node {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_identity_provider_node {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_identity_provider_node<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_identity_provider_node {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
