import type {
  LifecycleState,
  MemoryCategory,
  MemoryFile,
  MemoryFrontmatter,
  VerificationState,
} from "./types.js";

export interface LifecyclePolicy {
  promoteHeatThreshold: number;
  staleDecayThreshold: number;
  archiveDecayThreshold: number;
  protectedCategories: MemoryCategory[];
}

export interface LifecycleSignals {
  /**
   * Optional relevance feedback in [-1, 1]. Negative values increase decay.
   * Positive values raise heat.
   */
  feedbackScore?: number;
  /**
   * Optional bounded prior derived from memory-action outcomes in [-1, 1].
   * This is intentionally low-impact to avoid circular amplification.
   */
  actionPriorScore?: number;
  /**
   * Optional causal impact score from CMC chain analysis in [0, 0.3].
   * Computed as 0.1 * incomingEdges + 0.15 * outgoingEdges, clamped.
   * Weight in heat/decay is intentionally low (0.05) to avoid circular amplification.
   */
  causalImpactScore?: number;
}

export interface LifecycleDecision {
  currentState: LifecycleState;
  nextState: LifecycleState;
  heatScore: number;
  decayScore: number;
  changed: boolean;
  reason: string;
}

export interface LifecycleValueInputs {
  confidence: number;
  access: number;
  recency: number;
  importance: number;
  feedback: number;
  disputedPenalty: number;
}

const DEFAULT_POLICY: LifecyclePolicy = {
  promoteHeatThreshold: 0.55,
  staleDecayThreshold: 0.65,
  archiveDecayThreshold: 0.85,
  protectedCategories: ["decision", "principle", "commitment", "preference", "procedure"],
};

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function clampLifecycleThreshold(value: number): number {
  return clamp01(value);
}

function parseIsoMs(value?: string): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function daysSince(value: string | undefined, nowMs: number): number {
  const ts = parseIsoMs(value);
  if (ts === null) return 365;
  return Math.max(0, (nowMs - ts) / 86_400_000);
}

function confidenceTierWeight(frontmatter: MemoryFrontmatter): number {
  switch (frontmatter.confidenceTier) {
    case "explicit":
      return 1;
    case "implied":
      return 0.8;
    case "inferred":
      return 0.6;
    case "speculative":
      return 0.35;
    default:
      return clamp01(frontmatter.confidence ?? 0.5);
  }
}

function accessWeight(accessCount: number | undefined): number {
  const raw = accessCount ?? 0;
  if (raw <= 0) return 0;
  return clamp01(Math.log1p(raw) / Math.log1p(20));
}

function recencyWeight(frontmatter: MemoryFrontmatter, nowMs: number): number {
  const lastTouch = frontmatter.lastAccessed ?? frontmatter.updated ?? frontmatter.created;
  const ageDays = daysSince(lastTouch, nowMs);
  return clamp01(1 - ageDays / 90);
}

function feedbackWeight(signals?: LifecycleSignals): number {
  const raw = (signals?.feedbackScore ?? 0) + (signals?.actionPriorScore ?? 0);
  return clamp01((raw + 1) / 2);
}

function boundedFeedbackScore(signals?: LifecycleSignals): number {
  const raw = (signals?.feedbackScore ?? 0) + (signals?.actionPriorScore ?? 0);
  if (!Number.isFinite(raw)) return 0;
  if (raw < -1) return -1;
  if (raw > 1) return 1;
  return raw;
}

function isProtectedMemory(
  frontmatter: MemoryFrontmatter,
  policy: LifecyclePolicy,
): boolean {
  return frontmatter.policyClass === "protected" || policy.protectedCategories.includes(frontmatter.category);
}

export function resolveLifecycleState(frontmatter: MemoryFrontmatter): LifecycleState {
  if (frontmatter.status === "archived") return "archived";
  return frontmatter.lifecycleState ?? "candidate";
}

export function computeHeat(
  memory: Pick<MemoryFile, "frontmatter">,
  now: Date,
  signals?: LifecycleSignals,
): number {
  const frontmatter = memory.frontmatter;
  if (frontmatter.status === "archived") return 0;

  const inputs = computeLifecycleValueInputs(memory, now, signals);
  const causalBoost = clamp01(signals?.causalImpactScore ?? 0) * 0.05;
  const score = (inputs.confidence * 0.25)
    + (inputs.access * 0.3)
    + (inputs.recency * 0.2)
    + (inputs.importance * 0.15)
    + (inputs.feedback * 0.1)
    + causalBoost
    - inputs.disputedPenalty;
  return clamp01(score);
}

