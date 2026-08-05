/**
 * Domain type definitions for event-dispatcher-bus
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_event_dispatcher_bus {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_event_dispatcher_bus {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_event_dispatcher_bus {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_event_dispatcher_bus {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_event_dispatcher_bus<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_event_dispatcher_bus {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
