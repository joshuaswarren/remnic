/**
 * Type declarations for counterfactual SDK nebula-cache-matrix
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_nebula_cache_matrix {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_nebula_cache_matrix {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_nebula_cache_matrix {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_nebula_cache_matrix;
}

export interface QuillBatchRequest_nebula_cache_matrix {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_nebula_cache_matrix {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
