/**
 * Utility functions for domain quillboard-inventory-sync
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_quillboard_inventory_sync(name: string): string {
  if (!name) return "quillboard-inventory-sync";
  return name.toLowerCase().trim();
}

export function generateTraceId_quillboard_inventory_sync(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_quillboard_inventory_sync(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_quillboard_inventory_sync<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_quillboard_inventory_sync(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_quillboard_inventory_sync(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_quillboard_inventory_sync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
