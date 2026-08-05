/**
 * Domain type definitions for hyperion-router-mesh
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_hyperion_router_mesh {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_hyperion_router_mesh {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_hyperion_router_mesh {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_hyperion_router_mesh {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_hyperion_router_mesh<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_hyperion_router_mesh {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
