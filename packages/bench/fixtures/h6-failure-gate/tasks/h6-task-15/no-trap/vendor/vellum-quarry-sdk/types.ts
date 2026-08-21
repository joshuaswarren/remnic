/**
 * Type declarations for counterfactual SDK config-server-cluster
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_config_server_cluster {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_config_server_cluster {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_config_server_cluster {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_config_server_cluster;
}

export interface QuillBatchRequest_config_server_cluster {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_config_server_cluster {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
