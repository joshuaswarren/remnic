import type { StorageManager } from "@remnic/core";
import { buildReflectionReport } from "./reflection.js";
import { RemnicLedgerStore, type RemnicLedgerStoreOptions } from "./remnic-store.js";
import { retrievePriorClaims } from "./retrieval.js";
import { createResolution, normalizeClaimDraft, normalizeIsoTimestamp } from "./schema.js";
import type {
  LedgerCaptureInput,
  LedgerCaptureResult,
  LedgerChallenge,
  LedgerClaim,
  LedgerClaimDraft,
  LedgerCrossExaminationResult,
  LedgerCrossExaminationStats,
  LedgerJudgeResult,
  LedgerLlmAdapter,
  LedgerPredictionScoreResult,
  LedgerReflectionOptions,
  LedgerReflectionReport,
  LedgerRetrievalOptions,
  LedgerScoreDuePredictionsOptions,
  LedgerStore,
} from "./types.js";

export interface BeliefLedgerOptions {
  store: LedgerStore;
  llm: LedgerLlmAdapter;
  retrieval?: LedgerRetrievalOptions;
  now?: () => Date;
}

export interface BeliefLedgerFromStorageOptions extends RemnicLedgerStoreOptions {
  llm: LedgerLlmAdapter;
  retrieval?: LedgerRetrievalOptions;
}

export interface ResolveClaimInput {
  verdict: "true" | "false" | "mixed" | "unknown";
  actualConfidence: number;
  source?: string;
  notes?: string;
  resolvedAt?: string;
}

export class BeliefLedger {
  private readonly store: LedgerStore;
  private readonly llm: LedgerLlmAdapter;
  private readonly retrieval: LedgerRetrievalOptions;
  private readonly now: () => Date;

  constructor(options: BeliefLedgerOptions) {
    this.store = options.store;
    this.llm = options.llm;
    this.retrieval = options.retrieval ?? {};
    this.now = options.now ?? (() => new Date());
  }

  static fromStorage(storage: StorageManager, options: BeliefLedgerFromStorageOptions): BeliefLedger {
    return new BeliefLedger({
      store: new RemnicLedgerStore(storage, options),
      llm: options.llm,
      retrieval: options.retrieval,
      now: options.now,
    });
  }

  async capture(input: LedgerCaptureInput): Promise<LedgerCaptureResult> {
    const now = normalizeIsoTimestamp("now", input.now ?? this.now().toISOString());
    const draft = await this.llm.extractClaim({ ...input, now });
    const normalized = normalizeClaimDraft(draft, { now, sourceText: input.text });
    const claim = await this.store.createClaim(normalized);
    const examination = await this.crossExamine(claim, { now });
    return { ...examination, claim };
  }

  async crossExamine(
    claimOrId: LedgerClaim | string,
    options: LedgerRetrievalOptions = {}
  ): Promise<LedgerCrossExaminationResult> {
    const claim = typeof claimOrId === "string" ? await this.requireClaim(claimOrId) : claimOrId;
    const retrievalOptions: LedgerRetrievalOptions = {
      ...this.retrieval,
      ...options,
      now: options.now ?? this.retrieval.now ?? this.now().toISOString(),
    };
    const candidates = await retrievePriorClaims(claim, this.store, retrievalOptions);
    const judgments: LedgerJudgeResult[] = [];
    for (const candidate of candidates) {
      const judgment = await this.llm.judgeClaimPair({
        current: claim,
        prior: candidate.claim,
      });
      judgments.push({
        ...judgment,
        priorClaimId: candidate.claim.id,
      });
    }

    const contradictions = judgments
      .map((judgment) => ({
        judgment,
        claim: candidates.find((candidate) => candidate.claim.id === judgment.priorClaimId)?.claim,
      }))
      .filter(
        (item): item is { judgment: LedgerJudgeResult; claim: LedgerClaim } =>
          item.claim !== undefined && item.judgment.classification === "contradiction"
      );

    const challenge: LedgerChallenge | undefined =
      contradictions.length > 0
        ? await this.llm.draftSocraticChallenge({
            current: claim,
            contradictions,
          })
        : undefined;

    return {
      claim,
      candidates,
      judgments,
      ...(challenge ? { challenge } : {}),
      stats: buildCrossExaminationStats(judgments),
    };
  }

