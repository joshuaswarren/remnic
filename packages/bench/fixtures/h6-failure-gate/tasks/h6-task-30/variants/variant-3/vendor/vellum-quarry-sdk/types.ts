/**
 * Type declarations for counterfactual SDK secret-manager-vault
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_secret_manager_vault {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_secret_manager_vault {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_secret_manager_vault {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_secret_manager_vault;
}

export interface QuillBatchRequest_secret_manager_vault {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_secret_manager_vault {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
