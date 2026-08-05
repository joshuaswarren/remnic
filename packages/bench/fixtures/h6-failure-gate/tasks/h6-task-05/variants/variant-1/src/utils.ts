/**
 * Utility functions for domain hyperion-router-mesh
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_hyperion_router_mesh(name: string): string {
  if (!name) return "hyperion-router-mesh";
  return name.toLowerCase().trim();
}

export function generateTraceId_hyperion_router_mesh(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_hyperion_router_mesh(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_hyperion_router_mesh<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_hyperion_router_mesh(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_hyperion_router_mesh(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_hyperion_router_mesh(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
