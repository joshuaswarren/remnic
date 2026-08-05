/**
 * Type declarations for counterfactual SDK starlight-auth-vault
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_starlight_auth_vault {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_starlight_auth_vault {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_starlight_auth_vault {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_starlight_auth_vault;
}

export interface QuillBatchRequest_starlight_auth_vault {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_starlight_auth_vault {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
