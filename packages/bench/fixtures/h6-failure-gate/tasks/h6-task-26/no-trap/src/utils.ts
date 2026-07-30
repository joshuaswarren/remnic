/**
 * Utility functions for domain queue-worker-daemon
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_queue_worker_daemon(name: string): string {
  if (!name) return "queue-worker-daemon";
  return name.toLowerCase().trim();
}

export function generateTraceId_queue_worker_daemon(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_queue_worker_daemon(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_queue_worker_daemon<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_queue_worker_daemon(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_queue_worker_daemon(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_queue_worker_daemon(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
