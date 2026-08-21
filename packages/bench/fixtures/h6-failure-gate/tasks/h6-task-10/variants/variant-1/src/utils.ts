/**
 * Utility functions for domain vector-session-store
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_vector_session_store(name: string): string {
  if (!name) return "vector-session-store";
  return name.toLowerCase().trim();
}

export function generateTraceId_vector_session_store(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_vector_session_store(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_vector_session_store<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_vector_session_store(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_vector_session_store(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_vector_session_store(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
