/**
 * Correction-contract config (issue #1580 plus classify timeout).
 *
 * Extracted from config.ts so the grandfathered parser file does not grow.
 * Nested `correction.<key>` wins over the flat `correction<Key>` legacy key.
 * Invalid values throw — they are never clamped or silently defaulted.
 *
 * Reads stay inline on `cfg` so the parsed-key extractor records the same
 * paths the plugin schema declares.
 */
import { coerceBool, coerceNumber } from "../connectors/coerce.js";

export const DEFAULT_CORRECTION_CLASSIFY_TIMEOUT_MS = 45_000;
export const MAX_CORRECTION_CLASSIFY_TIMEOUT_MS = 300_000;

export interface ParsedCorrectionConfig {
  correctionEnabled: boolean;
  correctionApplyRequiresConfirm: boolean;
  correctionMaxAffected: number;
  correctionPlanTtlHours: number;
  correctionClassifyTimeoutMs: number;
}

export function parseCorrectionConfig(cfg: Record<string, unknown>): ParsedCorrectionConfig {
  return {
    correctionEnabled: (() => {
      const nested = (cfg.correction as Record<string, unknown> | undefined)?.enabled;
      const raw = nested !== undefined ? nested : cfg.correctionEnabled;
      if (raw === undefined || raw === null) return true;
      const value = coerceBool(raw);
      if (value === undefined) {
        throw new Error(`Invalid correction.enabled: expected a boolean, got ${JSON.stringify(raw)}`);
      }
      return value;
    })(),
    correctionApplyRequiresConfirm: (() => {
      const nested = (cfg.correction as Record<string, unknown> | undefined)?.applyRequiresConfirm;
      const raw = nested !== undefined ? nested : cfg.correctionApplyRequiresConfirm;
      if (raw === undefined || raw === null) return true;
      const value = coerceBool(raw);
      if (value === undefined) {
        throw new Error(`Invalid correction.applyRequiresConfirm: expected a boolean, got ${JSON.stringify(raw)}`);
      }
      return value;
    })(),
    correctionMaxAffected: (() => {
      const rawNested = (cfg.correction as Record<string, unknown> | undefined)?.maxAffected;
      const raw = rawNested !== undefined ? rawNested : cfg.correctionMaxAffected;
      if (raw === undefined || raw === null) return 10;
      const n = coerceNumber(raw);
      if (n === undefined || !Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
        throw new Error(`Invalid correction.maxAffected: expected an integer >= 1, got ${JSON.stringify(raw)}`);
      }
      return n;
    })(),
    correctionPlanTtlHours: (() => {
      const nested = (cfg.correction as Record<string, unknown> | undefined)?.planTtlHours;
      const fromNested = nested !== undefined ? coerceNumber(nested) : undefined;
      if (fromNested !== undefined && fromNested >= 1) return fromNested;
      if (nested !== undefined && fromNested === undefined) {
        throw new Error(`Invalid correction.planTtlHours: expected a number >= 1, got ${JSON.stringify(nested)}`);
      }
      if (fromNested !== undefined && fromNested < 1) {
        throw new Error(`Invalid correction.planTtlHours: expected a number >= 1, got ${JSON.stringify(nested)}`);
      }
      const fromFlat = coerceNumber(cfg.correctionPlanTtlHours);
      if (fromFlat !== undefined && fromFlat >= 1) return fromFlat;
      if (cfg.correctionPlanTtlHours !== undefined && fromFlat === undefined) {
        throw new Error(
          `Invalid correction.planTtlHours: expected a number >= 1, got ${JSON.stringify(cfg.correctionPlanTtlHours)}`
        );
      }
      if (fromFlat !== undefined && fromFlat < 1) {
        throw new Error(
          `Invalid correction.planTtlHours: expected a number >= 1, got ${JSON.stringify(cfg.correctionPlanTtlHours)}`
        );
      }
      return 24;
    })(),
    correctionClassifyTimeoutMs: (() => {
      const nested = (cfg.correction as Record<string, unknown> | undefined)?.classifyTimeoutMs;
      const raw = nested !== undefined ? nested : cfg.correctionClassifyTimeoutMs;
      if (raw === undefined || raw === null) return DEFAULT_CORRECTION_CLASSIFY_TIMEOUT_MS;
      const n = coerceNumber(raw);
      if (n === undefined || !Number.isInteger(n) || n < 1 || n > MAX_CORRECTION_CLASSIFY_TIMEOUT_MS) {
        throw new Error(
          `Invalid correction.classifyTimeoutMs: expected an integer from 1 to ${MAX_CORRECTION_CLASSIFY_TIMEOUT_MS}, got ${JSON.stringify(raw)}`
        );
      }
      return n;
    })(),
  };
}
