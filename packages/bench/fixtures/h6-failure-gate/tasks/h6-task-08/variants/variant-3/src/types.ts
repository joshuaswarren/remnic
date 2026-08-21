/**
 * Domain type definitions for quantum-order-pipeline
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_quantum_order_pipeline {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_quantum_order_pipeline {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_quantum_order_pipeline {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_quantum_order_pipeline {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_quantum_order_pipeline<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_quantum_order_pipeline {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
