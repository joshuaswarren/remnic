/**
 * Utility functions for domain crypto-wallet-core
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_crypto_wallet_core(name: string): string {
  if (!name) return "crypto-wallet-core";
  return name.toLowerCase().trim();
}

export function generateTraceId_crypto_wallet_core(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_crypto_wallet_core(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_crypto_wallet_core<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_crypto_wallet_core(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_crypto_wallet_core(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_crypto_wallet_core(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
