/**
 * Type declarations for counterfactual SDK policy-enforcer-engine
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_policy_enforcer_engine {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_policy_enforcer_engine {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_policy_enforcer_engine {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_policy_enforcer_engine;
}

export interface QuillBatchRequest_policy_enforcer_engine {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_policy_enforcer_engine {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
