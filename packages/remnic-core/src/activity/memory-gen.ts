import { scoreImportance, isAboveImportanceThreshold } from "../importance.js";
import { getVerdictKind, type JudgeCandidate, type JudgeVerdict, type JudgeVerdictKind } from "../extraction-judge.js";
import { log } from "../logger.js";
import type { ExtractedFact, ExtractionResult, ImportanceScore, MemoryStatus } from "../types.js";
import {
  composeMemoryEnvelope,
  type MemoryWriteInput,
  type SealedMemoryEnvelope,
  type WriteContext,
} from "../write-envelope.js";
import { computeTrustScore, decideSmart } from "../wearables/trust.js";
import { activityDayWindow } from "./digest.js";
import type { ActivityConfig } from "./types.js";

const ACTIVITY_ALLOWED_CATEGORIES: Record<string, true> = {
  decision: true,
  commitment: true,
  preference: true,
  moment: true,
};
const FIRST_PERSON = /\b(?:i|we|my|our|i['’]ve|we['’]ve)\b/i;
/**
 * Attribution detection. On-screen text routinely quotes other people, so a
 * first-person pronoun is not ownership evidence. Two shapes are rejected,
 * case-insensitively, with the speaker slot excluding bare first-person
 * pronouns (word-anchored) so "We decided" stays eligible while names that
 * merely begin with a pronoun ("Wendy", "Ian") do not:
 *   - verb attribution:  "Alice wrote: I decided ..." (leading speaker + verb)
 *   - leading label:     "Alice: I decided ..." (chat/comment sender headers)
 * Common document labels ("Note:", "TODO:") are not senders and stay eligible.
 */
const ATTRIBUTION_SPEAKER = String.raw`(?!(?:i|we|me|my|our)\b)[A-Za-z][\w.'’-]*`;
const SPEECH_VERB =
  String.raw`(?:said|says|wrote|writes|posted|typed|asked|replied|messaged|commented|noted|announced|added|responded|mentioned|told)`;
const VERB_ATTRIBUTION = new RegExp(String.raw`^\s*${ATTRIBUTION_SPEAKER}\s+${SPEECH_VERB}\b`, "i");
const LABEL_ATTRIBUTION = new RegExp(
  String.raw`^\s*(${ATTRIBUTION_SPEAKER}(?:\s+[A-Za-z][\w.'’-]*){0,3})\s*:\s*`,
  "i",
);
// A sender named inside an otherwise-allowlisted label ("Update from Alice:",
// "Note by Bob:") is still attribution. Case-sensitive on the capitalized name
// so generic labels ("Summary by section:") stay eligible.
const LABEL_NAMES_SENDER = /\b(?:from|by)\s+[A-Z][a-z]/;
const NON_SENDER_LABELS: Record<string, true> = {
  note: true, notes: true, todo: true, fixme: true, reminder: true, update: true,
  updates: true, warning: true, info: true, tip: true, tips: true, summary: true,
  status: true, tldr: true, fyi: true, idea: true, goal: true, goals: true,
  plan: true, plans: true, action: true, actions: true, context: true, question: true,
};
const TRUST_ATTRIBUTE_KEYS: Record<string, true> = {
  trustscore: true,
  trustdecision: true,
  judgeverdict: true,
};

export interface ActivityMemoryWriter {
  /**
   * Locate an existing activity memory with this content (any status), or null.
   * Activity writes are decision/commitment/preference/moment memories, none of
   * which the fact-only content-hash index covers, so this lookup MUST match
   * across the activity source — enabling dedup and in-place promotion rather
   * than duplicate or frozen-pending records.
   */
  findActivityMemoryByContent(content: string): Promise<{ id: string; status: MemoryStatus | undefined } | null>;
  /**
   * Count active + pending_review activity memories whose event time falls in
   * the half-open [startUtc, endUtc) day window. Seeds `maxMemoriesPerDay` so
   * the cap holds across repeated digest runs on the same day rather than
   * resetting on every call.
   */
  countActivityMemoriesForDay(startUtc: string, endUtc: string): Promise<number>;
  /**
   * Promote a pending_review activity memory to active, merging trust evidence.
   * Returns false when the row is missing or no longer pending.
   */
  promoteActivityMemory(
    id: string,
    attributeUpdates: Record<string, string>,
    confidence?: number,
  ): Promise<boolean>;
  /**
   * Demote a pending_review activity memory to rejected on a fresh judge-reject
   * re-verdict. Active rows are never auto-demoted. Returns false when missing
   * or no longer pending.
   */
  demoteActivityMemory(id: string, attributeUpdates: Record<string, string>): Promise<boolean>;
  writeSealedMemory(
    envelope: SealedMemoryEnvelope,
    extras: { status: MemoryStatus; contentHashSource: string; importance?: ImportanceScore },
  ): Promise<{ tombstoneBlocked?: boolean }>;
}

