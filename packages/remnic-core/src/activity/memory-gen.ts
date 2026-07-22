import { scoreImportance, isAboveImportanceThreshold } from "../importance.js";
import { getVerdictKind, type JudgeCandidate, type JudgeVerdict } from "../extraction-judge.js";
import { log } from "../logger.js";
import type { ExtractedFact, ExtractionResult, MemoryStatus } from "../types.js";
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
 * A named third party reporting speech or action (`Alice wrote:`, `Bob said`).
 * A first-person pronoun inside such content describes the quoted person, not
 * the user — the speaker slot is a proper name, never a first-person pronoun.
 */
const THIRD_PARTY_ATTRIBUTION =
  /\b(?!I|We|You|They|He|She|It|My|Our)[A-Z][a-z]+\b\s+(?:said|says|wrote|writes|posted|typed|asked|replied|messaged|commented|noted|announced|added|responded|mentioned|told)\b/;

export interface ActivityMemoryWriter {
  /**
   * True when an activity memory with this content already exists (any status).
   * Activity writes are decision/commitment/preference/moment memories, none of
   * which the fact-only content-hash index covers, so this lookup MUST match
   * across the activity source — letting a reprocessed day dedup rather than
   * writing duplicates.
   */
  hasActivityMemoryForContent(content: string): Promise<boolean>;
  /**
   * Count active + pending_review activity memories whose event time falls in
   * the half-open [startUtc, endUtc) day window. Seeds `maxMemoriesPerDay` so
   * the cap holds across repeated digest runs on the same day rather than
   * resetting on every call.
   */
  countActivityMemoriesForDay(startUtc: string, endUtc: string): Promise<number>;
  writeSealedMemory(
    envelope: SealedMemoryEnvelope,
    extras: { status: MemoryStatus; contentHashSource: string },
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
  if (THIRD_PARTY_ATTRIBUTION.test(fact.content)) return false;
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
}

export async function generateActivityMemories(
  date: string,
  digestBody: string,
  config: ActivityConfig,
  deps: ActivityMemoryGenerationDeps,
): Promise<ActivityMemoryGenerationResult> {
  const result: ActivityMemoryGenerationResult = {
    created: 0,
    pendingReview: 0,
    rejectedDisplayedContent: 0,
    rejectedByJudge: 0,
    skipped: 0,
  };
  if (!config.enabled || config.extractionMode !== "smart" || digestBody.trim().length === 0) return result;

  // Event-time bound: the digest's local day. Backfilled or delayed digests
  // then land on the day they describe rather than at write time.
  const { startUtc, endUtc } = activityDayWindow(date, config.timezone);

  const extracted = await deps.extract(digestBody);
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
  const verdicts = await deps.judge(candidates.map((fact) => ({
    text: fact.content,
    category: fact.category,
    confidence: fact.confidence,
    tags: fact.tags,
    importanceLevel: scoreImportance(fact.content, fact.category, fact.tags).level,
  })));

  // Score every survivor first, then apply the day cap to the strongest by
  // trust — a lower-trust review write must never crowd out a higher-trust fact
  // that appears later in the batch.
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
    if (decision.outcome === "drop") {
      if (decision.reason === "judge-rejected") result.rejectedByJudge += 1;
      else result.skipped += 1;
      continue;
    }
    writable.push({ fact, status: decision.outcome === "active" ? "active" : "pending_review", trust });
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
    if (await deps.writer.hasActivityMemoryForContent(entry.fact.content)) {
      result.skipped += 1;
      continue;
    }
    const envelope = composeSalvagedActivityEnvelope(
      {
        content: entry.fact.content,
        category: entry.fact.category,
        tags: [...entry.fact.tags, "activity"],
        entityRef: entry.fact.entityRef,
        confidence: entry.fact.confidence,
        validAt: startUtc,
        sourceConnector: "activity",
        sourceReason: "screen activity digest",
      },
      { source: "activity", now: deps.now },
    );
    const write = await deps.writer.writeSealedMemory(envelope, {
      status: entry.status,
      contentHashSource: entry.fact.content,
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
