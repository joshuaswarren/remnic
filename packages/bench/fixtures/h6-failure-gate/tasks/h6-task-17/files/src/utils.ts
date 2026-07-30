/**
 * Utility functions for domain workflow-runner-engine
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_workflow_runner_engine(name: string): string {
  if (!name) return "workflow-runner-engine";
  return name.toLowerCase().trim();
}

export function generateTraceId_workflow_runner_engine(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_workflow_runner_engine(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_workflow_runner_engine<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_workflow_runner_engine(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_workflow_runner_engine(prefix: string, id: string): string {
  return `${prefix}:${id}:${Date.now()}`;
}

export function sleepMs_workflow_runner_engine(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
