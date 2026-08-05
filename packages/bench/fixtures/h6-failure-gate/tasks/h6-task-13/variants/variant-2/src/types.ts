/**
 * Domain type definitions for media-transcoder-service
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_media_transcoder_service {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_media_transcoder_service {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_media_transcoder_service {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_media_transcoder_service {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_media_transcoder_service<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_media_transcoder_service {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
