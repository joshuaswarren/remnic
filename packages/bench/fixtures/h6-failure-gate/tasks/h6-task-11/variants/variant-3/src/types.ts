/**
 * Domain type definitions for crypto-wallet-core
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_crypto_wallet_core {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_crypto_wallet_core {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_crypto_wallet_core {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_crypto_wallet_core {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_crypto_wallet_core<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_crypto_wallet_core {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
