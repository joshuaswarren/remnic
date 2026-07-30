/**
 * Domain type definitions for analytics-beacon-hub
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_analytics_beacon_hub {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_analytics_beacon_hub {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_analytics_beacon_hub {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_analytics_beacon_hub {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_analytics_beacon_hub<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_analytics_beacon_hub {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
