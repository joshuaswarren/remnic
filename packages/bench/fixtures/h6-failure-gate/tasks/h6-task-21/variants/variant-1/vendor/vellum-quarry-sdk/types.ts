/**
 * Type declarations for counterfactual SDK feature-flag-service
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_feature_flag_service {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_feature_flag_service {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_feature_flag_service {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_feature_flag_service;
}

export interface QuillBatchRequest_feature_flag_service {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_feature_flag_service {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
