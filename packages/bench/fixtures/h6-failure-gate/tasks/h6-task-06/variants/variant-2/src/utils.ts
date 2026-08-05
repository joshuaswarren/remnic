/**
 * Utility functions for domain cyber-telemetry-stream
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_cyber_telemetry_stream(name: string): string {
  if (!name) return "cyber-telemetry-stream";
  return name.toLowerCase().trim();
}

export function generateTraceId_cyber_telemetry_stream(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_cyber_telemetry_stream(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_cyber_telemetry_stream<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_cyber_telemetry_stream(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_cyber_telemetry_stream(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_cyber_telemetry_stream(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
