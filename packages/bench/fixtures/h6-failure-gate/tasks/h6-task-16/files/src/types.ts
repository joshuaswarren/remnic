/**
 * Domain type definitions for search-index-cluster
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_search_index_cluster {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_search_index_cluster {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_search_index_cluster {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_search_index_cluster {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_search_index_cluster<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_search_index_cluster {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
