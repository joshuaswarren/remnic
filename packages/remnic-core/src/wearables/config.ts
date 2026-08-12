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
  OffTheRecordMarkerSettings,
  WearableCleanupSettings,
  WearableCorrectionRule,
  WearableMemoryMode,
  WearableFusionConfig,
  WearableSourceSettings,
  WearablesConfig,
} from "./types.js";

export const KNOWN_WEARABLE_SOURCE_IDS = ["limitless", "bee", "omi"] as const;

const MEMORY_MODES: WearableMemoryMode[] = ["off", "review", "auto", "smart"];
const IMPORTANCE_LEVELS: ImportanceLevel[] = [
  "trivial",
  "low",
  "normal",
  "high",
  "critical",
];
const NATIVE_IMPORT_MODES = ["off", "review", "smart"] as const;

const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_MIN_IMPORTANCE: ImportanceLevel = "low";
// Uncapped by default — wearables capture full days and the smart trust
// pipeline is the quality gate; a count cap would drop real memories on
// busy days. Operators who want a ceiling set any positive integer.
const DEFAULT_MAX_MEMORIES_PER_DAY = 0;
const DEFAULT_AUTO_SYNC_ENABLED = true;
const DEFAULT_AUTO_SYNC_INTERVAL_MINUTES = 15;
const MAX_AUTO_SYNC_INTERVAL_MINUTES = 1440;
const DEFAULT_AUTO_SYNC_DAYS = 2;
const DEFAULT_AUTO_SYNC_DEEP_DAYS = 7;
const MAX_AUTO_SYNC_WINDOW_DAYS = 90;
const DEFAULT_SOURCE_TRUST = 0.8;
const DEFAULT_AUTO_APPROVE_TRUST = 0.7;
const DEFAULT_REVIEW_TRUST = 0.45;
// Cross-source fusion (#1810) — disabled by default; enabling is the
// only behavior change fusion introduces.
const DEFAULT_FUSION_ENABLED = false;
const DEFAULT_FUSION_PROXIMITY_GAP_MS = 300_000;
const DEFAULT_FUSION_WINDOW_TOLERANCE_MS = 30_000;

// Sources whose provider emits per-utterance text but unreliable
// speaker labels (Bee falls back to a generic "unknown" label when
// diarization is unavailable). For those, the cleanup default keeps
// utterance-level boundaries so a whole conversation does not collapse
// into one mega-segment (issue #1811). Other sources keep the legacy
// merge-everything default unless explicitly configured.
const BOUNDARY_PRESERVING_SOURCE_IDS = new Set<string>(["bee"]);

/**
 * Default cleanup settings. `sourceId` (the connector id this block
 * belongs to) only adjusts the `preserveUtteranceBoundaries` default —
 * every other toggle is identical across sources.
 */
export function defaultWearableCleanupSettings(
  sourceId?: string,
): WearableCleanupSettings {
  return {
    mergeSameSpeaker: true,
    stripFillers: true,
    collapseRepeats: true,
    dropLowQuality: true,
    preserveUtteranceBoundaries:
      sourceId !== undefined && BOUNDARY_PRESERVING_SOURCE_IDS.has(sourceId),
  };
}

export function defaultWearableSourceSettings(
  sourceId?: string,
): WearableSourceSettings {
  return {
    enabled: false,
    memoryMode: "smart",
    sourceTrust: DEFAULT_SOURCE_TRUST,
    autoApproveTrust: DEFAULT_AUTO_APPROVE_TRUST,
    reviewTrust: DEFAULT_REVIEW_TRUST,
    minConfidence: DEFAULT_MIN_CONFIDENCE,
    minImportance: DEFAULT_MIN_IMPORTANCE,
    maxMemoriesPerDay: DEFAULT_MAX_MEMORIES_PER_DAY,
    importNativeMemories: "smart",
    cleanup: defaultWearableCleanupSettings(sourceId),
  };
}

export function defaultWearableFusionConfig(): WearableFusionConfig {
  return {
    enabled: DEFAULT_FUSION_ENABLED,
    proximityGapMs: DEFAULT_FUSION_PROXIMITY_GAP_MS,
    windowToleranceMs: DEFAULT_FUSION_WINDOW_TOLERANCE_MS,
  };
}

