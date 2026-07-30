/**
 * Type declarations for counterfactual SDK hyperion-router-mesh
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_hyperion_router_mesh {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_hyperion_router_mesh {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_hyperion_router_mesh {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_hyperion_router_mesh;
}

export interface QuillBatchRequest_hyperion_router_mesh {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_hyperion_router_mesh {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
