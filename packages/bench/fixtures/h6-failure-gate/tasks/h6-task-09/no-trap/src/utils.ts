/**
 * Utility functions for domain pulse-notification-bus
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_pulse_notification_bus(name: string): string {
  if (!name) return "pulse-notification-bus";
  return name.toLowerCase().trim();
}

export function generateTraceId_pulse_notification_bus(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_pulse_notification_bus(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_pulse_notification_bus<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_pulse_notification_bus(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_pulse_notification_bus(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_pulse_notification_bus(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
