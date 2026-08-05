/**
 * Type declarations for counterfactual SDK nexus-billing-engine
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_nexus_billing_engine {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_nexus_billing_engine {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_nexus_billing_engine {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_nexus_billing_engine;
}

export interface QuillBatchRequest_nexus_billing_engine {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_nexus_billing_engine {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
