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
  const enabled = coerceBool(raw.enabled) ?? false;
  const intervalMinutes = typeof raw.intervalMinutes === "number" ? raw.intervalMinutes : 15;
  const fusionRaw = raw.fusion && typeof raw.fusion === "object" ? (raw.fusion as Rec) : {};
  const fusion = {
    enabled: coerceBool(fusionRaw.enabled) ?? false,
    gapMs: typeof fusionRaw.gapMs === "number" ? fusionRaw.gapMs : 1000,
  };
  const { label, ...unknown } = raw as { label?: string };
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
