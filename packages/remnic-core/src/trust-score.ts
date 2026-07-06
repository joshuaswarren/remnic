/**
 * trust-score.ts — unified TrustScore pure module (issue #1577 PR 1).
 *
 * Combines the trust-relevant signals Remnic already computes — memory worth
 * (Laplace-smoothed outcome probability + recency decay), provenance strength,
 * faithfulness verdict, corroboration count, contradiction status, and optional
 * domain calibration — into ONE deterministic score in `[0, 1]` plus a band
 * (`high` / `medium` / `low` / `quarantine`) and a fully-explained component
 * breakdown for X-ray.
 *
 * Contract rules (mirror the battle-tested `memory-worth.ts` "corrupt inputs
 * fail safely" header — read it before changing anything here):
 *
 *   1. **No signals → neutral.** An empty `TrustSignals` yields score `0.5`,
 *      band `medium`, and a recall multiplier of exactly `1.0`. Uninstrumented
 *      memories are NEVER penalized (rule 39 — byte-identical ranking when the
 *      feature is off; neutral prior when on but a memory has no data).
 *   2. **Corrupt / out-of-range component → that component collapses to
 *      neutral**, never to an extreme. A `NaN` weight or a `corroborationCount`
 *      of `-3` is treated as "no signal", not as damning evidence. Precedent:
 *      `memory-worth.ts` `classifyCounter`.
 *   3. **Deterministic.** Same inputs → identical result. All weights come from
 *      the caller (config); no wall clock, no RNG, no hidden constants.
 *   4. **Explainable.** Every active component is echoed in the result with its
 *      normalized weight and contribution, so X-ray can render the basis
 *      without re-deriving the math.
 *   5. **`quarantine` is reserved for hard negatives** — `faithfulness:
 *      "contradicted"` or `contradiction: "pending_review"`. Quarantined items
 *      are excluded from injection but MUST stay visible in X-ray with the
 *      reason (rule 34 — exclusion must never look like "no result").
 *
 * This module is deliberately framework-free: it takes already-collected
 * signals and config weights, returns a score. The signal ADAPTERS (reading
 * frontmatter / counters / review queues) live in `trust-score-stage.ts` so
 * this file stays pure and trivially property-testable.
 */

/**
 * Per-component weights. Every field is optional and defaults to the
 * `DEFAULT_TRUST_WEIGHTS` value; the caller passes the config-resolved object.
 * Weights are sum-normalized at score time, so their absolute scale is
 * irrelevant — only their relative magnitudes matter (rule 51: invalid weight
 * rejected at config parse, here we only defend against runtime corruption).
 */
export interface TrustWeights {
  /** Laplace-smoothed outcome probability (memory worth `score`). */
  memoryWorth?: number;
  /** Provenance strength tag mapped to `[0,1]` (verified→1, unverified→0.5, none→neutral). */
  provenance?: number;
  /** Faithfulness verdict mapped to `[0,1]` (entailed→1, unchecked→neutral, contradicted→0). */
  faithfulness?: number;
  /** Independent corroboration count, log-saturated. */
  corroboration?: number;
  /** Contradiction review status (pending_review / resolved_superseded push toward 0). */
  contradiction?: number;
  /** Belief-ledger per-domain accuracy calibration (`0..1`), when available. */
  domainCalibration?: number;
  /** Feedback balance (thumbs up/down), when available. */
  feedback?: number;
  /** Recency vs per-category half-life (newer → higher). */
  recency?: number;
}

/**
 * Default per-component weights. Chosen so that, with all signals at neutral,
 * the score is exactly `0.5`. Sum-normalized at compute time. These are the
 * documented defaults; operators override via `trustScore.weights.*` config.
 */
export const DEFAULT_TRUST_WEIGHTS: Required<TrustWeights> = {
  memoryWorth: 0.28,
  provenance: 0.16,
  faithfulness: 0.20,
  corroboration: 0.12,
  contradiction: 0.10,
  domainCalibration: 0.04,
  feedback: 0.05,
  recency: 0.05,
};

/**
 * All trust-relevant signals for ONE memory. Every field is optional — the
 * scorer degrades to neutral for any absent or corrupt signal (rule 34).
 */
export interface TrustSignals {
  /** Memory-worth result (Laplace success prob + confidence). */
  memoryWorth?: { score: number; confidence: number };
  /** Thumbs feedback tallies. */
  feedback?: { up: number; down: number };
  /** Contradiction review queue status. */
  contradiction?: "none" | "pending_review" | "resolved_kept" | "resolved_superseded";
  /** Claim-level provenance strength (#1575). */
  provenance?: "verified" | "unverified" | "none";
  /** Faithfulness gate verdict (#1576). */
  faithfulness?: "entailed" | "contradicted" | "unsupported" | "unchecked";
  /** Count of distinct source turns/sessions corroborating the fact. */
  corroborationCount?: number;
  /** Belief-ledger accuracy for the memory's domain, `0..1`. */
  domainCalibration?: number;
  /** Age in days vs a per-category half-life (caller computes). */
  ageDays?: number;
  /** Half-life (days) for recency decay; the caller supplies the per-category value. */
  recencyHalfLifeDays?: number;
}

