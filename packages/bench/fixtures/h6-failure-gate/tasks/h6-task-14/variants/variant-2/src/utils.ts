/**
 * Utility functions for domain identity-provider-node
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_identity_provider_node(name: string): string {
  if (!name) return "identity-provider-node";
  return name.toLowerCase().trim();
}

export function generateTraceId_identity_provider_node(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_identity_provider_node(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_identity_provider_node<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_identity_provider_node(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_identity_provider_node(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_identity_provider_node(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
