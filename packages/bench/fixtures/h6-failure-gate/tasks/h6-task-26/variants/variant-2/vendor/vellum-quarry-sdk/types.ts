/**
 * Type declarations for counterfactual SDK queue-worker-daemon
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_queue_worker_daemon {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_queue_worker_daemon {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_queue_worker_daemon {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_queue_worker_daemon;
}

export interface QuillBatchRequest_queue_worker_daemon {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_queue_worker_daemon {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
