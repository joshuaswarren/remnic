export type ContinuityIncidentState = "open" | "closed";

export interface ContinuityIncidentRecord {
  id: string;
  state: ContinuityIncidentState;
  openedAt: string;
  updatedAt: string;
  triggerWindow?: string;
  symptom: string;
  suspectedCause?: string;
  fixApplied?: string;
  verificationResult?: string;
  preventiveRule?: string;
  closedAt?: string;
  filePath?: string;
}

export interface ContinuityIncidentOpenInput {
  triggerWindow?: string;
  symptom: string;
  suspectedCause?: string;
}

export interface ContinuityIncidentCloseInput {
  fixApplied: string;
  verificationResult: string;
  preventiveRule?: string;
}

export type ContinuityLoopCadence = "daily" | "weekly" | "monthly" | "quarterly";
export type ContinuityLoopStatus = "active" | "paused" | "retired";

export interface ContinuityImprovementLoop {
  id: string;
  cadence: ContinuityLoopCadence;
  purpose: string;
  status: ContinuityLoopStatus;
  killCondition: string;
  lastReviewed: string;
  notes?: string;
}

export interface ContinuityLoopUpsertInput {
  id: string;
  cadence: ContinuityLoopCadence;
  purpose: string;
  status: ContinuityLoopStatus;
  killCondition: string;
  lastReviewed?: string;
  notes?: string;
}

export interface ContinuityLoopReviewInput {
  status?: ContinuityLoopStatus;
  notes?: string;
  reviewedAt?: string;
}
