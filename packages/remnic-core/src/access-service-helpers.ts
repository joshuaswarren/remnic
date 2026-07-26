import type { CodingScopedWriteInput } from "./access-service.js";

export interface EngramAccessLcmCompactionFlushRequest extends CodingScopedWriteInput {
  sessionKey: string;
  namespace?: string;
  authenticatedPrincipal?: string;
}

export interface EngramAccessLcmCompactionFlushResponse {
  enabled: boolean;
  flushed: boolean;
  sessionKey: string;
  namespace: string;
  reason?: string;
}

export interface EngramAccessExtractionForceFlushRequest extends CodingScopedWriteInput {
  sessionKey: string;
  namespace?: string;
  authenticatedPrincipal?: string;
  deadlineMs?: number;
  abortSignal?: AbortSignal;
}

export interface EngramAccessExtractionForceFlushResponse {
  flushed: boolean;
  sessionKey: string;
  namespace: string;
  effectiveNamespace: string;
}

export interface ExtractionForceFlushDelegate {
  extractionForceFlush(
    request: EngramAccessExtractionForceFlushRequest,
  ): Promise<EngramAccessExtractionForceFlushResponse>;
}

export function delegateExtractionForceFlush(
  delegate: ExtractionForceFlushDelegate,
  request: EngramAccessExtractionForceFlushRequest,
): Promise<EngramAccessExtractionForceFlushResponse> {
  return delegate.extractionForceFlush(request);
}
