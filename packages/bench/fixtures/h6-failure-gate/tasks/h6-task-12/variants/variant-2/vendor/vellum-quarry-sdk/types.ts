/**
 * Type declarations for counterfactual SDK analytics-beacon-hub
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_analytics_beacon_hub {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_analytics_beacon_hub {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_analytics_beacon_hub {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_analytics_beacon_hub;
}

export interface QuillBatchRequest_analytics_beacon_hub {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_analytics_beacon_hub {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
