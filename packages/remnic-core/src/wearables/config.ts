/**
 * Wearables config parsing — strict, loud, and default-safe.
 *
 * Mirrors the `procedural` block conventions in config.ts: shape
 * violations and unparseable values throw with actionable messages
 * (CLAUDE.md rule 51); boolean-ish strings coerce via the shared
 * helpers (rule 36); every numeric knob is bounds-checked; the
 * memory-creation default is the least-privileged mode (rule 48).
 */

import { coerceBool, coerceNumber } from "../connectors/coerce.js";
import type { ImportanceLevel } from "../types.js";
import { compileCorrectionRules } from "./corrections.js";
import { compileRedactionPatterns } from "./redaction.js";
import type {
  WearableCleanupSettings,
  WearableCorrectionRule,
  WearableMemoryMode,
  WearableSourceSettings,
  WearablesConfig,
} from "./types.js";

export const KNOWN_WEARABLE_SOURCE_IDS = ["limitless", "bee", "omi"] as const;

const MEMORY_MODES: WearableMemoryMode[] = ["off", "review", "auto"];
const IMPORTANCE_LEVELS: ImportanceLevel[] = [
  "trivial",
  "low",
  "normal",
  "high",
  "critical",
];
const NATIVE_IMPORT_MODES = ["off", "review"] as const;

const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_MIN_IMPORTANCE: ImportanceLevel = "low";
const DEFAULT_MAX_MEMORIES_PER_DAY = 20;
const MAX_MEMORIES_PER_DAY_CEILING = 500;

export function defaultWearableCleanupSettings(): WearableCleanupSettings {
  return {
    mergeSameSpeaker: true,
    stripFillers: true,
    collapseRepeats: true,
    dropLowQuality: true,
  };
}

export function defaultWearableSourceSettings(): WearableSourceSettings {
  return {
    enabled: false,
    memoryMode: "review",
    minConfidence: DEFAULT_MIN_CONFIDENCE,
    minImportance: DEFAULT_MIN_IMPORTANCE,
    maxMemoriesPerDay: DEFAULT_MAX_MEMORIES_PER_DAY,
    importNativeMemories: "off",
    cleanup: defaultWearableCleanupSettings(),
  };
}

export function defaultWearablesConfig(): WearablesConfig {
  return {
    enabled: false,
    redactionEnabled: true,
    redactionPatterns: [],
    offTheRecordEnabled: false,
    digestEnabled: false,
    corrections: [],
    sources: {},
  };
}

function requireObject(
  value: unknown,
  keyPath: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${keyPath} must be an object (got ${JSON.stringify(value)})`,
    );
  }
  return value as Record<string, unknown>;
}

function parseBool(
  value: unknown,
  keyPath: string,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;
  const coerced = coerceBool(value);
  if (coerced === undefined) {
    throw new Error(
      `${keyPath} must be a boolean or one of "true"/"false"/"1"/"0"/"yes"/"no"/"on"/"off" (got ${JSON.stringify(value)})`,
    );
  }
  return coerced;
}

function parseEnum<T extends string>(
  value: unknown,
  keyPath: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(
    `${keyPath} must be one of ${allowed.map((entry) => `"${entry}"`).join(", ")} (got ${JSON.stringify(value)})`,
  );
}

function parseOptionalString(
  value: unknown,
  keyPath: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${keyPath} must be a non-empty string when set`);
  }
  return value.trim();
}

