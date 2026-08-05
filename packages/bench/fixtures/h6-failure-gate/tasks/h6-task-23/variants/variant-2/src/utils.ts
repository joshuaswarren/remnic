/**
 * Utility functions for domain dns-resolver-cache
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_dns_resolver_cache(name: string): string {
  if (!name) return "dns-resolver-cache";
  return name.toLowerCase().trim();
}

export function generateTraceId_dns_resolver_cache(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_dns_resolver_cache(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_dns_resolver_cache<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_dns_resolver_cache(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_dns_resolver_cache(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_dns_resolver_cache(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
