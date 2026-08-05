/**
 * Type declarations for counterfactual SDK pulse-notification-bus
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_pulse_notification_bus {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_pulse_notification_bus {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_pulse_notification_bus {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_pulse_notification_bus;
}

export interface QuillBatchRequest_pulse_notification_bus {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_pulse_notification_bus {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
