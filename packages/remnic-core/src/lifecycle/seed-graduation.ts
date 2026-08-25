/**
 * Corroboration-graduated seed memories (issue #2974) — foundation layer.
 *
 * A `pending_review` memory is a SEED: it must not enter active recall on its
 * own say-so. This module decides, deterministically, when later evidence has
 * corroborated a seed enough to graduate it to `active` in place:
 *
 *  - corroboration is token-coverage similarity (same recall tokenizer the
 *    wearable trust pipeline uses — no LLM on this path),
 *  - the corroborating memory must come from an INDEPENDENT provenance: a
 *    different session than the seed's, a different source when session
 *    anchors are absent, and never a lineage descendant of the seed,
 *  - echo is suppressed: when the caller can show the evidence's session
 *    RECALLED the seed (the store's own content quoted back), that evidence
 *    never counts — otherwise recall would manufacture its own confirmation.
 *
 * Promotion itself reuses the existing in-place `pending_review -> active`
 * machinery (`StorageManager.promoteWearableMemory`, the same status flip the
 * wearable cross-device corroboration path uses) — no parallel write path.
 * Every graduation stamps the corroborating evidence ids on the promoted row
 * (audit surface; the lifecycle ledger already records the status transition).
 *
 * Foundation scope: the gate, the pass, and the config parser. Wiring the key
 * into `parseConfig` (config.ts sits at its size ratchet), the conservative
 * preset pin, scheduling inside the lifecycle sweep, contradiction holds, and
 * the docs/manifest surface are follow-up layers on this issue.
 */

import { normalizeRecallTokens } from "../recall-tokenization.js";
import { stripAttributesSuffix } from "../storage.js";
import { STRUCTURED_ATTRIBUTE_LIMITS } from "../write-envelope.js";
import { excludeSupportPassportPrivateMemories } from "../support-passport/card-projection.js";
import type { MemoryFile, MemoryFrontmatter, MemoryStatus } from "../types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SeedGraduationConfig {
  /** Master gate. Default false: review-mode stays the only promotion path. */
  enabled: boolean;
  /**
   * Independent corroborating memories required before a seed graduates.
   * `Infinity` is not a config value — `enabled: false` is the disabled state.
   */
  minCorroborations: number;
}

export const SEED_GRADUATION_DEFAULTS: SeedGraduationConfig = {
  enabled: false,
  minCorroborations: 2,
};

const SEED_GRADUATION_MAX_CORROBORATIONS = 50;

const BOOLEAN_LIKE: Record<string, boolean> = {
  true: true, "1": true, yes: true, on: true,
  false: false, "0": false, no: false, off: false,
};

function parseFlag(src: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const raw = src[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === "boolean") return raw;
  const coerced = BOOLEAN_LIKE[String(raw).toLowerCase()];
  if (coerced === undefined) {
    throw new Error(
      `seedGraduation.${key} must be a boolean or one of "true"/"false"/"1"/"0"/"yes"/"no"/"on"/"off" (got ${JSON.stringify(raw)}).`,
    );
  }
  return coerced;
}

/**
 * Strict parse (reject, never silently default — same contract as
 * `driftDetection`). Invalid values throw at config load.
 */
export function parseSeedGraduationConfig(raw: unknown): SeedGraduationConfig {
  if (raw === undefined || raw === null) return { ...SEED_GRADUATION_DEFAULTS };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `seedGraduation must be an object (got ${JSON.stringify(raw)}). Omit the key to keep seed graduation disabled (issue #2974).`,
    );
  }
  const src = raw as Record<string, unknown>;
  const rawMin = src.minCorroborations;
  let minCorroborations = SEED_GRADUATION_DEFAULTS.minCorroborations;
  if (rawMin !== undefined && rawMin !== null) {
    const n = typeof rawMin === "number" ? rawMin : Number(rawMin);
    if (!Number.isInteger(n) || n < 1 || n > SEED_GRADUATION_MAX_CORROBORATIONS) {
      throw new Error(
        `seedGraduation.minCorroborations must be an integer in [1, ${SEED_GRADUATION_MAX_CORROBORATIONS}] (got ${JSON.stringify(rawMin)}). Use enabled: false to disable graduation.`,
      );
    }
    minCorroborations = n;
  }
  return {
    enabled: parseFlag(src, "enabled", SEED_GRADUATION_DEFAULTS.enabled),
    minCorroborations,
  };
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * Fraction of the seed's tokens an evidence memory must carry to count as
 * restating it. Mirrors the wearable trust pipeline's existing-memory
 * support coverage (`MEMORY_SUPPORT_COVERAGE` = 0.7).
 */
const SEED_CORROBORATION_COVERAGE = 0.7;

/** Below this many distinct tokens a seed cannot be corroborated deterministically. */
const MIN_SEED_TOKENS = 4;

