/**
 * Type declarations for counterfactual SDK schema-registry-store
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_schema_registry_store {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_schema_registry_store {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_schema_registry_store {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_schema_registry_store;
}

export interface QuillBatchRequest_schema_registry_store {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_schema_registry_store {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
