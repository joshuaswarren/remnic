/**
 * Type declarations for counterfactual SDK scheduler-daemon-service
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_scheduler_daemon_service {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_scheduler_daemon_service {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_scheduler_daemon_service {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_scheduler_daemon_service;
}

export interface QuillBatchRequest_scheduler_daemon_service {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_scheduler_daemon_service {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
