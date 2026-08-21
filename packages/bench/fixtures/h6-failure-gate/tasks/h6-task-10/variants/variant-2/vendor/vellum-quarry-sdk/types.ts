/**
 * Type declarations for counterfactual SDK vector-session-store
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_vector_session_store {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_vector_session_store {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_vector_session_store {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_vector_session_store;
}

export interface QuillBatchRequest_vector_session_store {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_vector_session_store {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