/** Trust band, coarse-grained for injection hedging and X-ray grouping. */
export type TrustBand = "high" | "medium" | "low" | "quarantine";

/**
 * One component's contribution to the final score, for full explainability.
 * `value` is the normalized `[0,1]` signal contribution; `weight` is the
 * sum-normalized weight that was applied.
 */
export interface TrustScoreComponent {
  value: number;
  weight: number;
}

/**
 * Full TrustScore result. `score` is the weighted blend in `[0,1]`; `band` is
 * the coarse category; `components` echoes every active component so X-ray /
 * epistemic rendering can explain the basis without re-deriving it.
 */
export interface TrustScoreResult {
  score: number;
  band: TrustBand;
  components: Record<string, TrustScoreComponent>;
  /**
   * `true` when the result is the neutral prior (no usable signals). Lets the
   * multiplier short-circuit to exactly `1.0` and the epistemic renderer skip
   * the hedge for the common uninstrumented case.
   */
  neutral: boolean;
}

/** Band thresholds on the blended score. */
export const TRUST_BAND_THRESHOLDS = {
  high: 0.7,
  medium: 0.45,
  low: 0.2,
} as const;

/** Neutral prior: the score an empty-signal memory receives. */
export const NEUTRAL_TRUST_SCORE = 0.5;

/**
 * Validate a single weight: a finite number in `[0, 1]`. Returns the value or
 * `undefined` when corrupt (the caller falls back to the default).
 */
function sanitizeWeight(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value)) return undefined;
  if (value < 0 || value > 1) return undefined;
  return value;
}

/**
 * Merge caller weights over the defaults, dropping corrupt entries. Exposed for
 * config parse so an invalid weight is rejected once at the boundary (rule 51
 * spirit) — but the scorer defends again here so a hand-built bench fixture
 * cannot poison the math.
 */
export function resolveTrustWeights(
  override: Readonly<TrustWeights> | undefined,
): Required<TrustWeights> {
  const out: Required<TrustWeights> = { ...DEFAULT_TRUST_WEIGHTS };
  if (!override) return out;
  (Object.keys(DEFAULT_TRUST_WEIGHTS) as Array<keyof TrustWeights>).forEach((key) => {
    const v = sanitizeWeight(override[key]);
    if (v !== undefined) out[key] = v;
  });
  return out;
}

/** Clamp a value to `[0,1]`; NaN/Infinity collapse to the neutral `0.5`. */
function clampUnit(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return NEUTRAL_TRUST_SCORE;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Coerce an already-`[0,1]` signal (domain calibration, etc.) for the scorer.
 * Returns `undefined` when absent or corrupt so the component is DROPPED — a
 * single corrupt signal must not be read as damning evidence nor as a neutral
 * contribution that masquerades as "we measured this". Mirrors the
 * `classifyCounter` precedent from `memory-worth.ts`.
 */
function unitValue(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 1) return undefined;
  return value;
}

/** Map a provenance tag to a `[0,1]` contribution. Absent → neutral. */
function provenanceValue(tag: TrustSignals["provenance"]): number | undefined {
  if (tag === undefined) return undefined;
  if (tag === "verified") return 1;
  if (tag === "unverified") return 0.5;
  // "none" is meaningful negative evidence (no surviving source span), not
  // neutral. It pulls toward 0 but gently so a single unprovenanced fact is
  // not damned on its own.
  if (tag === "none") return 0.25;
  return undefined;
}

/** Map a faithfulness verdict to a `[0,1]` contribution. Absent → neutral. */
function faithfulnessValue(verdict: TrustSignals["faithfulness"]): number | undefined {
  if (verdict === undefined) return undefined;
  if (verdict === "entailed") return 1;
  if (verdict === "unchecked") return NEUTRAL_TRUST_SCORE;
  if (verdict === "unsupported") return 0.35;
  // "contradicted" is a hard negative — it also forces quarantine (see below),
  // but as a component it contributes 0 so the blended score sinks.
  if (verdict === "contradicted") return 0;
  return undefined;
}

/** Map contradiction review status to a `[0,1]` contribution. */
function contradictionValue(
  status: TrustSignals["contradiction"],
): number | undefined {
  if (status === undefined) return undefined;
  if (status === "none") return NEUTRAL_TRUST_SCORE;
  if (status === "resolved_kept") return 0.7;
  if (status === "resolved_superseded") return 0.1;
  if (status === "pending_review") return 0.15;
  return undefined;
}

