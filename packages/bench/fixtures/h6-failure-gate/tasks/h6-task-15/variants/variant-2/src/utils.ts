/**
 * Utility functions for domain config-server-cluster
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_config_server_cluster(name: string): string {
  if (!name) return "config-server-cluster";
  return name.toLowerCase().trim();
}

export function generateTraceId_config_server_cluster(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_config_server_cluster(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_config_server_cluster<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_config_server_cluster(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_config_server_cluster(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_config_server_cluster(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
