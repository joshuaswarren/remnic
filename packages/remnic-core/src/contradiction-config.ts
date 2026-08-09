import { coerceBool, coerceNumber } from "./connectors/coerce.js";

/** Configuration for the nightly contradiction-scan cron (issue #520). */
export interface ContradictionScanConfig {
  /** Master switch for the contradiction scan cron. Default true. */
  enabled: boolean;
  /** Embedding cosine similarity floor for candidate pair generation. Default 0.82. */
  similarityFloor: number;
  /** Minimum topic-token Jaccard overlap for unstructured pairs. Default 0.4. */
  topicOverlapFloor: number;
  /** Cap on candidate pairs evaluated per cron run. Default 500. */
  maxPairsPerRun: number;
  /** Cooldown in days before re-evaluating a pair judged independent/both-valid. Default 14. */
  cooldownDays: number;
  /** When true, pairs judged "duplicates" are auto-flagged for dedup (still need user approval). Default false. */
  autoMergeDuplicates: boolean;
}

export interface ContradictionLocalizationConfig {
  /** Enable the entity/category anchor pass before QMD search. */
  anchorEnabled: boolean;
  /** Maximum anchor candidates. Zero disables the anchor pass. */
  anchorCandidates: number;
  /** Maximum QMD search candidates. Zero disables text search. */
  searchCandidates: number;
  /** Maximum merged candidates passed to contradiction verification. */
  maxCandidates: number;
}

export function parseContradictionScanConfig(raw: unknown): ContradictionScanConfig {
  if (!raw || typeof raw !== "object") {
    return {
      enabled: false,
      similarityFloor: 0.82,
      topicOverlapFloor: 0.4,
      maxPairsPerRun: 500,
      cooldownDays: 14,
      autoMergeDuplicates: false,
    };
  }
  const src = raw as Record<string, unknown>;
  const simFloor = coerceNumber(src.similarityFloor) ?? 0.82;
  const topicFloor = coerceNumber(src.topicOverlapFloor) ?? 0.4;
  const maxPairs = coerceNumber(src.maxPairsPerRun) ?? 500;
  const cooldown = coerceNumber(src.cooldownDays) ?? 14;
  return {
    enabled: coerceBool(src.enabled) === true,
    similarityFloor: Math.min(1, Math.max(0, simFloor)),
    topicOverlapFloor: Math.min(1, Math.max(0, topicFloor)),
    maxPairsPerRun: Math.max(1, maxPairs),
    cooldownDays: Math.max(0, cooldown),
    autoMergeDuplicates: coerceBool(src.autoMergeDuplicates) === true,
  };
}

export function parseContradictionLocalizationConfig(raw: unknown): ContradictionLocalizationConfig {
  const defaults: ContradictionLocalizationConfig = {
    anchorEnabled: true,
    anchorCandidates: 5,
    searchCandidates: 5,
    maxCandidates: 8,
  };
  if (raw === undefined || raw === null) return defaults;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("contradictionLocalization must be an object");
  }
  const src = raw as Record<string, unknown>;
  const rawEnabled = src.anchorEnabled;
  const anchorEnabled = rawEnabled === undefined || rawEnabled === null ? true : coerceBool(rawEnabled);
  if (anchorEnabled === undefined) {
    throw new Error("contradictionLocalization.anchorEnabled must be a boolean-like value");
  }

  const parseCap = (
    key: keyof Pick<ContradictionLocalizationConfig, "anchorCandidates" | "searchCandidates" | "maxCandidates">,
  ): number => {
    const rawValue = src[key];
    if (rawValue === undefined) return defaults[key];
    const parsed = coerceNumber(rawValue);
    if (parsed === undefined || !Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`contradictionLocalization.${key} must be an integer >= 0`);
    }
    return parsed;
  };

  return {
    anchorEnabled,
    anchorCandidates: parseCap("anchorCandidates"),
    searchCandidates: parseCap("searchCandidates"),
    maxCandidates: parseCap("maxCandidates"),
  };
}