export interface ActivityMemoryGenerationDeps {
  extract(digestBody: string): Promise<ExtractionResult>;
  judge(candidates: JudgeCandidate[]): Promise<Map<number, JudgeVerdict>>;
  writer: ActivityMemoryWriter;
  now?: () => Date;
}

export interface ActivityMemoryGenerationResult {
  created: number;
  /** Earlier pending_review writes promoted to active by a stronger reassessment. */
  promoted: number;
  /** Earlier pending_review writes retired by a fresh judge-reject verdict. */
  demoted: number;
  pendingReview: number;
  rejectedDisplayedContent: number;
  rejectedByJudge: number;
  skipped: number;
}

/**
 * Activity snapshots contain arbitrary third-party text. Only durable claims
 * explicitly framed as the user's or team's own action, decision, commitment,
 * preference, or moment may enter the trust gate. A first-person pronoun alone
 * is not ownership evidence: quoted or attributed third-party speech (e.g.
 * "Alice wrote: I decided to leave") is rejected.
 */
export function isEligibleActivityFact(fact: ExtractionResult["facts"][number]): boolean {
  if (ACTIVITY_ALLOWED_CATEGORIES[fact.category] !== true) return false;
  if (!FIRST_PERSON.test(fact.content)) return false;
  if (VERB_ATTRIBUTION.test(fact.content)) return false;
  const label = LABEL_ATTRIBUTION.exec(fact.content);
  if (label !== null) {
    const labelText = label[1].trim();
    const firstToken = labelText.split(/\s+/)[0].toLowerCase();
    if (NON_SENDER_LABELS[firstToken] !== true || LABEL_NAMES_SENDER.test(labelText)) return false;
  }
  return true;
}

/**
 * Compose an activity envelope in salvage mode (issue #1989 pattern): digest
 * facts are MACHINE-generated, so one malformed optional field must not abort a
 * whole day's writes. Dropped fields are warn-logged, never silent.
 */
function composeSalvagedActivityEnvelope(
  input: MemoryWriteInput,
  ctx: WriteContext,
): SealedMemoryEnvelope {
  const envelope = composeMemoryEnvelope(input, ctx, { salvage: true });
  if (envelope.salvageNotes.length > 0) {
    log.warn(`activity write salvaged invalid fields: ${envelope.salvageNotes.join("; ")}`);
  }
  return envelope;
}

interface WritableCandidate {
  fact: ExtractedFact;
  status: Extract<MemoryStatus, "active" | "pending_review">;
  trust: number;
  trustDecision: string;
  judgeVerdict?: JudgeVerdictKind;
  importance: ImportanceScore;
}