  async supersede(priorId: string, newId: string, reason: string): Promise<boolean> {
    return this.store.supersedeClaim(priorId, newId, reason);
  }

  async split(
    priorId: string,
    parts: LedgerClaimDraft[],
    reason: string = "split into narrower claims"
  ): Promise<LedgerClaim[]> {
    if (parts.length === 0) {
      throw new Error("split requires at least one part");
    }
    const prior = await this.requireClaim(priorId);
    const now = this.now().toISOString();
    const normalizedParts = parts.map((part) => ({
      ...normalizeClaimDraft(part, {
        now,
        sourceText: prior.sourceText ?? prior.statement,
      }),
      parentIds: [priorId],
    }));
    const created: LedgerClaim[] = [];
    try {
      for (const part of normalizedParts) {
        created.push(await this.store.createClaim(part));
      }
    } catch (error) {
      await rollbackCreatedSplitClaims(this.store, created, now, `split creation failed for ${priorId}`);
      throw error;
    }

    const firstReplacement = created[0]!;
    let didSupersede = false;
    try {
      didSupersede = await this.store.supersedeClaim(priorId, firstReplacement.id, reason);
    } catch (error) {
      await rollbackCreatedSplitClaims(this.store, created, now, `split supersession failed for ${priorId}`);
      throw error;
    }
    if (!didSupersede) {
      await rollbackCreatedSplitClaims(this.store, created, now, `split supersession failed for ${priorId}`);
      throw new Error(`split could not supersede prior claim ${priorId} with ${firstReplacement.id}`);
    }
    const linkedFirst = await this.store.getClaim(firstReplacement.id);
    if (!linkedFirst) {
      throw new Error(`split replacement claim ${firstReplacement.id} disappeared after supersession`);
    }
    created[0] = linkedFirst;
    return created;
  }

  async resolve(claimId: string, input: ResolveClaimInput): Promise<LedgerClaim> {
    const claim = await this.requireClaim(claimId);
    const resolvedAt = normalizeIsoTimestamp("resolvedAt", input.resolvedAt ?? this.now().toISOString());
    const resolution = createResolution({
      verdict: input.verdict,
      actualConfidence: input.actualConfidence,
      resolvedAt,
      source: input.source,
      notes: input.notes,
      predictedConfidence: claim.confidence,
    });
    return this.store.updateClaim(claimId, {
      status: "resolved",
      resolution,
      updatedAt: resolvedAt,
    });
  }

  async snooze(claimId: string, until: string): Promise<LedgerClaim> {
    const snoozedUntil = normalizeIsoTimestamp("snoozedUntil", until);
    return this.store.updateClaim(claimId, {
      status: "snoozed",
      snoozedUntil,
      updatedAt: this.now().toISOString(),
    });
  }

  async ignore(claimId: string, reason?: string): Promise<LedgerClaim> {
    const ignoredAt = this.now().toISOString();
    return this.store.updateClaim(claimId, {
      status: "ignored",
      ignoredAt,
      ...(reason?.trim() ? { ignoredReason: reason.trim() } : {}),
      updatedAt: ignoredAt,
    });
  }

