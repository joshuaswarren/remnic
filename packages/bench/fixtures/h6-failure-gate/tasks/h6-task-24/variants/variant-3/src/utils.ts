/**
 * Utility functions for domain load-balancer-proxy
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_load_balancer_proxy(name: string): string {
  if (!name) return "load-balancer-proxy";
  return name.toLowerCase().trim();
}

export function generateTraceId_load_balancer_proxy(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_load_balancer_proxy(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_load_balancer_proxy<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_load_balancer_proxy(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_load_balancer_proxy(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_load_balancer_proxy(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