export function defaultWearablesConfig(): WearablesConfig {
  return {
    enabled: false,
    redactionEnabled: true,
    redactionPatterns: [],
    offTheRecordEnabled: true,
    offTheRecordMarkers: { start: [], end: [], useBuiltIns: true },
    fillerTokens: [],
    digestEnabled: true,
    autoSyncEnabled: DEFAULT_AUTO_SYNC_ENABLED,
    autoSyncIntervalMinutes: DEFAULT_AUTO_SYNC_INTERVAL_MINUTES,
    autoSyncDays: DEFAULT_AUTO_SYNC_DAYS,
    autoSyncDeepDays: DEFAULT_AUTO_SYNC_DEEP_DAYS,
    corrections: [],
    sources: {},
    fusion: defaultWearableFusionConfig(),
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

/** Longest accepted off-the-record marker phrase. */
const MAX_MARKER_PHRASE_LENGTH = 128;
/** Longest accepted filler token. */
const MAX_FILLER_TOKEN_LENGTH = 64;

/**
 * Parse an optional array of non-empty phrases. Rejects a non-array, a
 * non-string entry, a blank entry, and an over-long entry — an operator
 * privacy phrase that is silently discarded is the failure this parser
 * exists to prevent (issue #2196).
 */
function parsePhraseList(
  value: unknown,
  keyPath: string,
  maxLength: number,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${keyPath} must be an array of strings`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`${keyPath}[${index}] must be a non-empty string`);
    }
    if (entry.length > maxLength) {
      throw new Error(`${keyPath}[${index}] exceeds ${maxLength} characters`);
    }
    return entry.trim();
  });
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
  sourceId: string,
): WearableSourceSettings {
  const raw = requireObject(value, keyPath);
  const defaults = defaultWearableSourceSettings(sourceId);

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
      maxPerDayRaw < 0)
  ) {
    throw new Error(
      `${keyPath}.maxMemoriesPerDay must be a non-negative integer (0, the default, disables the cap); got ${JSON.stringify(raw.maxMemoriesPerDay)}`,
    );
  }
  // 0 is the documented "disable the cap" value — honored here AND in
  // the schema minimum (CLAUDE.md rule 45).
  const maxMemoriesPerDay = maxPerDayRaw ?? defaults.maxMemoriesPerDay;

  const parseUnitInterval = (value: unknown, name: string, fallback: number): number => {
    if (value === undefined) return fallback;
    const coerced = coerceNumber(value);
    if (coerced === undefined || coerced < 0 || coerced > 1) {
      throw new Error(
        `${keyPath}.${name} must be a number between 0 and 1 (got ${JSON.stringify(value)})`,
      );
    }
    return coerced;
  };
  const sourceTrust = parseUnitInterval(raw.sourceTrust, "sourceTrust", defaults.sourceTrust);
  const autoApproveTrust = parseUnitInterval(
    raw.autoApproveTrust,
    "autoApproveTrust",
    defaults.autoApproveTrust,
  );
  const reviewTrust = parseUnitInterval(raw.reviewTrust, "reviewTrust", defaults.reviewTrust);
  if (reviewTrust >= autoApproveTrust) {
    throw new Error(
      `${keyPath}.reviewTrust (${reviewTrust}) must be below autoApproveTrust (${autoApproveTrust})`,
    );
  }

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
    preserveUtteranceBoundaries: parseBool(
      rawCleanup.preserveUtteranceBoundaries,
      `${keyPath}.cleanup.preserveUtteranceBoundaries`,
      // Optional on the type; the per-source default is always concrete.
      defaults.cleanup.preserveUtteranceBoundaries ?? false,
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
    sourceTrust,
    autoApproveTrust,
    reviewTrust,
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
function parseFusionSettings(
  value: unknown,
  keyPath: string,
): WearableFusionConfig {
  if (value === undefined) return defaultWearableFusionConfig();
  const raw = requireObject(value, keyPath);
  const defaults = defaultWearableFusionConfig();
  const parsePositiveInt = (
    value: unknown,
    name: string,
    fallback: number,
  ): number => {
    if (value === undefined) return fallback;
    const coerced = coerceNumber(value);
    if (coerced === undefined || !Number.isInteger(coerced) || coerced <= 0) {
      throw new Error(
        `${keyPath}.${name} must be a positive integer (got ${JSON.stringify(value)})`,
      );
    }
    return coerced;
  };
  return {
    enabled: parseBool(raw.enabled, `${keyPath}.enabled`, defaults.enabled),
    proximityGapMs: parsePositiveInt(
      raw.proximityGapMs,
      "proximityGapMs",
      defaults.proximityGapMs,
    ),
    windowToleranceMs: parsePositiveInt(
      raw.windowToleranceMs,
      "windowToleranceMs",
      defaults.windowToleranceMs,
    ),
  };
}

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

  const offTheRecordEnabled = parseBool(
    raw.offTheRecordEnabled,
    "wearables.offTheRecordEnabled",
    defaults.offTheRecordEnabled,
  );
  const rawMarkers =
    raw.offTheRecordMarkers === undefined
      ? {}
      : requireObject(raw.offTheRecordMarkers, "wearables.offTheRecordMarkers");
  // A typo such as `starts:` would otherwise be dropped without a word,
  // and the operator would believe a private span is protected. Core and
  // standalone callers never see OpenClaw's JSON schema, so the check
  // belongs here. Keys are compared literally so the config-contract
  // extractor can still enumerate this parser's surface.
  const {
    start: rawMarkerStart,
    end: rawMarkerEnd,
    useBuiltIns: rawMarkerUseBuiltIns,
    ...unknownMarkerKeys
  } = rawMarkers;
  const unknownMarkerNames = Object.keys(unknownMarkerKeys);
  if (unknownMarkerNames.length > 0) {
    throw new Error(
      `wearables.offTheRecordMarkers has unknown key(s) ${unknownMarkerNames.sort().join(", ")} — valid keys are start, end, useBuiltIns`,
    );
  }
  const offTheRecordMarkers: OffTheRecordMarkerSettings = {
    start: parsePhraseList(
      rawMarkerStart,
      "wearables.offTheRecordMarkers.start",
      MAX_MARKER_PHRASE_LENGTH,
    ),
    end: parsePhraseList(
      rawMarkerEnd,
      "wearables.offTheRecordMarkers.end",
      MAX_MARKER_PHRASE_LENGTH,
    ),
    useBuiltIns: parseBool(
      rawMarkerUseBuiltIns,
      "wearables.offTheRecordMarkers.useBuiltIns",
      defaults.offTheRecordMarkers.useBuiltIns,
    ),
  };
  // A silent no-op is the exact failure this feature exists to remove
  // (issue #2196): turning the built-ins off without supplying a start
  // phrase would leave the gate on and matching nothing.
  if (
    offTheRecordEnabled &&
    !offTheRecordMarkers.useBuiltIns &&
    offTheRecordMarkers.start.length === 0
  ) {
    throw new Error(
      "wearables.offTheRecordMarkers.useBuiltIns is false but no start phrase is configured — add wearables.offTheRecordMarkers.start, or set wearables.offTheRecordEnabled to false",
    );
  }

  const fillerTokens = parsePhraseList(
    raw.fillerTokens,
    "wearables.fillerTokens",
    MAX_FILLER_TOKEN_LENGTH,
  );

  const parseBoundedInt = (
    value: unknown,
    name: string,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    if (value === undefined) return fallback;
    const coerced = coerceNumber(value);
    if (
      coerced === undefined ||
      !Number.isInteger(coerced) ||
      coerced < min ||
      coerced > max
    ) {
      throw new Error(
        `${name} must be an integer between ${min} and ${max}; got ${JSON.stringify(value)}`,
      );
    }
    return coerced;
  };
  const autoSyncIntervalMinutes = parseBoundedInt(
    raw.autoSyncIntervalMinutes,
    "wearables.autoSyncIntervalMinutes",
    defaults.autoSyncIntervalMinutes,
    1,
    MAX_AUTO_SYNC_INTERVAL_MINUTES,
  );
  const autoSyncDays = parseBoundedInt(
    raw.autoSyncDays,
    "wearables.autoSyncDays",
    defaults.autoSyncDays,
    1,
    MAX_AUTO_SYNC_WINDOW_DAYS,
  );
  const autoSyncDeepDays = parseBoundedInt(
    raw.autoSyncDeepDays,
    "wearables.autoSyncDeepDays",
    defaults.autoSyncDeepDays,
    0,
    MAX_AUTO_SYNC_WINDOW_DAYS,
  );
  // A deep window narrower than the every-tick window would make the
  // "deep" pass fetch LESS than a normal tick — reject the confusion
  // instead of silently honoring it (0 disables the deep pass).
  if (autoSyncDeepDays !== 0 && autoSyncDeepDays < autoSyncDays) {
    throw new Error(
      `wearables.autoSyncDeepDays must be 0 (disabled) or >= wearables.autoSyncDays (${autoSyncDays}); got ${autoSyncDeepDays}`,
    );
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
        sourceId,
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
    offTheRecordEnabled,
    offTheRecordMarkers,
    fillerTokens,
    digestEnabled: parseBool(
      raw.digestEnabled,
      "wearables.digestEnabled",
      defaults.digestEnabled,
    ),
    autoSyncEnabled: parseBool(
      raw.autoSyncEnabled,
      "wearables.autoSyncEnabled",
      defaults.autoSyncEnabled,
    ),
    autoSyncIntervalMinutes,
    autoSyncDays,
    autoSyncDeepDays,
    fusion: parseFusionSettings(raw.fusion, "wearables.fusion"),
    corrections: parseCorrectionRules(raw.corrections, "wearables.corrections"),
    sources,
  };
}