  async scoreDuePredictions(options: LedgerScoreDuePredictionsOptions = {}): Promise<LedgerPredictionScoreResult[]> {
    const now = normalizeIsoTimestamp("now", options.now ?? this.now().toISOString());
    const limit = normalizeLimit(options.limit);
    const verdictSources = options.verdictSources ?? {};
    const due = (await this.store.listClaims({ kinds: ["prediction"], statuses: ["active", "snoozed"] }))
      .filter((claim) => isDueForScoring(claim, now))
      .sort(compareDuePredictions)
      .slice(0, limit);

    const results: LedgerPredictionScoreResult[] = [];
    for (const claim of due) {
      const verdictSource = verdictSources[claim.id];
      if (!verdictSource?.trim()) {
        results.push({
          claim,
          status: "needs_user_verdict",
          prompt: `Prediction deadline passed: "${claim.statement}". What actually happened?`,
        });
        continue;
      }
      if (!this.llm.gradePrediction) {
        results.push({
          claim,
          status: "needs_user_verdict",
          prompt: `Prediction deadline passed: "${claim.statement}". Provide a verdict because no grader is configured.`,
        });
        continue;
      }
      try {
        const grade = await this.llm.gradePrediction({ claim, verdictSource, now });
        if (!grade) {
          results.push({
            claim,
            status: "needs_user_verdict",
            prompt: `Prediction deadline passed: "${claim.statement}". The verdict source was not enough to grade it.`,
          });
          continue;
        }
        const resolution = createResolution({
          verdict: grade.verdict,
          actualConfidence: grade.actualConfidence,
          resolvedAt: now,
          source: grade.source ?? verdictSource,
          notes: grade.rationale,
          predictedConfidence: claim.confidence,
        });
        const updated = await this.store.updateClaim(claim.id, {
          status: "resolved",
          resolution,
          updatedAt: now,
        });
        results.push({
          claim: updated,
          status: "resolved",
          resolution,
        });
      } catch (error) {
        results.push({
          claim,
          status: "skipped",
          reason: `prediction scoring failed: ${errorMessage(error)}`,
        });
      }
    }
    return results;
  }

  async reflect(options: LedgerReflectionOptions = {}): Promise<LedgerReflectionReport> {
    const claims = await this.store.listClaims();
    return buildReflectionReport(claims, {
      ...options,
      now: options.now ?? this.now().toISOString(),
    });
  }

  private async requireClaim(id: string): Promise<LedgerClaim> {
    const claim = await this.store.getClaim(id);
    if (!claim) {
      throw new Error(`claim ${id} not found`);
    }
    return claim;
  }
}

function buildCrossExaminationStats(judgments: Array<{ classification: string }>): LedgerCrossExaminationStats {
  const judged = judgments.length;
  const contradictions = judgments.filter((judgment) => judgment.classification === "contradiction").length;
  const unrelated = judgments.filter((judgment) => judgment.classification === "unrelated").length;
  return {
    candidatesConsidered: judged,
    judged,
    contradictions,
    unrelated,
    observableFalsePositiveRate: judged === 0 ? 0 : unrelated / judged,
  };
}

async function rollbackCreatedSplitClaims(
  store: LedgerStore,
  claims: LedgerClaim[],
  now: string,
  ignoredReason: string
): Promise<void> {
  for (const claim of claims) {
    try {
      await store.updateClaim(claim.id, {
        status: "ignored",
        ignoredAt: now,
        ignoredReason,
        updatedAt: now,
      });
    } catch {
      // Rollback is best-effort; preserve the original split failure.
    }
  }
}

function isDueForScoring(claim: LedgerClaim, nowIso: string): boolean {
  if (!claim.deadline) return false;
  if (claim.resolution) return false;
  if (claim.status === "snoozed" && claim.snoozedUntil && Date.parse(claim.snoozedUntil) > Date.parse(nowIso)) {
    return false;
  }
  return Date.parse(claim.deadline) <= Date.parse(nowIso);
}

function compareDuePredictions(a: LedgerClaim, b: LedgerClaim): number {
  const aDeadline = a.deadline ? Date.parse(a.deadline) : Number.POSITIVE_INFINITY;
  const bDeadline = b.deadline ? Date.parse(b.deadline) : Number.POSITIVE_INFINITY;
  const deadlineOrder = aDeadline - bDeadline;
  if (deadlineOrder !== 0) return deadlineOrder;
  const updatedOrder = Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
  if (updatedOrder !== 0) return updatedOrder;
  return a.id.localeCompare(b.id);
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new Error(`limit must be an integer in [1, 1000], got ${String(value)}`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