/** Feedback balance → `[0,1]` via Laplace smoothing (mirrors memory-worth). */
function feedbackValue(fb: TrustSignals["feedback"]): number | undefined {
  if (fb === undefined) return undefined;
  const up = typeof fb.up === "number" && Number.isFinite(fb.up) && fb.up >= 0 ? fb.up : 0;
  const down =
    typeof fb.down === "number" && Number.isFinite(fb.down) && fb.down >= 0 ? fb.down : 0;
  if (up === 0 && down === 0) return undefined;
  // Laplace: (up+1)/(up+down+2). Clamped defensively.
  return clampUnit((up + 1) / (up + down + 2));
}

/** Corroboration count → `[0,1]` via log-saturation (3+ sources ≈ 1.0). */
function corroborationValue(count: TrustSignals["corroborationCount"]): number | undefined {
  if (count === undefined) return undefined;
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return undefined;
  if (count === 0) return 0.3; // single mention is mild negative evidence vs neutral
  // log2(1 + count) saturates: 1→0.5, 2→0.63, 3→0.66, 4→0.68 ... capped at 1.
  return clampUnit(Math.log2(1 + count) / 2);
}

/** Recency decay vs a half-life, mapped so "fresh" → high, "stale" → low. */
function recencyValue(signals: TrustSignals): number | undefined {
  if (signals.ageDays === undefined) return undefined;
  if (typeof signals.ageDays !== "number" || !Number.isFinite(signals.ageDays) || signals.ageDays < 0)
    return undefined;
  const halfLife = signals.recencyHalfLifeDays;
  if (typeof halfLife !== "number" || !Number.isFinite(halfLife) || halfLife <= 0) return undefined;
  // 2^(-age/halfLife): age 0 → 1, age=halfLife → 0.5, age≫halfLife → ~0.
  return clampUnit(Math.pow(2, -signals.ageDays / halfLife));
}

/**
 * Determine whether the signals warrant the `quarantine` band: a hard negative
 * that excludes the item from injection (but never from X-ray — rule 34).
 */
function isHardNegative(signals: TrustSignals): boolean {
  if (signals.faithfulness === "contradicted") return true;
  if (signals.contradiction === "pending_review") return true;
  return false;
}

/**
 * Compute the unified TrustScore for one memory.
 *
 * Returns the neutral prior (`0.5`, band `medium`, `neutral: true`) when no
 * usable signal is present, so uninstrumented memories are untouched.
 */
export function computeTrustScore(
  signals: TrustSignals,
  weights: Readonly<TrustWeights> = DEFAULT_TRUST_WEIGHTS,
): TrustScoreResult {
  const resolved = resolveTrustWeights(weights);

  // Build the (component → value) map, skipping absent/corrupt signals.
  // Each value is already clamped to [0,1] by its mapper.
  const candidates: Array<{ key: keyof TrustWeights; value: number }> = [];
  const push = (key: keyof TrustWeights, value: number | undefined) => {
    if (value === undefined) return;
    candidates.push({ key, value: clampUnit(value) });
  };

  push("memoryWorth", signals.memoryWorth ? clampUnit(signals.memoryWorth.score) : undefined);
  push("provenance", provenanceValue(signals.provenance));
  push("faithfulness", faithfulnessValue(signals.faithfulness));
  push("corroboration", corroborationValue(signals.corroborationCount));
  push("contradiction", contradictionValue(signals.contradiction));
  push("domainCalibration", unitValue(signals.domainCalibration));
  push("feedback", feedbackValue(signals.feedback));
  push("recency", recencyValue(signals));

  // No usable signal → neutral prior, multiplier exactly 1.0.
  if (candidates.length === 0) {
    return {
      score: NEUTRAL_TRUST_SCORE,
      band: "medium",
      components: {},
      neutral: true,
    };
  }

  // Sum-normalize the active weights so absent components redistribute their
  // weight to the present ones (a memory with only memory-worth data is scored
  // purely on memory-worth, not half-scored because other signals are absent).
  const activeWeightSum = candidates.reduce((acc, c) => acc + resolved[c.key], 0);
  const safeWeightSum = activeWeightSum > 0 ? activeWeightSum : 1;

  let blended = 0;
  const components: Record<string, TrustScoreComponent> = {};
  for (const c of candidates) {
    const w = resolved[c.key] / safeWeightSum;
    blended += c.value * w;
    components[c.key] = { value: c.value, weight: w };
  }

  // Clamp the blend: floating-point noise can drift a hair outside [0,1].
  const score = clampUnit(blended);

  // Hard negatives are quarantined regardless of the blended score, so a
  // corroborated-but-contradicted fact is still excluded from injection.
  const band = bandForScore(score, isHardNegative(signals));

  return { score, band, components, neutral: false };
}

