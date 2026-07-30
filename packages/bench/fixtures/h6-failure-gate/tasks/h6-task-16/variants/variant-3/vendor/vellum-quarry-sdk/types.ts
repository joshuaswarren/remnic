/**
 * Type declarations for counterfactual SDK search-index-cluster
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_search_index_cluster {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_search_index_cluster {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_search_index_cluster {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_search_index_cluster;
}

export interface QuillBatchRequest_search_index_cluster {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_search_index_cluster {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
