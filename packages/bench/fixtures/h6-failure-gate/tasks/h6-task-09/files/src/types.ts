/**
 * Domain type definitions for pulse-notification-bus
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_pulse_notification_bus {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_pulse_notification_bus {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_pulse_notification_bus {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_pulse_notification_bus {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_pulse_notification_bus<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_pulse_notification_bus {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
