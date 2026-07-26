import type { CodingScopedWriteInput } from "./access-service.js";
import type { CodingContext } from "./types.js";

export interface CodingContextSessionHost {
  getCodingContextForSession(sessionKey: string): CodingContext | null;
  setCodingContextForSession(sessionKey: string, context: CodingContext | null): void;
}

export async function withSeededCodingContext<T>(
  host: CodingContextSessionHost,
  sessionKey: string,
  operation: (captureSeededCodingContext: () => void) => Promise<T>,
): Promise<T> {
  const previousCodingContext = host.getCodingContextForSession(sessionKey);
  let seededCodingContext: CodingContext | null = null;
  const captureSeededCodingContext = (): void => {
    if (previousCodingContext !== null || seededCodingContext !== null) return;
    const currentCodingContext = host.getCodingContextForSession(sessionKey);
    if (currentCodingContext !== null) seededCodingContext = currentCodingContext;
  };
  const clearSeededCodingContext = (): void => {
    if (previousCodingContext !== null || seededCodingContext === null) return;
    if (host.getCodingContextForSession(sessionKey) === seededCodingContext) {
      host.setCodingContextForSession(sessionKey, null);
    }
  };

  try {
    const result = await operation(captureSeededCodingContext);
    clearSeededCodingContext();
    return result;
  } catch (error) {
    clearSeededCodingContext();
    throw error;
  }
}

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
  /** Internal HTTP hook invoked after the durable flush and before cleanup. */
  onCommitted?: () => void;
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
