/**
 * Utility functions for domain feature-flag-service
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_feature_flag_service(name: string): string {
  if (!name) return "feature-flag-service";
  return name.toLowerCase().trim();
}

export function generateTraceId_feature_flag_service(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_feature_flag_service(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_feature_flag_service<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_feature_flag_service(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_feature_flag_service(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_feature_flag_service(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
