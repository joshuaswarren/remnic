import type { MemoryFile } from "@remnic/core";

export type LedgerClaimKind = "claim" | "prediction" | "opinion";
export type LedgerStance = "for" | "against" | "uncertain" | "neutral";
export type LedgerClaimStatus =
  | "active"
  | "superseded"
  | "resolved"
  | "snoozed"
  | "ignored";
export type LedgerJudgeClassification =
  | "contradiction"
  | "evolution"
  | "refinement"
  | "unrelated";
export type LedgerPredictionVerdict = "true" | "false" | "mixed" | "unknown";

export interface LedgerTimeWindow {
  start?: string;
  end?: string;
}

export interface LedgerClaimScope {
  entities: string[];
  domain?: string;
  timeWindow?: LedgerTimeWindow;
}

export interface LedgerResolution {
  verdict: LedgerPredictionVerdict;
  actualConfidence: number;
  resolvedAt: string;
  source?: string;
  notes?: string;
  brierScore?: number;
}

export interface LedgerClaim {
  id: string;
  memoryId: string;
  statement: string;
  kind: LedgerClaimKind;
  stance: LedgerStance;
  confidence: number;
  scope: LedgerClaimScope;
  deadline?: string;
  evidenceLinks: string[];
  status: LedgerClaimStatus;
  createdAt: string;
  updatedAt: string;
  supersedes?: string;
  supersededBy?: string;
  parentIds: string[];
  snoozedUntil?: string;
  ignoredAt?: string;
  ignoredReason?: string;
  resolution?: LedgerResolution;
  sourceText?: string;
  sourceMemory?: MemoryFile;
}

export interface LedgerClaimDraft {
  statement: string;
  kind?: LedgerClaimKind;
  stance: LedgerStance;
  confidence: number;
  scope?: Partial<LedgerClaimScope>;
  deadline?: string;
  evidenceLinks?: string[];
}

export interface LedgerCaptureInput {
  text: string;
  now?: string;
  source?: string;
  sessionKey?: string;
}

export interface LedgerExtractionRequest extends LedgerCaptureInput {
  now: string;
}

export interface LedgerJudgeRequest {
  current: LedgerClaim;
  prior: LedgerClaim;
}

export interface LedgerJudgeResult {
  priorClaimId: string;
  classification: LedgerJudgeClassification;
  confidence: number;
  rationale: string;
}

export interface LedgerChallengeRequest {
  current: LedgerClaim;
  contradictions: Array<{
    claim: LedgerClaim;
    judgment: LedgerJudgeResult;
  }>;
}

export interface LedgerChallenge {
  question: string;
  priorClaimIds: string[];
  suggestedActions: Array<"supersede" | "split" | "resolve" | "ignore">;
}

export interface LedgerPredictionGradeRequest {
  claim: LedgerClaim;
  verdictSource?: string;
  now: string;
}

export interface LedgerPredictionGrade {
  verdict: LedgerPredictionVerdict;
  actualConfidence: number;
  rationale: string;
  source?: string;
}

export interface LedgerLlmAdapter {
  extractClaim(request: LedgerExtractionRequest): Promise<LedgerClaimDraft>;
  judgeClaimPair(request: LedgerJudgeRequest): Promise<LedgerJudgeResult>;
  draftSocraticChallenge(request: LedgerChallengeRequest): Promise<LedgerChallenge>;
  gradePrediction?(request: LedgerPredictionGradeRequest): Promise<LedgerPredictionGrade | null>;
}

export interface LedgerRetrievalCandidate {
  claim: LedgerClaim;
  score: number;
  reasons: string[];
}

export interface LedgerSemanticRetrievalAdapter {
  scoreClaims(request: {
    query: LedgerClaim;
    candidates: LedgerClaim[];
    limit: number;
  }): Promise<Array<{ claimId: string; score: number }>>;
}

export interface LedgerRerankerAdapter {
  rerank(request: {
    query: LedgerClaim;
    candidates: LedgerRetrievalCandidate[];
    limit: number;
  }): Promise<LedgerRetrievalCandidate[]>;
}

export interface LedgerRetrievalOptions {
  limit?: number;
  includeStatuses?: LedgerClaimStatus[];
  now?: string;
  semantic?: LedgerSemanticRetrievalAdapter;
  reranker?: LedgerRerankerAdapter;
}

export interface LedgerCrossExaminationStats {
  candidatesConsidered: number;
  judged: number;
  contradictions: number;
  unrelated: number;
  observableFalsePositiveRate: number;
}

export interface LedgerCrossExaminationResult {
  claim: LedgerClaim;
  candidates: LedgerRetrievalCandidate[];
  judgments: LedgerJudgeResult[];
  challenge?: LedgerChallenge;
  stats: LedgerCrossExaminationStats;
}

export interface LedgerCaptureResult extends LedgerCrossExaminationResult {
  claim: LedgerClaim;
}

export interface LedgerStore {
  createClaim(input: Omit<LedgerClaim, "id" | "memoryId" | "sourceMemory">): Promise<LedgerClaim>;
  getClaim(id: string): Promise<LedgerClaim | null>;
  listClaims(filter?: { statuses?: LedgerClaimStatus[]; kinds?: LedgerClaimKind[] }): Promise<LedgerClaim[]>;
  updateClaim(id: string, patch: Partial<LedgerClaim>): Promise<LedgerClaim>;
  supersedeClaim(priorId: string, newId: string, reason: string): Promise<boolean>;
}

export interface LedgerScoreDuePredictionsOptions {
  now?: string;
  verdictSources?: Record<string, string>;
  limit?: number;
}

export interface LedgerPredictionScoreResult {
  claim: LedgerClaim;
  status: "resolved" | "needs_user_verdict" | "skipped";
  resolution?: LedgerResolution;
  prompt?: string;
  reason?: string;
}

export interface LedgerReflectionOptions {
  now?: string;
  dormantAfterDays?: number;
}

export interface LedgerCalibrationBin {
  minConfidence: number;
  maxConfidence: number;
  count: number;
  meanPredictedConfidence: number;
  meanActualConfidence: number;
  calibrationError: number;
}

export interface LedgerDomainCalibration {
  domain: string;
  count: number;
  brierScore: number;
  meanPredictedConfidence: number;
  meanActualConfidence: number;
  tendency: "overconfident" | "underconfident" | "well_calibrated";
}

export interface LedgerFlippedClaim {
  rootClaimId: string;
  claimIds: string[];
  statements: string[];
  flipCount: number;
}

export interface LedgerDormantTopic {
  topic: string;
  lastClaimAt: string;
  daysSilent: number;
  claimCount: number;
}

export interface LedgerReflectionReport {
  generatedAt: string;
  totalClaims: number;
  activeClaims: number;
  resolvedPredictions: number;
  brierScore?: number;
  calibrationBins: LedgerCalibrationBin[];
  domains: LedgerDomainCalibration[];
  flippedClaims: LedgerFlippedClaim[];
  dormantTopics: LedgerDormantTopic[];
}