export async function generateActivityMemories(
  date: string,
  digestBody: string,
  config: ActivityConfig,
  deps: ActivityMemoryGenerationDeps,
): Promise<ActivityMemoryGenerationResult> {
  const result: ActivityMemoryGenerationResult = {
    created: 0,
    promoted: 0,
    demoted: 0,
    pendingReview: 0,
    rejectedDisplayedContent: 0,
    rejectedByJudge: 0,
    skipped: 0,
  };
  if (!config.enabled || config.extractionMode !== "smart" || digestBody.trim().length === 0) return result;

  // Event-time bound: the digest's local day. Backfilled or delayed digests
  // then land on the day they describe rather than at write time.
  const { startUtc, endUtc } = activityDayWindow(date, config.timezone);

  let extracted: ExtractionResult;
  try {
    extracted = await deps.extract(digestBody);
  } catch (err) {
    // A provider/parse failure must not throw out of the pass; return the
    // structured zero-result so the caller can retry on the next digest run.
    log.warn(
      `activity extraction failed; skipping the day's memory pass: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }
  if (extracted.extractionFailure !== undefined) {
    // In-band failure marker (partial/failed provider result): treat like a
    // thrown extraction — warn and return the structured zero-result.
    log.warn(
      `activity extraction reported a failure; skipping the day's memory pass: ${extracted.extractionFailure}`,
    );
    return result;
  }
  const candidates = extracted.facts.filter((fact) => {
    if (!isEligibleActivityFact(fact)) {
      result.rejectedDisplayedContent += 1;
      return false;
    }
    const importance = scoreImportance(fact.content, fact.category, fact.tags);
    if (fact.confidence < config.minConfidence || !isAboveImportanceThreshold(importance.level, config.minImportance)) {
      result.skipped += 1;
      return false;
    }
    return true;
  });
  let verdicts: Map<number, JudgeVerdict>;
  try {
    verdicts = await deps.judge(candidates.map((fact) => ({
      text: fact.content,
      category: fact.category,
      confidence: fact.confidence,
      tags: fact.tags,
      importanceLevel: scoreImportance(fact.content, fact.category, fact.tags).level,
    })));
  } catch (err) {
    // Degraded smart mode (wearables parity): a judge failure must not abort the
    // day's writes. Fall back to trust scoring alone (no judge accept boost).
    log.warn(
      `activity extraction judge unavailable; using trust scoring only: ${err instanceof Error ? err.message : String(err)}`,
    );
    verdicts = new Map();
  }

  // Score every eligible candidate once. A duplicate of an existing pending_review
  // row can promote (or demote on a fresh judge-reject) in place instead of being
  // frozen by all-status dedup; novel survivors queue for the day-capped write.
  const writable: WritableCandidate[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const fact = candidates[index];
    const verdict = verdicts.get(index);
    const verdictKind = verdict === undefined ? undefined : getVerdictKind(verdict);
    const trust = computeTrustScore({
      extractionConfidence: fact.confidence,
      sourceTrust: config.sourceTrust,
      judgeVerdict: verdictKind,
      evidence: { corroboratedBySources: [] },
    });
    const decision = decideSmart(trust, verdictKind, {
      autoApproveTrust: config.autoApproveTrust,
      reviewTrust: config.reviewTrust,
    });
    const existing = await deps.writer.findActivityMemoryByContent(fact.content);
    if (existing !== null) {
      // Duplicate: reassess a pending row in place; never write new or use a cap slot.
      if (existing.status === "pending_review") {
        if (decision.outcome === "drop" && decision.reason === "judge-rejected") {
          if (
            await deps.writer.demoteActivityMemory(existing.id, {
              trustScore: trust.toFixed(3),
              trustDecision: "demoted-by-rejection",
              judgeVerdict: "reject",
            })
          ) {
            result.demoted += 1;
            continue;
          }
        } else if (decision.outcome === "active") {
          if (
            await deps.writer.promoteActivityMemory(
              existing.id,
              {
                trustScore: trust.toFixed(3),
                trustDecision: "promoted-by-reassessment",
                ...(verdictKind !== undefined ? { judgeVerdict: verdictKind } : {}),
              },
              trust,
            )
          ) {
            result.promoted += 1;
            continue;
          }
        }
      }
      result.skipped += 1;
      continue;
    }
    if (decision.outcome === "drop") {
      if (decision.reason === "judge-rejected") result.rejectedByJudge += 1;
      else result.skipped += 1;
      continue;
    }
    writable.push({
      fact,
      status: decision.outcome === "active" ? "active" : "pending_review",
      trust,
      trustDecision: decision.reason,
      ...(verdictKind !== undefined ? { judgeVerdict: verdictKind } : {}),
      importance: scoreImportance(fact.content, fact.category, fact.tags),
    });
  }
  writable.sort((a, b) => {
    if (a.trust !== b.trust) return b.trust - a.trust;
    return a.fact.content < b.fact.content ? -1 : a.fact.content > b.fact.content ? 1 : 0;
  });

  // Seed the cap from memories already persisted for this day so repeated digest
  // runs cannot each write up to the limit. `0` stays uncapped.
  const alreadyWritten =
    config.maxMemoriesPerDay > 0 ? await deps.writer.countActivityMemoriesForDay(startUtc, endUtc) : 0;
  let remaining =
    config.maxMemoriesPerDay > 0
      ? Math.max(0, config.maxMemoriesPerDay - alreadyWritten)
      : Number.POSITIVE_INFINITY;

  for (const entry of writable) {
    if (remaining <= 0) {
      result.skipped += 1;
      continue;
    }
    const structuredAttributes: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry.fact.structuredAttributes ?? {})) {
      // Extractor-provided attributes are preserved but never override the trust
      // keys this path owns (compared against the canonical lowercase form).
      if (TRUST_ATTRIBUTE_KEYS[key.trim().toLowerCase()] !== true) structuredAttributes[key] = value;
    }
    structuredAttributes.trustScore = entry.trust.toFixed(3);
    structuredAttributes.trustDecision = entry.trustDecision;
    if (entry.judgeVerdict !== undefined) structuredAttributes.judgeVerdict = entry.judgeVerdict;
    const envelope = composeSalvagedActivityEnvelope(
      {
        content: entry.fact.content,
        category: entry.fact.category,
        tags: [...entry.fact.tags, "activity"],
        entityRef: entry.fact.entityRef,
        // Persist the decision-derived trust as confidence; extractor attributes
        // ride along, with trust score/decision + judge verdict added last so
        // downstream sees the active/pending rationale (wearable-path parity).
        confidence: entry.trust,
        validAt: startUtc,
        structuredAttributes,
        sourceConnector: "activity",
        sourceReason: "screen activity digest",
      },
      { source: "activity", now: deps.now },
    );
    const write = await deps.writer.writeSealedMemory(envelope, {
      status: entry.status,
      contentHashSource: entry.fact.content,
      importance: entry.importance,
    });
    if (write.tombstoneBlocked) {
      result.skipped += 1;
      continue;
    }
    if (entry.status === "active") result.created += 1;
    else result.pendingReview += 1;
    remaining -= 1;
  }
  return result;
}
