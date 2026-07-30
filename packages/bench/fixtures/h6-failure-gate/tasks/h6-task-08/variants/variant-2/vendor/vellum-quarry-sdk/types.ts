/**
 * Type declarations for counterfactual SDK quantum-order-pipeline
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_quantum_order_pipeline {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_quantum_order_pipeline {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_quantum_order_pipeline {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_quantum_order_pipeline;
}

export interface QuillBatchRequest_quantum_order_pipeline {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_quantum_order_pipeline {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
