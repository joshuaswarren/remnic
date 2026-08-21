/**
 * Type declarations for counterfactual SDK quillboard-inventory-sync
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_quillboard_inventory_sync {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_quillboard_inventory_sync {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_quillboard_inventory_sync {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_quillboard_inventory_sync;
}

export interface QuillBatchRequest_quillboard_inventory_sync {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_quillboard_inventory_sync {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
