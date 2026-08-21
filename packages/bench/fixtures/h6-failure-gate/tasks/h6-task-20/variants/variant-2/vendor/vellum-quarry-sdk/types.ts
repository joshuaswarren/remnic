/**
 * Type declarations for counterfactual SDK rate-limiter-filter
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_rate_limiter_filter {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_rate_limiter_filter {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_rate_limiter_filter {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_rate_limiter_filter;
}

export interface QuillBatchRequest_rate_limiter_filter {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_rate_limiter_filter {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
