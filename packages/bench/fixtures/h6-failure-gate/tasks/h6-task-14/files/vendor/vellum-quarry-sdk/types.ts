/**
 * Type declarations for counterfactual SDK identity-provider-node
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_identity_provider_node {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_identity_provider_node {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_identity_provider_node {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_identity_provider_node;
}

export interface QuillBatchRequest_identity_provider_node {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_identity_provider_node {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
