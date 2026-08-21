/**
 * Preference drift detection config (issue #2371).
 *
 * Standalone top-level block, parsed the same way `contradictionScan` and
 * `procedural.maintenance` are: shape-validated, string-coercion safe (§24),
 * and honoring documented zero/no-op values (§33) rather than clamping them
 * to something non-zero.
 */

import { coerceBool, coerceNumber } from "../connectors/coerce.js";

export interface DriftDetectionConfig {
  /** Master switch for drift classification and its apply mode. Default false. */
  enabled: boolean;
  /** A preference younger than this is never a scan candidate. Default 60. */
  minAgeDays: number;
  /** Evidence-gathering window, in days back from the run instant. Default 45. */
  lookbackDays: number;
  /** Cap on preferences classified per run. `0` disables the scan entirely. Default 25. */
  maxCandidatesPerRun: number;
  /** When true, recall damps `driftState: stale` preferences. Default false. */
  recallDamping: boolean;
  /** Multiplier applied to stale preferences in (0, 1]; `1` is a documented no-op. Default 0.8. */
  stalePenalty: number;
  /** Annotate injected preferences uncorroborated for this many days. `0` = off. Default 0. */
  annotateAfterDays: number;
}

export const DRIFT_DETECTION_DEFAULTS: DriftDetectionConfig = {
  enabled: false,
  minAgeDays: 60,
  lookbackDays: 45,
  maxCandidatesPerRun: 25,
  recallDamping: false,
  stalePenalty: 0.8,
  annotateAfterDays: 0,
};

function parseFlag(src: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = src[key];
  if (value === undefined || value === null) return fallback;
  const coerced = coerceBool(value);
  if (coerced === undefined) {
    throw new Error(
      `driftDetection.${key} must be a boolean or one of "true"/"false"/"1"/"0"/"yes"/"no"/"on"/"off" (got ${JSON.stringify(value)}).`,
    );
  }
  return coerced;
}

function parseDayCount(src: Record<string, unknown>, key: string, fallback: number): number {
  const value = src[key];
  if (value === undefined || value === null) return fallback;
  const coerced = coerceNumber(value);
  if (coerced === undefined || !Number.isFinite(coerced)) {
    throw new Error(`driftDetection.${key} must be a finite number (got ${JSON.stringify(value)}).`);
  }
  if (!Number.isInteger(coerced)) {
    throw new Error(`driftDetection.${key} must be an integer (got ${JSON.stringify(value)}).`);
  }
  if (coerced < 0 || coerced > 36_500) {
    throw new Error(`driftDetection.${key} must be between 0 and 36500 (got ${JSON.stringify(value)}).`);
  }
  return coerced;
}

export function parseDriftDetectionConfig(raw: unknown): DriftDetectionConfig {
  if (raw === undefined || raw === null) return { ...DRIFT_DETECTION_DEFAULTS };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `driftDetection must be an object (got ${JSON.stringify(raw)}). Omit the key to keep drift detection disabled (issue #2371).`,
    );
  }
  const src = raw as Record<string, unknown>;

  // `0` disables the scan and MUST survive as zero — the documented disable
  // value, never coerced up to a minimum (§33).
  const rawMax = src.maxCandidatesPerRun;
  let maxCandidatesPerRun = DRIFT_DETECTION_DEFAULTS.maxCandidatesPerRun;
  if (rawMax !== undefined && rawMax !== null) {
    const coerced = coerceNumber(rawMax);
    if (coerced === undefined || !Number.isInteger(coerced) || coerced < 0) {
      throw new Error(
        `driftDetection.maxCandidatesPerRun must be an integer >= 0 (got ${JSON.stringify(rawMax)}). Use 0 to disable the scan.`,
      );
    }
    maxCandidatesPerRun = coerced;
  }

  // stalePenalty is a multiplier in (0, 1]. `1` is the documented no-op; `0`
  // would erase a memory's rank entirely and is rejected rather than accepted
  // as a silent "delete from recall".
  const rawPenalty = src.stalePenalty;
  let stalePenalty = DRIFT_DETECTION_DEFAULTS.stalePenalty;
  if (rawPenalty !== undefined && rawPenalty !== null) {
    const coerced = coerceNumber(rawPenalty);
    if (coerced === undefined || !Number.isFinite(coerced) || coerced <= 0 || coerced > 1) {
      throw new Error(
        `driftDetection.stalePenalty must be a number in (0, 1] (got ${JSON.stringify(rawPenalty)}). Use 1 to disable damping without changing the flag.`,
      );
    }
    stalePenalty = coerced;
  }

  return {
    enabled: parseFlag(src, "enabled", DRIFT_DETECTION_DEFAULTS.enabled),
    minAgeDays: parseDayCount(src, "minAgeDays", DRIFT_DETECTION_DEFAULTS.minAgeDays),
    lookbackDays: parseDayCount(src, "lookbackDays", DRIFT_DETECTION_DEFAULTS.lookbackDays),
    maxCandidatesPerRun,
    recallDamping: parseFlag(src, "recallDamping", DRIFT_DETECTION_DEFAULTS.recallDamping),
    stalePenalty,
    annotateAfterDays: parseDayCount(
      src,
      "annotateAfterDays",
      DRIFT_DETECTION_DEFAULTS.annotateAfterDays,
    ),
  };
}