/**
 * Resolve the band from the blended score, accounting for hard-negative
 * quarantine. Extracted so the thresholds live in ONE place (X-ray, injection,
 * and tests all agree on the mapping).
 */
export function bandForScore(score: number, hardNegative: boolean): TrustBand {
  if (hardNegative) return "quarantine";
  const s = clampUnit(score);
  if (s >= TRUST_BAND_THRESHOLDS.high) return "high";
  if (s >= TRUST_BAND_THRESHOLDS.medium) return "medium";
  if (s >= TRUST_BAND_THRESHOLDS.low) return "low";
  return "low";
}

/**
 * Map a `[0,1]` trust score to a recall multiplier in
 * `[minMultiplier, maxMultiplier]`. The neutral prior (`0.5`) maps to exactly
 * `1.0` so uninstrumented memories are untouched. Linear interpolation centered
 * at neutral:
 *
 *   score < 0.5 → multiplier in [min, 1)
 *   score = 0.5 → 1.0
 *   score > 0.5 → multiplier in (1, max]
 */
export function trustMultiplier(
  score: number,
  minMultiplier: number = 0.5,
  maxMultiplier: number = 1.25,
): number {
  const min = typeof minMultiplier === "number" && Number.isFinite(minMultiplier) ? minMultiplier : 0.5;
  const max = typeof maxMultiplier === "number" && Number.isFinite(maxMultiplier) ? maxMultiplier : 1.25;
  // Defend against an inverted contract (min > max): pick the tighter bound.
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const s = clampUnit(score);
  if (s === NEUTRAL_TRUST_SCORE) return 1;
  if (s < NEUTRAL_TRUST_SCORE) {
    // Map [0, 0.5) → [lo, 1). score 0 → lo, score →0.5 → 1.
    const t = s / NEUTRAL_TRUST_SCORE; // [0,1)
    return lo + (1 - lo) * t;
  }
  // Map (0.5, 1] → (1, hi]. score 0.5 → 1, score 1 → hi.
  const t = (s - NEUTRAL_TRUST_SCORE) / (1 - NEUTRAL_TRUST_SCORE); // (0,1]
  return 1 + (hi - 1) * t;
}

/**
 * Deterministic epistemic hedge suffix for an injected memory line, generated
 * from the trust components (template, not LLM). Returns the empty string for
 * the `high` band and for neutral results so the common case wastes no tokens.
 *
 * Examples:
 *   high    → ""
 *   medium  → "(unconfirmed — single mention, 2025-11)"
 *   low     → "(low confidence — contradicted once, uncorroborated)"
 */
export function renderEpistemicHedge(result: TrustScoreResult): string {
  if (result.neutral) return "";
  switch (result.band) {
    case "high":
      return "";
    case "quarantine":
    case "low":
      return `(low confidence — ${describeWeakness(result.components)})`;
    case "medium":
      return `(unconfirmed — ${describeWeakness(result.components)})`;
    default:
      return "";
  }
}

/**
 * Build a short, deterministic weakness description from the components. Reads
 * the lowest-contributing signals so the hedge names the actual reason the
 * model should hedge. Pure and order-stable.
 */
function describeWeakness(components: Record<string, TrustScoreComponent>): string {
  const parts: string[] = [];
  const f = components.faithfulness;
  if (f && f.value <= 0.35) parts.push(f.value === 0 ? "contradicted" : "unsupported");
  const c = components.contradiction;
  if (c && c.value <= 0.2) parts.push("under review");
  const cor = components.corroboration;
  if (cor && cor.value <= 0.4) parts.push("single mention");
  const prov = components.provenance;
  if (prov && prov.value <= 0.3) parts.push("unprovenanced");
  const rec = components.recency;
  if (rec && rec.value <= 0.3) parts.push("stale");
  if (parts.length === 0) {
    // No single component is weak but the blend is below high — name the
    // weakest one explicitly so the hedge is never vacuous.
    let weakest: { key: string; value: number } | null = null;
    for (const [key, comp] of Object.entries(components)) {
      if (!weakest || comp.value < weakest.value) weakest = { key, value: comp.value };
    }
    if (weakest) parts.push(`weak ${humanizeComponentName(weakest.key)}`);
  }
  return parts.slice(0, 2).join(", ");
}

function humanizeComponentName(key: string): string {
  switch (key) {
    case "memoryWorth":
      return "outcome history";
    case "domainCalibration":
      return "domain calibration";
    default:
      return key;
  }
}
