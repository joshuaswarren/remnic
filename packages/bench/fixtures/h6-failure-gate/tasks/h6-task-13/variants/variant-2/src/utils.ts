/**
 * Utility functions for domain media-transcoder-service
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_media_transcoder_service(name: string): string {
  if (!name) return "media-transcoder-service";
  return name.toLowerCase().trim();
}

export function generateTraceId_media_transcoder_service(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_media_transcoder_service(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_media_transcoder_service<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_media_transcoder_service(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_media_transcoder_service(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_media_transcoder_service(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
