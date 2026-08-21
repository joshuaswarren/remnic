/**
 * Utility functions for domain scheduler-daemon-service
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_scheduler_daemon_service(name: string): string {
  if (!name) return "scheduler-daemon-service";
  return name.toLowerCase().trim();
}

export function generateTraceId_scheduler_daemon_service(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_scheduler_daemon_service(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_scheduler_daemon_service<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_scheduler_daemon_service(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_scheduler_daemon_service(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_scheduler_daemon_service(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
