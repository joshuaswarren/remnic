import { coerceNumber } from "./connectors/coerce.js";

export function parseQmdSupportedVersion(value: unknown): string {
  if (value === undefined || value === null) return "2.5.3";
  if (typeof value !== "string") {
    throw new Error(`qmdSupportedVersion must be a semantic version string; got ${JSON.stringify(value)}`);
  }
  const normalized = value.trim();
  if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
    throw new Error(
      `qmdSupportedVersion must be a semantic version string like "2.5.3"; got ${JSON.stringify(value)}`,
    );
  }
  return normalized;
}

export function parseQmdGpuBackend(value: unknown): "auto" | "metal" | "cuda" | "vulkan" | "false" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === false) return "false";
  if (typeof value !== "string") {
    throw new Error(`qmdGpuBackend must be one of "auto", "metal", "cuda", "vulkan", or false; got ${JSON.stringify(value)}`);
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "auto" ||
    normalized === "metal" ||
    normalized === "cuda" ||
    normalized === "vulkan" ||
    normalized === "false"
  ) {
    return normalized;
  }
  throw new Error(`qmdGpuBackend must be one of "auto", "metal", "cuda", "vulkan", or false; got ${JSON.stringify(value)}`);
}

export function parseQmdChunkStrategy(value: unknown): "auto" | "regex" {
  if (value === undefined || value === null) return "auto";
  if (typeof value !== "string") {
    throw new Error(`qmdChunkStrategy must be "auto" or "regex"; got ${JSON.stringify(value)}`);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto" || normalized === "regex") return normalized;
  throw new Error(`qmdChunkStrategy must be "auto" or "regex"; got ${JSON.stringify(value)}`);
}

// Issue #1335. Default "hybrid" preserves the historical lex+vec+hyde daemon plan.
export function parseQmdSearchStrategy(value: unknown): "hybrid" | "lex-vec" | "lex" {
  if (value === undefined || value === null) return "hybrid";
  if (typeof value !== "string") {
    throw new Error(
      `qmdSearchStrategy must be one of "hybrid", "lex-vec", or "lex"; got ${JSON.stringify(value)}`,
    );
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "hybrid" || normalized === "lex-vec" || normalized === "lex") {
    return normalized;
  }
  throw new Error(
    `qmdSearchStrategy must be one of "hybrid", "lex-vec", or "lex"; got ${JSON.stringify(value)}`,
  );
}

// Issue #1335. Reject non-numeric / non-integer timeouts rather than silently
// coercing them (gotcha #51), then clamp valid integers to the documented bounds.
export function parseQmdDaemonTimeoutMs(value: unknown): number {
  if (value === undefined || value === null) return 8_000;
  const coerced = coerceNumber(value);
  if (coerced === undefined || !Number.isInteger(coerced)) {
    throw new Error(
      `qmdDaemonTimeoutMs must be an integer number of milliseconds between 1000 and 120000; got ${JSON.stringify(value)}`,
    );
  }
  return Math.min(120_000, Math.max(1_000, coerced));
}

// Issue #1335. Default "query" keeps `qmd query` (LLM expansion + rerank) per gotcha #7.
export function parseQmdSubprocessStrategy(value: unknown): "query" | "search" {
  if (value === undefined || value === null) return "query";
  if (typeof value !== "string") {
    throw new Error(
      `qmdSubprocessStrategy must be one of "query" or "search"; got ${JSON.stringify(value)}`,
    );
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "query" || normalized === "search") return normalized;
  throw new Error(
    `qmdSubprocessStrategy must be one of "query" or "search"; got ${JSON.stringify(value)}`,
  );
}
