/**
 * Utility functions for domain nebula-cache-matrix
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_nebula_cache_matrix(name: string): string {
  if (!name) return "nebula-cache-matrix";
  return name.toLowerCase().trim();
}

export function generateTraceId_nebula_cache_matrix(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_nebula_cache_matrix(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_nebula_cache_matrix<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_nebula_cache_matrix(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_nebula_cache_matrix(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_nebula_cache_matrix(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
