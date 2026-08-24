/**
 * Deep-recall config (issue #2332) — the `deepRecall` block.
 *
 * Parsed the same way `driftDetection` and `contradictionScan` are:
 * shape-validated, string-coercion safe (§24), and honoring documented
 * zero/no-op values (§33) rather than clamping them to something non-zero.
 * `maxSteps: 0` disables the policy loop (seed-only retrieval);
 * `maxResults: 0` returns an empty entry list; `maxExpandPerStep: 0`
 * lets the policy pick EXPAND but select nothing. Millisecond fields
 * of `0` mean "no timeout on that axis".
 */

import { coerceBool, coerceNumber } from "./connectors/coerce.js";

export interface DeepRecallConfig {
  /** Master switch for the deep-recall surface. Default false. */
  enabled: boolean;
  /** Policy iterations; 0 disables the loop (seed-only). Default 4. */
  maxSteps: number;
  /** Per-step cap on frontier nodes pulled into the working set. Default 3. */
  maxExpandPerStep: number;
  /** Final working-set cap returned to the caller. Default 12. */
  maxResults: number;
  /** Per policy-call timeout in ms; 0 = none. Default 10000. */
  stepTimeoutMs: number;
  /** Whole-invocation wall-clock timeout in ms; 0 = none. Default 45000. */
  totalTimeoutMs: number;
}

export interface DeepRecallSettings {
  deepRecall: DeepRecallConfig;
}

export const DEEP_RECALL_CONFIG_DEFAULTS: DeepRecallConfig = {
  enabled: false,
  maxSteps: 4,
  maxExpandPerStep: 3,
  maxResults: 12,
  stepTimeoutMs: 10000,
  totalTimeoutMs: 45000,
};

function parseFlag(src: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = src[key];
  if (value === undefined || value === null) return fallback;
  const coerced = coerceBool(value);
  if (coerced === undefined) {
    throw new Error(`deepRecall.${key} must be a boolean (or "true"/"false"/"1"/"0"); got ${JSON.stringify(value)}`);
  }
  return coerced;
}

function parseCount(src: Record<string, unknown>, key: string, fallback: number): number {
  const value = src[key];
  if (value === undefined || value === null) return fallback;
  const coerced = coerceNumber(value);
  if (coerced === undefined || !Number.isFinite(coerced)) {
    throw new Error(`deepRecall.${key} must be a finite number; got ${JSON.stringify(value)}`);
  }
  if (!Number.isInteger(coerced)) {
    throw new Error(`deepRecall.${key} must be an integer; got ${JSON.stringify(value)}`);
  }
  if (coerced < 0) {
    throw new Error(`deepRecall.${key} must not be negative; got ${JSON.stringify(value)}`);
  }
  return coerced;
}

export function parseDeepRecallConfig(raw: unknown): DeepRecallConfig {
  if (raw === undefined || raw === null) return { ...DEEP_RECALL_CONFIG_DEFAULTS };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`deepRecall must be an object; got ${JSON.stringify(raw)}`);
  }
  const src = raw as Record<string, unknown>;
  return {
    enabled: parseFlag(src, "enabled", DEEP_RECALL_CONFIG_DEFAULTS.enabled),
    maxSteps: parseCount(src, "maxSteps", DEEP_RECALL_CONFIG_DEFAULTS.maxSteps),
    maxExpandPerStep: parseCount(src, "maxExpandPerStep", DEEP_RECALL_CONFIG_DEFAULTS.maxExpandPerStep),
    maxResults: parseCount(src, "maxResults", DEEP_RECALL_CONFIG_DEFAULTS.maxResults),
    stepTimeoutMs: parseCount(src, "stepTimeoutMs", DEEP_RECALL_CONFIG_DEFAULTS.stepTimeoutMs),
    totalTimeoutMs: parseCount(src, "totalTimeoutMs", DEEP_RECALL_CONFIG_DEFAULTS.totalTimeoutMs),
  };
}

/**
 * Strict request-surface parse of an optional `maxSteps` override
 * (issue #2915). Shared by MCP, HTTP, and CLI so every boundary rejects the
 * same way instead of silently defaulting: absent/null is `undefined`;
 * anything else must be a non-negative integer — a JS integer number, or a
 * string whose trimmed form is bare digits. Malformed (`"abc"`), empty
 * (`""`), fractional (`"1.5"` / `1.5`), negative, and non-number values
 * throw instead of falling back to the configured default (§39).
 */
export function parseDeepRecallMaxSteps(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0) {
      throw new Error(`maxSteps must be a non-negative integer; got ${JSON.stringify(raw)}`);
    }
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^[0-9]+$/.test(trimmed)) {
      throw new Error(`maxSteps must be a non-negative integer; got ${JSON.stringify(raw)}`);
    }
    return Number(trimmed);
  }
  throw new Error(`maxSteps must be a non-negative integer; got ${JSON.stringify(raw)}`);
}