export function computeLifecycleValueInputs(
  memory: Pick<MemoryFile, "frontmatter">,
  now: Date,
  signals?: LifecycleSignals,
): LifecycleValueInputs {
  const frontmatter = memory.frontmatter;
  const nowMs = now.getTime();
  return {
    confidence: confidenceTierWeight(frontmatter),
    access: accessWeight(frontmatter.accessCount),
    recency: recencyWeight(frontmatter, nowMs),
    importance: clamp01(frontmatter.importance?.score ?? 0.5),
    feedback: feedbackWeight(signals),
    disputedPenalty: frontmatter.verificationState === "disputed" ? 0.2 : 0,
  };
}

export function computeDecay(
  memory: Pick<MemoryFile, "frontmatter">,
  now: Date,
  signals?: LifecycleSignals,
): number {
  const frontmatter = memory.frontmatter;
  if (frontmatter.status === "archived") return 1;

  const nowMs = now.getTime();
  const ageDays = daysSince(frontmatter.updated ?? frontmatter.created, nowMs);
  const staleAccessDays = daysSince(frontmatter.lastAccessed, nowMs);
  const ageRisk = clamp01(ageDays / 180);
  const staleAccessRisk = clamp01(staleAccessDays / 120);
  const confidenceRisk = 1 - confidenceTierWeight(frontmatter);
  const feedbackRisk = clamp01((boundedFeedbackScore(signals) * -1 + 1) / 2);
  const heat = computeHeat(memory, now, signals);

  const score = (ageRisk * 0.3)
    + (staleAccessRisk * 0.25)
    + (confidenceRisk * 0.2)
    + (feedbackRisk * 0.1)
    + ((1 - heat) * 0.15);

  return clamp01(score);
}

function toTerminalDisputedState(
  currentState: LifecycleState,
): LifecycleState {
  if (currentState === "archived") return "archived";
  return "stale";
}

function isActiveEligible(verificationState?: VerificationState): boolean {
  return verificationState === "user_confirmed" || verificationState === "system_inferred";
}

export function decideLifecycleTransition(
  memory: Pick<MemoryFile, "frontmatter">,
  policy: Partial<LifecyclePolicy>,
  now: Date,
  signals?: LifecycleSignals,
): LifecycleDecision {
  const mergedPolicy: LifecyclePolicy = { ...DEFAULT_POLICY, ...policy };
  const frontmatter = memory.frontmatter;
  const currentState = resolveLifecycleState(frontmatter);
  const heatScore = computeHeat(memory, now, signals);
  const decayScore = computeDecay(memory, now, signals);
  const protectedMemory = isProtectedMemory(frontmatter, mergedPolicy);

  if (currentState === "archived") {
    return {
      currentState,
      nextState: "archived",
      heatScore,
      decayScore,
      changed: false,
      reason: "archived_is_terminal",
    };
  }

  if (frontmatter.verificationState === "disputed") {
    const nextState = toTerminalDisputedState(currentState);
    return {
      currentState,
      nextState,
      heatScore,
      decayScore,
      changed: nextState !== currentState,
      reason: "disputed_memories_do_not_promote_to_active",
    };
  }

  if (decayScore >= mergedPolicy.archiveDecayThreshold && !protectedMemory) {
    return {
      currentState,
      nextState: "archived",
      heatScore,
      decayScore,
      changed: true,
      reason: "decay_exceeded_archive_threshold",
    };
  }

  if (decayScore >= mergedPolicy.staleDecayThreshold) {
    return {
      currentState,
      nextState: "stale",
      heatScore,
      decayScore,
      changed: currentState !== "stale",
      reason: "decay_exceeded_stale_threshold",
    };
  }

  if (heatScore >= mergedPolicy.promoteHeatThreshold) {
    const nextState = isActiveEligible(frontmatter.verificationState)
      ? "active"
      : "validated";
    return {
      currentState,
      nextState,
      heatScore,
      decayScore,
      changed: currentState !== nextState,
      reason: "heat_exceeded_promote_threshold",
    };
  }

  return {
    currentState,
    nextState: currentState,
    heatScore,
    decayScore,
    changed: false,
    reason: "no_transition",
  };
}
