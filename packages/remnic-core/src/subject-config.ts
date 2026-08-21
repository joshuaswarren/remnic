/**
 * Config parsing for the memory-subject runtime knobs (issue #2372).
 *
 * Extracted from config.ts (its structural-ratchet ceiling forbids growth);
 * `parseConfig` spreads `parseSubjectRuntimeConfig(cfg)` into the plugin
 * config literal.
 *
 * Validation posture (Review Prevention Checklist §1/§24/§39): invalid
 * values are REJECTED loudly, never silently reinterpreted — but an omitted
 * key takes the documented default. The deliberate asymmetry from the issue
 * stands: classification defaults OFF while the guard defaults "warn", so
 * enabling classification later immediately yields promotion warnings
 * without a second flag flip, and with classification off, unstamped
 * memories still only warn (never silently promote) at shared targets.
 */

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

/**
 * Reject a non-object block loudly (rule 51 / §1): a shorthand like
 * `subjectClassification: false` must never normalize silently to `{}`.
 * Returns void so callers read the block through a DIRECT `cfg.<key>`
 * member access — the config-contract parser walker derives nested key
 * paths from those accesses, and a helper return value hides them.
 */
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
