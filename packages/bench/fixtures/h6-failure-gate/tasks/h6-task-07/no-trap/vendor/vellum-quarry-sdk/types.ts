/**
 * Type declarations for counterfactual SDK apex-payment-gateway
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_apex_payment_gateway {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_apex_payment_gateway {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_apex_payment_gateway {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_apex_payment_gateway;
}

export interface QuillBatchRequest_apex_payment_gateway {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_apex_payment_gateway {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
