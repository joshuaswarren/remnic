/**
 * Type declarations for counterfactual SDK load-balancer-proxy
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_load_balancer_proxy {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_load_balancer_proxy {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_load_balancer_proxy {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_load_balancer_proxy;
}

export interface QuillBatchRequest_load_balancer_proxy {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_load_balancer_proxy {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
