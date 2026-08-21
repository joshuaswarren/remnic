/**
 * Type declarations for counterfactual SDK metrics-collector-agent
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_metrics_collector_agent {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_metrics_collector_agent {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_metrics_collector_agent {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_metrics_collector_agent;
}

export interface QuillBatchRequest_metrics_collector_agent {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_metrics_collector_agent {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
