/**
 * Utility functions for domain storage-bucket-manager
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_storage_bucket_manager(name: string): string {
  if (!name) return "storage-bucket-manager";
  return name.toLowerCase().trim();
}

export function generateTraceId_storage_bucket_manager(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_storage_bucket_manager(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_storage_bucket_manager<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_storage_bucket_manager(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_storage_bucket_manager(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_storage_bucket_manager(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
