/**
 * Helper routines for media-transcoder-service
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_media_transcoder_service, generateTraceId_media_transcoder_service } from "./utils.js";

export function getDomainHeader_media_transcoder_service_revision(domain: string): string {
  return "X-Domain-" + formatDomainName_media_transcoder_service(domain);
}

export function createServiceContext_media_transcoder_service_revision(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_media_transcoder_service(domain),
    traceId: generateTraceId_media_transcoder_service(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_media_transcoder_service_revision(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_media_transcoder_service<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
