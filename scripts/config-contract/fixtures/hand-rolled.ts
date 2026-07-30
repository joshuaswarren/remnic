/**
 * Fixture: hand-rolled parser in the house style (requireObject alias,
 * coercion helpers, nested block via a second alias, destructuring).
 */
type Rec = Record<string, unknown>;
function requireObject(value: unknown, _name: string): Rec {
  if (!value || typeof value !== "object") throw new Error("bad");
  return value as Rec;
}
function coerceBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export interface FixtureHandRolledConfig {
  enabled: boolean;
  intervalMinutes: number;
  fusion: { enabled: boolean; gapMs: number };
  label?: string;
}

export function parseFixtureHandRolledConfig(value: unknown): FixtureHandRolledConfig {
  const raw = requireObject(value, "fixture");
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  if (
    raw.intervalMinutes !== undefined &&
    (typeof raw.intervalMinutes !== "number" ||
      !Number.isFinite(raw.intervalMinutes) ||
      raw.intervalMinutes <= 0)
  ) {
    throw new Error("intervalMinutes must be a positive number");
  }
  if (
    raw.fusion !== undefined &&
    (!raw.fusion || typeof raw.fusion !== "object" || Array.isArray(raw.fusion))
  ) {
    throw new Error("fusion must be an object");
  }
  if (raw.label !== undefined && typeof raw.label !== "string") {
    throw new Error("label must be a string");
  }

  const fusionRaw = (raw.fusion as Rec | undefined) ?? {};
  if (fusionRaw.enabled !== undefined && typeof fusionRaw.enabled !== "boolean") {
    throw new Error("fusion.enabled must be a boolean");
  }
  if (
    fusionRaw.gapMs !== undefined &&
    (typeof fusionRaw.gapMs !== "number" ||
      !Number.isFinite(fusionRaw.gapMs) ||
      fusionRaw.gapMs < 0)
  ) {
    throw new Error("fusion.gapMs must be a non-negative number");
  }

  const enabled = coerceBool(raw.enabled) ?? false;
  const intervalMinutes = typeof raw.intervalMinutes === "number" ? raw.intervalMinutes : 15;
  const fusion = {
    enabled: coerceBool(fusionRaw.enabled) ?? false,
    gapMs: typeof fusionRaw.gapMs === "number" ? fusionRaw.gapMs : 1000,
  };
  const { enabled: _enabled, intervalMinutes: _intervalMinutes, fusion: _fusion, label, ...unknown } = raw;
  if (Object.keys(unknown).length > 0) throw new Error("unknown");
  return { enabled, intervalMinutes, fusion, label: typeof label === "string" ? label.trim() : undefined };
}

export function parseFixtureEntryConfig(raw: unknown): Rec {
  const cfg = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Rec) : {};
  const handRolled = parseFixtureHandRolledConfig(cfg["handRolled"]);
  return {
    handRolled,
    topLevelFlag: cfg.topLevelFlag === true,
    zodBlock: parseFixtureZodConfig(cfg.zodBlock),
    mixed: parseFixtureMixedConfig(cfg.mixed),
    dynamic: parseFixtureUnparseableConfig(cfg.dynamic),
  };
}

import { parseFixtureZodConfig } from "./zod-based.js";
import { parseFixtureMixedConfig } from "./mixed.js";
import { parseFixtureUnparseableConfig } from "./unparseable.js";
