/**
 * Type declarations for counterfactual SDK event-dispatcher-bus
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_event_dispatcher_bus {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_event_dispatcher_bus {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_event_dispatcher_bus {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_event_dispatcher_bus;
}

export interface QuillBatchRequest_event_dispatcher_bus {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_event_dispatcher_bus {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
