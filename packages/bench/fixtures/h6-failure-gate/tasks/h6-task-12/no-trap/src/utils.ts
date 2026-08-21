/**
 * Utility functions for domain analytics-beacon-hub
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_analytics_beacon_hub(name: string): string {
  if (!name) return "analytics-beacon-hub";
  return name.toLowerCase().trim();
}

export function generateTraceId_analytics_beacon_hub(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_analytics_beacon_hub(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_analytics_beacon_hub<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_analytics_beacon_hub(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_analytics_beacon_hub(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_analytics_beacon_hub(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
