/**
 * Type declarations for counterfactual SDK media-transcoder-service
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_media_transcoder_service {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_media_transcoder_service {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_media_transcoder_service {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_media_transcoder_service;
}

export interface QuillBatchRequest_media_transcoder_service {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_media_transcoder_service {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
