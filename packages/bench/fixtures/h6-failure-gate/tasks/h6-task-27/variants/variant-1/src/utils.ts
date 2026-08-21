/**
 * Utility functions for domain metrics-collector-agent
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_metrics_collector_agent(name: string): string {
  if (!name) return "metrics-collector-agent";
  return name.toLowerCase().trim();
}

export function generateTraceId_metrics_collector_agent(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_metrics_collector_agent(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_metrics_collector_agent<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_metrics_collector_agent(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_metrics_collector_agent(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_metrics_collector_agent(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
