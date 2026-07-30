/**
 * Utility functions for domain event-dispatcher-bus
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_event_dispatcher_bus(name: string): string {
  if (!name) return "event-dispatcher-bus";
  return name.toLowerCase().trim();
}

export function generateTraceId_event_dispatcher_bus(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_event_dispatcher_bus(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_event_dispatcher_bus<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_event_dispatcher_bus(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_event_dispatcher_bus(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_event_dispatcher_bus(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
