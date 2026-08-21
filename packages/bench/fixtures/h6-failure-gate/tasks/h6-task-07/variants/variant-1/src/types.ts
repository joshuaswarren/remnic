/**
 * Domain type definitions for apex-payment-gateway
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_apex_payment_gateway {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_apex_payment_gateway {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_apex_payment_gateway {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_apex_payment_gateway {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_apex_payment_gateway<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_apex_payment_gateway {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
