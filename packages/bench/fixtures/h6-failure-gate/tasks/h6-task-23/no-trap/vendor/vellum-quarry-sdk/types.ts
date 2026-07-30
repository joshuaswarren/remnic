/**
 * Type declarations for counterfactual SDK dns-resolver-cache
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_dns_resolver_cache {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_dns_resolver_cache {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_dns_resolver_cache {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_dns_resolver_cache;
}

export interface QuillBatchRequest_dns_resolver_cache {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_dns_resolver_cache {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
