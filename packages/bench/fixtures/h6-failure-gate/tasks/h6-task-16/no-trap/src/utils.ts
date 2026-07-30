/**
 * Utility functions for domain search-index-cluster
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_search_index_cluster(name: string): string {
  if (!name) return "search-index-cluster";
  return name.toLowerCase().trim();
}

export function generateTraceId_search_index_cluster(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_search_index_cluster(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_search_index_cluster<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_search_index_cluster(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_search_index_cluster(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_search_index_cluster(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
