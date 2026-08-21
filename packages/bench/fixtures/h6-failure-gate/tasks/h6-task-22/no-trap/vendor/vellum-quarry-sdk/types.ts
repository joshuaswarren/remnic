/**
 * Type declarations for counterfactual SDK audit-logger-stream
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_audit_logger_stream {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_audit_logger_stream {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_audit_logger_stream {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_audit_logger_stream;
}

export interface QuillBatchRequest_audit_logger_stream {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_audit_logger_stream {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
