/**
 * Type declarations for counterfactual SDK storage-bucket-manager
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_storage_bucket_manager {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_storage_bucket_manager {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_storage_bucket_manager {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_storage_bucket_manager;
}

export interface QuillBatchRequest_storage_bucket_manager {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_storage_bucket_manager {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
