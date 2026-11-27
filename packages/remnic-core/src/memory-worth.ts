/**
 * Issue #560 PR 2 — Memory Worth scoring (pure helper).
 *
 * Given per-memory outcome counters (`mw_success`, `mw_fail` — added to
 * frontmatter in PR 1), compute a scalar worth score plus interpretable
 * metadata. The score is a Laplace-smoothed success probability with an
 * optional recency decay, and is meant to be used as a multiplier on existing
 * recall scores (PR 4) to sink memories that consistently lead to failed
 * sessions and keep uninstrumented memories at a neutral baseline.
 *
 * Intentional properties:
 *   - Pure function. No I/O, no time-of-import side effects. Testable in
 *     isolation; callers pass `now` so tests don't depend on the wall clock.
 *   - Laplace-smoothed ratio `(s + 1) / (s + f + 2)` ensures a memory with
 *     zero observations scores exactly 0.5 — neither boosted nor penalized.
 *     A single failure on a new memory lands at 1/3, not 0, so one bad
 *     session doesn't permanently exile a fact.
 *   - Recency decay is optional. When a memory hasn't been touched in a long
 *     time, its `p_success` is pulled back toward 0.5 (the prior). Decay is
 *     exponential with an operator-configured half-life so old verdicts
 *     aren't treated as equally informative as fresh ones.
 *   - Corrupt / missing inputs fail safely to the prior. Callers upstream of
 *     this helper (see `storage.parseMemoryWorthCounterField` in PR 1) already
 *     strip negatives and non-integers, but the helper re-validates so it
 *     survives being called directly from tests / ad-hoc tooling.
 *   - Confidence is the effective number of observations (post-decay). PR 4
 *     and PR 5 use it to decide whether the Memory Worth multiplier should
 *     actually be applied vs. left at 1.0 (i.e., "not enough signal yet").
 *
 * Out of scope here:
 *   - Mutating frontmatter (PR 3).
 *   - Recall integration / feature flag (PR 4).
 *   - Benchmark & default-flip (PR 5).
 */

/**
 * Input to `computeMemoryWorth`.
 *
 * All fields are optional so a legacy (pre-PR-1) memory can be passed through
 * without upstream guards — it will simply score to the neutral prior.
 */
export interface ComputeMemoryWorthInput {
  /** Count of sessions where this memory was recalled and the outcome was success. */
  mw_success?: number;
  /** Count of sessions where this memory was recalled and the outcome was failure. */
  mw_fail?: number;
  /**
   * ISO timestamp of the most recent outcome observation for this memory.
   * When provided together with `halfLifeMs`, observations decay exponentially
   * toward the uniform prior as they age. Absent / unparseable timestamp →
   * decay is skipped and raw counters are used directly.
   */
  lastAccessed?: string | null;
  /**
   * Current wall-clock reference. Required in the signature (not defaulted to
   * `Date.now()`) so the function stays pure and tests are deterministic.
   */
  now: Date;
  /**
   * Half-life for outcome decay, in milliseconds. When `undefined` or `<= 0`,
   * no decay is applied (raw counts are used). When positive, counter weights
   * are multiplied by `2^(-age / halfLifeMs)`.
   */
  halfLifeMs?: number;
}

/**
 * Output of `computeMemoryWorth`.
 *
 * `score` is the value recall callers multiply into their base score.
 * `p_success` is the same number pre-clamped — exposed separately so
 * observability surfaces can log the probability distinctly from the
 * multiplier. `confidence` is the effective observation count after decay,
 * useful for UIs that want to render "strong signal" vs. "tentative".
 */
export interface MemoryWorthResult {
  /**
   * The Laplace-smoothed success probability, post-decay, clamped to
   * `[0, 1]`. This is the multiplier PR 4 applies to the base recall score.
   */
  score: number;
  /**
   * Same as `score` conceptually, surfaced separately so telemetry /
   * xray surfaces can report probability independently of whatever final
   * multiplier PR 4 chooses to apply.
   */
  p_success: number;
  /**
   * Effective observation count (`s_eff + f_eff`). With decay enabled this is
   * fractional; without decay it equals `mw_success + mw_fail` exactly.
   * Zero indicates no signal — callers should treat the score as a prior.
   */
  confidence: number;
}

const MAX_COUNTER = 1e12;

function classifyCounter(value: number | undefined): { ok: true; value: number } | { ok: false } {
  if (value === undefined) return { ok: true, value: 0 };
  if (typeof value !== "number") return { ok: false };
  if (!Number.isFinite(value)) return { ok: false };
  if (value < 0) return { ok: false };
  if (!Number.isInteger(value)) return { ok: false };
  if (value > MAX_COUNTER) return { ok: false };
  return { ok: true, value };
}

function parseLastAccessedMs(lastAccessed: string | null | undefined): number | null {
  if (!lastAccessed) return null;
  const parsed = Date.parse(lastAccessed);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function decayFactor(ageMs: number, halfLifeMs: number | undefined): number {
  if (typeof halfLifeMs !== "number") return 1;
  if (!Number.isFinite(halfLifeMs)) return 1;
  if (halfLifeMs <= 0) return 1;
  if (ageMs <= 0) return 1;
  return Math.pow(2, -ageMs / halfLifeMs);
}

/**
 * Score a single memory's worth based on outcome history.
 *
 * Returns the neutral prior (`0.5`, `confidence=0`) for uninstrumented
 * memories so the caller can treat "no data" and "data says 50/50"
 * identically — neither should be penalized.
 */
export function computeMemoryWorth(input: ComputeMemoryWorthInput): MemoryWorthResult {
  const sClass = classifyCounter(input.mw_success);
  const fClass = classifyCounter(input.mw_fail);
  if (!sClass.ok || !fClass.ok) {
    return { score: 0.5, p_success: 0.5, confidence: 0 };
  }
  const rawS = sClass.value;
  const rawF = fClass.value;

  const lastAccessedMs = parseLastAccessedMs(input.lastAccessed);
  const nowMs = input.now.getTime();
  const nowUsable = Number.isFinite(nowMs);
  const ageMs =
    !nowUsable || lastAccessedMs === null ? 0 : Math.max(0, nowMs - lastAccessedMs);
  const factor = nowUsable ? decayFactor(ageMs, input.halfLifeMs) : 1;

  const sEff = rawS * factor;
  const fEff = rawF * factor;

  const pSuccess = (sEff + 1) / (sEff + fEff + 2);

  const clamped = Math.max(0, Math.min(1, pSuccess));

  return {
    score: clamped,
    p_success: clamped,
    confidence: sEff + fEff,
  };
}