/** Structured-attribute key carrying the writing session's anchor, when known. */
const SESSION_ANCHOR_KEY = "sessionKey";

/** Reads a session anchor from frontmatter attributes; absent when unknown. */
function sessionAnchor(frontmatter: MemoryFrontmatter): string | undefined {
  const value = frontmatter.structuredAttributes?.[SESSION_ANCHOR_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function createdMs(memory: MemoryFile): number {
  const ms = Date.parse(memory.frontmatter.created);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/** Evidence rows eligible to corroborate: active or also awaiting review. */
function isEvidenceStatus(status: MemoryStatus | undefined): boolean {
  return status === undefined || status === "active" || status === "pending_review";
}

function hasLineageLink(seed: MemoryFile, evidence: MemoryFile): boolean {
  const seedLineage = seed.frontmatter.lineage;
  if (seedLineage !== undefined && seedLineage.includes(evidence.frontmatter.id)) return true;
  const evidenceLineage = evidence.frontmatter.lineage;
  if (evidenceLineage !== undefined && evidenceLineage.includes(seed.frontmatter.id)) return true;
  return false;
}

/**
 * Deterministic independence test. A seed can never corroborate itself, so
 * every anchor the two rows share disqualifies the evidence (fail closed):
 *
 *  - lineage descent either way is derivation, not corroboration;
 *  - when both rows carry session anchors, the SAME session that wrote the
 *    seed cannot corroborate it;
 *  - without session anchors, provenance identity falls back to the source
 *    string — identical provenance is never independent.
 */
function isIndependentProvenance(seed: MemoryFile, evidence: MemoryFile): boolean {
  if (hasLineageLink(seed, evidence)) return false;
  const seedSession = sessionAnchor(seed.frontmatter);
  const evidenceSession = sessionAnchor(evidence.frontmatter);
  if (seedSession !== undefined && evidenceSession !== undefined) {
    return seedSession !== evidenceSession;
  }
  return evidence.frontmatter.source !== seed.frontmatter.source;
}

/** Reads the token coverage of `seed`'s tokens inside `evidence`'s body. */
function coverageOf(seedTokens: ReadonlySet<string>, evidence: MemoryFile): number {
  if (seedTokens.size === 0) return 0;
  const evidenceTokens = new Set(normalizeRecallTokens(stripAttributesSuffix(evidence.content)));
  let matches = 0;
  for (const token of seedTokens) {
    if (evidenceTokens.has(token)) matches += 1;
  }
  return matches / seedTokens.size;
}

/**
 * Per-session recall history seam, satisfied by
 * `RecallHandleHistoryStore.recent(sessionKey)`: the memory-id sets a session
 * has recalled, newest first. Used ONLY to suppress echo — a session that
 * recalled the seed and then produced a lookalike memory confirmed nothing.
 */
export type SeedRecallEchoLookup = (sessionKey: string) => readonly (readonly string[])[];

export interface SeedGraduationEvidenceRef {
  memoryId: string;
  source: string;
}

export interface SeedGraduationEvaluation {
  decision: "promote" | "hold";
  corroborationCount: number;
  corroborating: SeedGraduationEvidenceRef[];
  /** Evidence that restated the seed but was excluded as echo/derivation. */
  echoSuppressedCount: number;
  reasons: string[];
}

export interface SeedGraduationGateOptions {
  config?: SeedGraduationConfig;
  recalledBySession?: SeedRecallEchoLookup;
}

export function evaluateSeedGraduation(
  seed: MemoryFile,
  evidence: readonly MemoryFile[],
  options: SeedGraduationGateOptions = {},
): SeedGraduationEvaluation {
  const config = options.config ?? SEED_GRADUATION_DEFAULTS;
  if (!config.enabled) {
    return {
      decision: "hold",
      corroborationCount: 0,
      corroborating: [],
      echoSuppressedCount: 0,
      reasons: ["seed-graduation-disabled"],
    };
  }
  const seedTokens = new Set(normalizeRecallTokens(stripAttributesSuffix(seed.content)));
  if (seedTokens.size < MIN_SEED_TOKENS) {
    return {
      decision: "hold",
      corroborationCount: 0,
      corroborating: [],
      echoSuppressedCount: 0,
      reasons: ["seed-too-short-for-deterministic-corroboration"],
    };
  }

  const seedCreated = createdMs(seed);
  const corroborating: SeedGraduationEvidenceRef[] = [];
  const reasons: string[] = [];
  let echoSuppressedCount = 0;

  for (const candidate of evidence) {
    if (candidate.frontmatter.id === seed.frontmatter.id) continue;
    // Only LATER evidence graduates a seed — anything written at or before
    // the seed's creation is contemporaneous, not corroborating.
    const candidateCreated = createdMs(candidate);
    if (!Number.isFinite(seedCreated) || !Number.isFinite(candidateCreated)) continue;
    if (candidateCreated <= seedCreated) continue;
    if (!isEvidenceStatus(candidate.frontmatter.status)) continue;
    if (coverageOf(seedTokens, candidate) < SEED_CORROBORATION_COVERAGE) continue;

    if (!isIndependentProvenance(seed, candidate)) {
      echoSuppressedCount += 1;
      continue;
    }
    const evidenceSession = sessionAnchor(candidate.frontmatter);
    if (
      options.recalledBySession !== undefined &&
      evidenceSession !== undefined &&
      options
        .recalledBySession(evidenceSession)
        .some((recalledIds) => recalledIds.includes(seed.frontmatter.id))
    ) {
      // The store's own recalled content quoted back never counts.
      echoSuppressedCount += 1;
      continue;
    }
    corroborating.push({ memoryId: candidate.frontmatter.id, source: candidate.frontmatter.source });
  }

  if (echoSuppressedCount > 0) reasons.push(`echo-suppressed:${echoSuppressedCount}`);
  if (corroborating.length >= config.minCorroborations) {
    return {
      decision: "promote",
      corroborationCount: corroborating.length,
      corroborating,
      echoSuppressedCount,
      reasons,
    };
  }
  reasons.push(`corroboration-below-min:${corroborating.length}/${config.minCorroborations}`);
  return {
    decision: "hold",
    corroborationCount: corroborating.length,
    corroborating,
    echoSuppressedCount,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Pass
// ---------------------------------------------------------------------------

/**
 * Narrow storage seam satisfied by `StorageManager`. Promotion reuses the
 * existing in-place `pending_review -> active` machinery rather than adding
 * a parallel write path.
 */
export interface SeedGraduationStorage {
  promoteWearableMemory(
    id: string,
    attributeUpdates: Record<string, string>,
    confidence?: number,
  ): Promise<boolean>;
}

export interface SeedGraduationPassInput {
  /** Full memory corpus for the namespace being swept (same input the lifecycle policy pass takes). */
  memories: readonly MemoryFile[];
  storage: SeedGraduationStorage;
  config?: SeedGraduationConfig;
  recalledBySession?: SeedRecallEchoLookup;
}

export interface SeedGraduationPassSummary {
  evaluated: number;
  promoted: number;
  held: number;
  echoSuppressed: number;
  disabled: boolean;
}

/** Audit attribute stamped on every graduated row, naming the evidence. */
function graduationAttributes(evaluation: SeedGraduationEvaluation): Record<string, string> {
  const ids = evaluation.corroborating
    .map((entry) => entry.memoryId)
    .join(",")
    .slice(0, STRUCTURED_ATTRIBUTE_LIMITS.maxValueLength);
  return {
    graduatedBy: "independent-corroboration",
    corroborationCount: String(evaluation.corroborationCount),
    corroboratingMemoryIds: ids,
  };
}

/**
 * Sweep every `pending_review` seed and graduate the corroborated ones.
 * Zero behavior while disabled (default) — review-mode promotion is
 * untouched until an operator opts in.
 */
export async function runSeedGraduationPass(
  input: SeedGraduationPassInput,
): Promise<SeedGraduationPassSummary> {
  const config = input.config ?? SEED_GRADUATION_DEFAULTS;
  if (!config.enabled) {
    return { evaluated: 0, promoted: 0, held: 0, echoSuppressed: 0, disabled: true };
  }
  const corpus = excludeSupportPassportPrivateMemories(input.memories);
  const evidencePool = corpus.filter((memory) => isEvidenceStatus(memory.frontmatter.status));

  let promoted = 0;
  let held = 0;
  let echoSuppressed = 0;
  let evaluated = 0;

  for (const seed of corpus) {
    if (seed.frontmatter.status !== "pending_review") continue;
    // Tombstone-blocked rows need revokeTombstone first; the promotion
    // method refuses them anyway, so skip before evaluating.
    if (seed.frontmatter.blockedBy !== undefined) continue;
    evaluated += 1;

    const evaluation = evaluateSeedGraduation(seed, evidencePool, {
      config,
      recalledBySession: input.recalledBySession,
    });
    echoSuppressed += evaluation.echoSuppressedCount;

    if (evaluation.decision === "hold") {
      held += 1;
      continue;
    }
    // A concurrent review resolution wins: promoteWearableMemory returns
    // false when the row is no longer pending_review.
    const wrote = await input.storage.promoteWearableMemory(
      seed.frontmatter.id,
      graduationAttributes(evaluation),
    );
    if (wrote) promoted += 1;
    else held += 1;
  }

  return { evaluated, promoted, held, echoSuppressed, disabled: false };
}
