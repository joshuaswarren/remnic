import { coerceBool, coerceNumber } from "../connectors/coerce.js";

export interface ProceduralMaintenanceConfig {
  enabled: boolean;
  retireIdleDays: number;
  retireMinOutcomes: number;
  retireFailRatio: number;
  mergeEnabled: boolean;
}

export function parseProceduralMaintenanceConfig(
  raw: unknown,
): ProceduralMaintenanceConfig {
  if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error(
      `procedural.maintenance must be an object (got ${JSON.stringify(raw)}). Omit the key to keep maintenance disabled (issue #2370).`,
    );
  }
  const rawMaintenance = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  let enabled = false;
  if (rawMaintenance.enabled !== undefined) {
    const coerced = coerceBool(rawMaintenance.enabled);
    if (coerced === undefined) {
      throw new Error(
        `procedural.maintenance.enabled must be a boolean or one of "true"/"false"/"1"/"0"/"yes"/"no"/"on"/"off" (got ${JSON.stringify(rawMaintenance.enabled)}).`,
      );
    }
    enabled = coerced;
  }
  const parseInteger = (key: string, fallback: number, min: number, max: number): number => {
    const value = rawMaintenance[key];
    if (value === undefined) return fallback;
    const coerced = coerceNumber(value);
    if (coerced === undefined || !Number.isFinite(coerced)) {
      throw new Error(
        `procedural.maintenance.${key} must be a finite number (got ${JSON.stringify(value)}).`,
      );
    }
    if (!Number.isInteger(coerced)) {
      throw new Error(
        `procedural.maintenance.${key} must be an integer (got ${JSON.stringify(value)}).`,
      );
    }
    if (coerced < min || coerced > max) {
      throw new Error(
        `procedural.maintenance.${key} must be between ${min} and ${max} (got ${JSON.stringify(value)}).`,
      );
    }
    return coerced;
  };
  let retireFailRatio = 2;
  if (rawMaintenance.retireFailRatio !== undefined) {
    const coerced = coerceNumber(rawMaintenance.retireFailRatio);
    if (coerced === undefined || !Number.isFinite(coerced) || coerced <= 0) {
      throw new Error(
        `procedural.maintenance.retireFailRatio must be a positive finite number (got ${JSON.stringify(rawMaintenance.retireFailRatio)}).`,
      );
    }
    retireFailRatio = coerced;
  }
  let mergeEnabled = true;
  if (rawMaintenance.mergeEnabled !== undefined) {
    const coerced = coerceBool(rawMaintenance.mergeEnabled);
    if (coerced === undefined) {
      throw new Error(
        `procedural.maintenance.mergeEnabled must be a boolean or one of "true"/"false"/"1"/"0"/"yes"/"no"/"on"/"off" (got ${JSON.stringify(rawMaintenance.mergeEnabled)}).`,
      );
    }
    mergeEnabled = coerced;
  }
  return {
    enabled,
    retireIdleDays: parseInteger("retireIdleDays", 90, 0, 36_500),
    retireMinOutcomes: parseInteger("retireMinOutcomes", 5, 1, 100_000),
    retireFailRatio,
    mergeEnabled,
  };
}