function parseCorrectionRules(
  value: unknown,
  keyPath: string,
): WearableCorrectionRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${keyPath} must be an array of correction rules`);
  }
  const rules = value.map((entry, index) => {
    const raw = requireObject(entry, `${keyPath}[${index}]`);
    const rule: WearableCorrectionRule = {
      match: typeof raw.match === "string" ? raw.match : "",
      replace: typeof raw.replace === "string" ? raw.replace : "",
    };
    if (raw.regex !== undefined) {
      rule.regex = parseBool(raw.regex, `${keyPath}[${index}].regex`, false);
    }
    if (raw.caseInsensitive !== undefined) {
      rule.caseInsensitive = parseBool(
        raw.caseInsensitive,
        `${keyPath}[${index}].caseInsensitive`,
        true,
      );
    }
    if (raw.sources !== undefined) {
      if (
        !Array.isArray(raw.sources) ||
        raw.sources.some((source) => typeof source !== "string")
      ) {
        throw new Error(`${keyPath}[${index}].sources must be an array of strings`);
      }
      rule.sources = raw.sources as string[];
    }
    return rule;
  });
  // Compile now so bad rules fail at config load, not mid-sync.
  compileCorrectionRules(rules, keyPath);
  return rules;
}

function parseSourceSettings(
  value: unknown,
  keyPath: string,
): WearableSourceSettings {
  const raw = requireObject(value, keyPath);
  const defaults = defaultWearableSourceSettings();

  const minConfidenceRaw = coerceNumber(raw.minConfidence);
  // Out-of-range values reject loudly instead of clamping — silently
  // turning minConfidence 7 into 1 would change the memory gate in a
  // way the operator never asked for (Codex P2 on PR #1458, round 3).
  if (
    raw.minConfidence !== undefined &&
    (minConfidenceRaw === undefined || minConfidenceRaw < 0 || minConfidenceRaw > 1)
  ) {
    throw new Error(
      `${keyPath}.minConfidence must be a number between 0 and 1 (got ${JSON.stringify(raw.minConfidence)})`,
    );
  }
  const minConfidence = minConfidenceRaw ?? defaults.minConfidence;

  const maxPerDayRaw = coerceNumber(raw.maxMemoriesPerDay);
  // Reject non-integers instead of flooring them: 0.5 would floor to 0,
  // and 0 is the documented "disable the cap" value — a fractional typo
  // must not silently remove the cap (Codex P2 on PR #1458).
  if (
    raw.maxMemoriesPerDay !== undefined &&
    (maxPerDayRaw === undefined ||
      !Number.isInteger(maxPerDayRaw) ||
      maxPerDayRaw < 0 ||
      maxPerDayRaw > MAX_MEMORIES_PER_DAY_CEILING)
  ) {
    throw new Error(
      `${keyPath}.maxMemoriesPerDay must be an integer between 0 and ${MAX_MEMORIES_PER_DAY_CEILING} (0 disables the cap); got ${JSON.stringify(raw.maxMemoriesPerDay)}`,
    );
  }
  // 0 is the documented "disable the cap" value — honored here AND in
  // the schema minimum (CLAUDE.md rule 45).
  const maxMemoriesPerDay = maxPerDayRaw ?? defaults.maxMemoriesPerDay;

  const rawCleanup =
    raw.cleanup === undefined ? {} : requireObject(raw.cleanup, `${keyPath}.cleanup`);
  const cleanup: WearableCleanupSettings = {
    mergeSameSpeaker: parseBool(
      rawCleanup.mergeSameSpeaker,
      `${keyPath}.cleanup.mergeSameSpeaker`,
      defaults.cleanup.mergeSameSpeaker,
    ),
    stripFillers: parseBool(
      rawCleanup.stripFillers,
      `${keyPath}.cleanup.stripFillers`,
      defaults.cleanup.stripFillers,
    ),
    collapseRepeats: parseBool(
      rawCleanup.collapseRepeats,
      `${keyPath}.cleanup.collapseRepeats`,
      defaults.cleanup.collapseRepeats,
    ),
    dropLowQuality: parseBool(
      rawCleanup.dropLowQuality,
      `${keyPath}.cleanup.dropLowQuality`,
      defaults.cleanup.dropLowQuality,
    ),
  };

  return {
    enabled: parseBool(raw.enabled, `${keyPath}.enabled`, false),
    apiKey: parseOptionalString(raw.apiKey, `${keyPath}.apiKey`),
    baseUrl: parseOptionalString(raw.baseUrl, `${keyPath}.baseUrl`),
    appId: parseOptionalString(raw.appId, `${keyPath}.appId`),
    userId: parseOptionalString(raw.userId, `${keyPath}.userId`),
    memoryMode: parseEnum(
      raw.memoryMode,
      `${keyPath}.memoryMode`,
      MEMORY_MODES,
      defaults.memoryMode,
    ),
    minConfidence,
    minImportance: parseEnum(
      raw.minImportance,
      `${keyPath}.minImportance`,
      IMPORTANCE_LEVELS,
      defaults.minImportance,
    ),
    maxMemoriesPerDay,
    importNativeMemories: parseEnum(
      raw.importNativeMemories,
      `${keyPath}.importNativeMemories`,
      NATIVE_IMPORT_MODES,
      defaults.importNativeMemories,
    ),
    cleanup,
  };
}

/**
 * Parse the `wearables` config block. `undefined` yields the disabled
 * default config; any present-but-malformed value throws.
 */
export function parseWearablesConfig(value: unknown): WearablesConfig {
  if (value === undefined) return defaultWearablesConfig();
  const raw = requireObject(value, "wearables");
  const defaults = defaultWearablesConfig();

  const timezone = parseOptionalString(raw.timezone, "wearables.timezone");
  if (timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      throw new Error(
        `wearables.timezone must be a valid IANA timezone identifier (got ${JSON.stringify(timezone)})`,
      );
    }
  }

  let redactionPatterns: string[] = defaults.redactionPatterns;
  if (raw.redactionPatterns !== undefined) {
    if (
      !Array.isArray(raw.redactionPatterns) ||
      raw.redactionPatterns.some((pattern) => typeof pattern !== "string")
    ) {
      throw new Error("wearables.redactionPatterns must be an array of strings");
    }
    redactionPatterns = raw.redactionPatterns as string[];
    // Compile now so invalid regexes fail at config load.
    compileRedactionPatterns(redactionPatterns);
  }

  const sources: Record<string, WearableSourceSettings> = {};
  if (raw.sources !== undefined) {
    const rawSources = requireObject(raw.sources, "wearables.sources");
    for (const [sourceId, sourceValue] of Object.entries(rawSources)) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(sourceId)) {
        throw new Error(
          `wearables.sources keys must be lowercase source ids (letters, digits, dashes); got ${JSON.stringify(sourceId)}`,
        );
      }
      sources[sourceId] = parseSourceSettings(
        sourceValue,
        `wearables.sources.${sourceId}`,
      );
    }
  }

  return {
    enabled: parseBool(raw.enabled, "wearables.enabled", defaults.enabled),
    ...(timezone !== undefined ? { timezone } : {}),
    redactionEnabled: parseBool(
      raw.redactionEnabled,
      "wearables.redactionEnabled",
      defaults.redactionEnabled,
    ),
    redactionPatterns,
    offTheRecordEnabled: parseBool(
      raw.offTheRecordEnabled,
      "wearables.offTheRecordEnabled",
      defaults.offTheRecordEnabled,
    ),
    digestEnabled: parseBool(
      raw.digestEnabled,
      "wearables.digestEnabled",
      defaults.digestEnabled,
    ),
    corrections: parseCorrectionRules(raw.corrections, "wearables.corrections"),
    sources,
  };
}
