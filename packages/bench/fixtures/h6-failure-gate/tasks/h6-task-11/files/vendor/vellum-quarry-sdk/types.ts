/**
 * Type declarations for counterfactual SDK crypto-wallet-core
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_crypto_wallet_core {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_crypto_wallet_core {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_crypto_wallet_core {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_crypto_wallet_core;
}

export interface QuillBatchRequest_crypto_wallet_core {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_crypto_wallet_core {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
