/**
 * Type declarations for counterfactual SDK workflow-runner-engine
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_workflow_runner_engine {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_workflow_runner_engine {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_workflow_runner_engine {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_workflow_runner_engine;
}

export interface QuillBatchRequest_workflow_runner_engine {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_workflow_runner_engine {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
