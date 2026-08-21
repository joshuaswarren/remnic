/**
 * Utility functions for domain apex-payment-gateway
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_apex_payment_gateway(name: string): string {
  if (!name) return "apex-payment-gateway";
  return name.toLowerCase().trim();
}

export function generateTraceId_apex_payment_gateway(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_apex_payment_gateway(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_apex_payment_gateway<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_apex_payment_gateway(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_apex_payment_gateway(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_apex_payment_gateway(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
