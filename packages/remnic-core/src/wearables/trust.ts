/**
 * Wearable memory trust scoring — the "smart" memoryMode engine.
 *
 * Grounded in how production memory systems handle noisy ingest:
 *
 *  - **LLM-as-judge gating** (Remnic's own extraction judge,
 *    `judgeFactDurability`): an LLM verdict on durability decides
 *    accept / defer / reject before anything persists.
 *  - **Provenance priors**: each source carries a configurable trust
 *    prior (`sourceTrust`) — a noisy ASR channel contributes less
 *    confidence than a clean one (provenance-weighted fusion).
 *  - **Corroboration**: independent agreement raises trust. A fact
 *    supported by a second wearable that recorded the same day, or by
 *    an existing active memory, is far less likely to be an ASR
 *    artifact (ensemble agreement / self-consistency).
 *
 * The combined score maps to a three-way decision:
 *
 *    trust >= autoApproveTrust  -> written ACTIVE
 *    trust >= reviewTrust       -> written pending_review
 *    below                      -> dropped
 *
 * with the judge able to short-circuit (reject -> drop,
 * defer -> pending_review regardless of score). The score, verdict,
 * and corroboration evidence persist on the memory (confidence +
 * structuredAttributes + verificationState), so Remnic's existing
 * trust machinery — memory-worth outcome counters, pattern
 * reinforcement, temporal supersession, contradiction scans — keeps
 * calibrating these memories after they land.
 */

import {
  countRecallTokenOverlap,
  normalizeRecallTokens,
} from "../recall-tokenization.js";

/** Judge adjustments and corroboration boosts (documented, fixed). */
export const TRUST_JUDGE_ACCEPT_BOOST = 0.15;
export const TRUST_CROSS_SOURCE_BOOST = 0.15;
export const TRUST_SUPPORTING_MEMORY_BOOST = 0.1;

/** Minimum distinct tokens before similarity is meaningful. */
const MIN_FACT_TOKENS = 4;
/** Fact-token coverage required to call a day-text corroborating. */
const CROSS_SOURCE_COVERAGE = 0.6;
/** Fact-token coverage required to call an existing memory supporting. */
const MEMORY_SUPPORT_COVERAGE = 0.7;
/** Bound on existing memories scanned per fact batch. */
const MAX_MEMORIES_SCANNED = 5_000;

export interface TrustEvidence {
  /** Other-source ids whose same-day content corroborates the fact. */
  corroboratedBySources: string[];
  /** Id of an existing active memory whose content supports the fact. */
  supportingMemoryId?: string;
}

export interface TrustScoreInput {
  /** Extraction confidence for the fact (defaults to 0.7 when absent). */
  extractionConfidence: number | undefined;
  /** Per-source trust prior from config (0..1). */
  sourceTrust: number;
  /** Judge verdict kind when a judge ran; undefined when unavailable. */
  judgeVerdict?: "accept" | "reject" | "defer";
  evidence: TrustEvidence;
}

export function computeTrustScore(input: TrustScoreInput): number {
  const confidence =
    typeof input.extractionConfidence === "number" &&
    Number.isFinite(input.extractionConfidence)
      ? Math.min(1, Math.max(0, input.extractionConfidence))
      : 0.7;
  let trust = confidence * Math.min(1, Math.max(0, input.sourceTrust));
  if (input.judgeVerdict === "accept") trust += TRUST_JUDGE_ACCEPT_BOOST;
  if (input.evidence.corroboratedBySources.length > 0) {
    trust += TRUST_CROSS_SOURCE_BOOST;
  }
  if (input.evidence.supportingMemoryId !== undefined) {
    trust += TRUST_SUPPORTING_MEMORY_BOOST;
  }
  return Math.min(1, Math.max(0, trust));
}

export interface CorroborationContext {
  /**
   * Same-day transcript bodies from OTHER sources, keyed by source id.
   * Pre-tokenized once per sync (day bodies are large).
   */
  otherSourceDayTokens: Map<string, Set<string>>;
  /** Existing active memories: id + content. */
  existingMemories: Array<{ id: string; content: string }>;
}

/** Tokenize a day body once for repeated per-fact coverage checks. */
export function tokenizeDayBody(body: string): Set<string> {
  return new Set(normalizeRecallTokens(body));
}

/**
 * Find corroborating evidence for one fact. Deterministic and local:
 * token-coverage similarity via the shared recall tokenizer — no LLM
 * cost on the corroboration path.
 */
export function findCorroboration(
  factText: string,
  context: CorroborationContext,
): TrustEvidence {
  const factTokens = normalizeRecallTokens(factText);
  const evidence: TrustEvidence = { corroboratedBySources: [] };
  if (factTokens.length < MIN_FACT_TOKENS) return evidence;
  const factTokenSet = new Set(factTokens);

  for (const [sourceId, dayTokens] of context.otherSourceDayTokens) {
    let matches = 0;
    for (const token of factTokenSet) {
      if (dayTokens.has(token)) matches += 1;
    }
    if (matches / factTokenSet.size >= CROSS_SOURCE_COVERAGE) {
      evidence.corroboratedBySources.push(sourceId);
    }
  }
  evidence.corroboratedBySources.sort();

  let scanned = 0;
  for (const memory of context.existingMemories) {
    if (scanned >= MAX_MEMORIES_SCANNED) break;
    scanned += 1;
    const matches = countRecallTokenOverlap(factTokenSet, memory.content);
    if (matches / factTokenSet.size >= MEMORY_SUPPORT_COVERAGE) {
      evidence.supportingMemoryId = memory.id;
      break;
    }
  }
  return evidence;
}

export interface SmartDecision {
  outcome: "active" | "review" | "drop";
  reason:
    | "judge-rejected"
    | "judge-deferred"
    | "auto-approved"
    | "queued-for-review"
    | "below-trust";
  trust: number;
}

/** Map judge verdict + trust score to the smart-mode decision. */
export function decideSmart(
  trust: number,
  judgeVerdict: "accept" | "reject" | "defer" | undefined,
  thresholds: { autoApproveTrust: number; reviewTrust: number },
): SmartDecision {
  if (judgeVerdict === "reject") {
    return { outcome: "drop", reason: "judge-rejected", trust };
  }
  if (judgeVerdict === "defer") {
    return { outcome: "review", reason: "judge-deferred", trust };
  }
  if (trust >= thresholds.autoApproveTrust) {
    return { outcome: "active", reason: "auto-approved", trust };
  }
  if (trust >= thresholds.reviewTrust) {
    return { outcome: "review", reason: "queued-for-review", trust };
  }
  return { outcome: "drop", reason: "below-trust", trust };
}
