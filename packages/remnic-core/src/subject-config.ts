
import { coerceBool, coerceNumber } from "./connectors/coerce.js";
import {
  isSubjectGuardMode,
  PROMOTION_CANDIDATES_DEFAULT_MIN_ACCESS,
} from "./memory-subject.js";
import type { SubjectGuardMode } from "./types.js";

export interface SubjectRuntimeConfig {
  subjectClassification: { enabled: boolean };
  subjectGuard: SubjectGuardMode;
  promotionCandidates: { minAccessCount: number };
}

function assertObjectBlock(value: unknown, key: string, shape: string): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `${key} must be an object (got ${JSON.stringify(value)}). Use ${shape} (issue #2372).`,
    );
  }
}

export function parseSubjectRuntimeConfig(cfg: Record<string, unknown>): SubjectRuntimeConfig {
  assertObjectBlock(cfg.subjectClassification, "subjectClassification", "subjectClassification: { enabled: true }");
  const classification = (cfg.subjectClassification ?? {}) as Record<string, unknown>;
  const rawEnabled = classification.enabled;
  const enabledCoerced = coerceBool(rawEnabled);
  if (rawEnabled !== undefined && enabledCoerced === undefined) {
    throw new Error(
      `subjectClassification.enabled must be a boolean or one of "true"/"false"/"1"/"0"/` +
        `"yes"/"no"/"on"/"off" (got ${JSON.stringify(rawEnabled)}) — rejected, not defaulted (issue #2372).`,
    );
  }
  const rawGuard = cfg.subjectGuard;
  if (rawGuard !== undefined && !isSubjectGuardMode(rawGuard)) {
    throw new Error(
      `subjectGuard must be one of: off, warn, enforce (got ${JSON.stringify(rawGuard)}) — ` +
        `rejected, not defaulted (issue #2372; checklist §1/§39).`,
    );
  }
  assertObjectBlock(cfg.promotionCandidates, "promotionCandidates", "promotionCandidates: { minAccessCount: 3 }");
  const candidates = (cfg.promotionCandidates ?? {}) as Record<string, unknown>;
  const minAccessRaw = coerceNumber(candidates.minAccessCount);
  if (candidates.minAccessCount !== undefined && (minAccessRaw === undefined || !Number.isFinite(minAccessRaw) || minAccessRaw < 0)) {
    throw new Error(
      `promotionCandidates.minAccessCount must be a non-negative number (got ${JSON.stringify(candidates.minAccessCount)}) — rejected, not defaulted (issue #2372).`,
    );
  }
  return {
    subjectClassification: { enabled: rawEnabled === undefined ? false : enabledCoerced === true },
    subjectGuard: isSubjectGuardMode(rawGuard) ? rawGuard : "warn",
    promotionCandidates: {
      minAccessCount:
        minAccessRaw !== undefined ? Math.floor(minAccessRaw) : PROMOTION_CANDIDATES_DEFAULT_MIN_ACCESS,
    },
  };
}
