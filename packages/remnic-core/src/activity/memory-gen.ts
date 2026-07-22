import { scoreImportance, isAboveImportanceThreshold } from "../importance.js";
import { getVerdictKind, type JudgeCandidate, type JudgeVerdict } from "../extraction-judge.js";
import type { ExtractionResult, MemoryStatus } from "../types.js";
import { composeMemoryEnvelope, type SealedMemoryEnvelope } from "../write-envelope.js";
import { computeTrustScore, decideSmart } from "../wearables/trust.js";
import type { ActivityConfig } from "./types.js";

const ACTIVITY_ALLOWED_CATEGORIES = new Set(["decision", "commitment", "preference", "moment"]);
const FIRST_PERSON = /\b(?:i|we|my|our|i['’]ve|we['’]ve)\b/i;

export interface ActivityMemoryWriter {
  hasFactContentHash(content: string): Promise<boolean>;
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
 * preference, or moment may enter the trust gate.
 */
export function isEligibleActivityFact(fact: ExtractionResult["facts"][number]): boolean {
  return ACTIVITY_ALLOWED_CATEGORIES.has(fact.category) && FIRST_PERSON.test(fact.content);
}

export async function generateActivityMemories(
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

  for (let index = 0; index < candidates.length; index += 1) {
    if (config.maxMemoriesPerDay > 0 && result.created + result.pendingReview >= config.maxMemoriesPerDay) {
      result.skipped += 1;
      continue;
    }
    const fact = candidates[index];
    if (await deps.writer.hasFactContentHash(fact.content)) {
      result.skipped += 1;
      continue;
    }
    const verdict = verdicts.get(index);
    const verdictKind = verdict === undefined ? undefined : getVerdictKind(verdict);
    const decision = decideSmart(
      computeTrustScore({
        extractionConfidence: fact.confidence,
        sourceTrust: config.sourceTrust,
        judgeVerdict: verdictKind,
        evidence: { corroboratedBySources: [] },
      }),
      verdictKind,
      { autoApproveTrust: config.autoApproveTrust, reviewTrust: config.reviewTrust },
    );
    if (decision.outcome === "drop") {
      if (decision.reason === "judge-rejected") result.rejectedByJudge += 1;
      else result.skipped += 1;
      continue;
    }
    const status: MemoryStatus = decision.outcome === "active" ? "active" : "pending_review";
    const envelope = composeMemoryEnvelope({
      content: fact.content,
      category: fact.category,
      tags: [...fact.tags, "activity"],
      entityRef: fact.entityRef,
      confidence: fact.confidence,
      sourceConnector: "activity",
      sourceReason: "screen activity digest",
    }, { source: "activity", now: deps.now });
    const write = await deps.writer.writeSealedMemory(envelope, { status, contentHashSource: fact.content });
    if (write.tombstoneBlocked) {
      result.skipped += 1;
    } else if (status === "active") {
      result.created += 1;
    } else {
      result.pendingReview += 1;
    }
  }
  return result;
}
