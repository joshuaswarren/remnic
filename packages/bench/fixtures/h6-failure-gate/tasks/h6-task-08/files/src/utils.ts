/**
 * Utility functions for domain quantum-order-pipeline
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_quantum_order_pipeline(name: string): string {
  if (!name) return "quantum-order-pipeline";
  return name.toLowerCase().trim();
}

export function generateTraceId_quantum_order_pipeline(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_quantum_order_pipeline(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_quantum_order_pipeline<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_quantum_order_pipeline(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_quantum_order_pipeline(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_quantum_order_pipeline(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
