/**
 * Utility functions for domain rate-limiter-filter
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_rate_limiter_filter(name: string): string {
  if (!name) return "rate-limiter-filter";
  return name.toLowerCase().trim();
}

export function generateTraceId_rate_limiter_filter(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_rate_limiter_filter(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_rate_limiter_filter<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_rate_limiter_filter(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_rate_limiter_filter(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_rate_limiter_filter(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
