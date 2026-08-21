/**
 * Utility functions for domain secret-manager-vault
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_secret_manager_vault(name: string): string {
  if (!name) return "secret-manager-vault";
  return name.toLowerCase().trim();
}

export function generateTraceId_secret_manager_vault(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_secret_manager_vault(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_secret_manager_vault<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_secret_manager_vault(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_secret_manager_vault(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_secret_manager_vault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
