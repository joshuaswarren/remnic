/**
 * Type declarations for counterfactual SDK cyber-telemetry-stream
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_cyber_telemetry_stream {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_cyber_telemetry_stream {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_cyber_telemetry_stream {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_cyber_telemetry_stream;
}

export interface QuillBatchRequest_cyber_telemetry_stream {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_cyber_telemetry_stream {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
