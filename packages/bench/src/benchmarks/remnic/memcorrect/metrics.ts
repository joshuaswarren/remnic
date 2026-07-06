/**
 * MemCorrect metrics (issue #1584 PR 2).
 *
 * Every metric is a pure function over the probe log + resolved scenario
 * metadata. The runner records the probe log while driving an adapter
 * through the protocol; these functions turn that log into the 8 scores.
 *
 * Scoring prefers deterministic token containment over LLM judging
 * (checklist: a benchmark whose scores move with judge temperature is not
 * a benchmark). Paraphrase-tolerant checks go through the sealed-rubric
 * judge in the runner; these pure functions take already-resolved string
 * sets so they are unit-testable with hand-computed expected values.
 *
 * Half-open windows (checklist §23): "post-correction" includes probes
 * whose turnIndex is strictly greater than the correction's turnIndex.
 */

import type {
  MemCorrectMetricBundle,
  ProbeLogEntry,
  ResolvedAntiEvent,
  ResolvedCorrection,
  ResolvedReassertion,
} from "./types.js";

/** Normalize a string to a lowercase alnum-token set for containment. */
export function tokenize(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g);
  return new Set(tokens ?? []);
}

/** True iff every needle token appears in the haystack's token set. */
export function containsAll(haystack: string, needles: readonly string[]): boolean {
  if (needles.length === 0) return true;
  const hay = tokenize(haystack);
  for (const needle of needles) {
    if (!hay.has(needle.toLowerCase())) return false;
  }
  return true;
}

/** True iff none of the banned tokens appear in the haystack's token set. */
export function containsNone(haystack: string, banned: readonly string[]): boolean {
  if (banned.length === 0) return true;
  const hay = tokenize(haystack);
  for (const token of banned) {
    if (hay.has(token.toLowerCase())) return false;
  }
  return true;
}

/** Join a probe's recalled strings into one haystack for containment checks. */
function joinedRecall(entry: ProbeLogEntry): string {
  return entry.recalled.join(" ");
}

/**
 * A probe "passes" for a correction iff the corrected content is present
 * AND the retired content is absent from the joined recall.
 */
export function probePassesForCorrection(
  entry: ProbeLogEntry,
  correction: ResolvedCorrection,
): boolean {
  const hay = joinedRecall(entry);
  return (
    containsAll(hay, correction.correctedContent) &&
    containsNone(hay, correction.retiredContent)
  );
}

function entriesFor(
  log: readonly ProbeLogEntry[],
  scenarioId: string,
  phase: ProbeLogEntry["phase"],
): ProbeLogEntry[] {
  return log.filter((e) => e.scenarioId === scenarioId && e.phase === phase);
}

/**
 * uptake@next — fraction of corrections reflected in the *first*
 * post-correction probe (corrected present, retired absent).
 */
export function uptakeAtNext(
  log: readonly ProbeLogEntry[],
  corrections: readonly ResolvedCorrection[],
): number {
  if (corrections.length === 0) return 0;
  let passed = 0;
  for (const correction of corrections) {
    const post = entriesFor(log, correction.scenarioId, "post_correction")
      .sort((a, b) => a.turnIndex - b.turnIndex);
    // Half-open: only probes strictly after the correction count.
    const eligible = post.filter((e) => e.turnIndex > correction.turnIndex);
    const first = eligible[0];
    if (first && probePassesForCorrection(first, correction)) passed += 1;
  }
  return passed / corrections.length;
}

/**
 * uptake_latency — mean interaction turns until the first correct recall,
 * capped at `cap`. Returns the capped mean; censored (never-correct within
 * the cap) corrections contribute `cap` to the mean and are counted
 * separately in the censored tally the bundle reports.
 */
export function uptakeLatency(
  log: readonly ProbeLogEntry[],
  corrections: readonly ResolvedCorrection[],
  cap: number,
): { mean: number; censored: number } {
  if (corrections.length === 0) return { mean: 0, censored: 0 };
  let sum = 0;
  let censored = 0;
  for (const correction of corrections) {
    const post = entriesFor(log, correction.scenarioId, "post_correction")
      .sort((a, b) => a.turnIndex - b.turnIndex)
      .filter((e) => e.turnIndex > correction.turnIndex);
    let resolved = cap;
    for (const entry of post) {
      const delta = entry.turnIndex - correction.turnIndex;
      if (delta > cap) break;
      if (probePassesForCorrection(entry, correction)) {
        resolved = delta;
        break;
      }
    }
    if (resolved >= cap) censored += 1;
    sum += resolved;
  }
  return { mean: sum / corrections.length, censored };
}

/**
 * non_resurrection — fraction of retired facts that stay retired after
 * `runMaintenance()` ×K cycles AND re-ingest of the original establishing
 * transcript. A retired fact "stays retired" iff the retired content is
 * absent from BOTH the post-maintenance and post-reingest probes.
 */
export function nonResurrection(
  log: readonly ProbeLogEntry[],
  corrections: readonly ResolvedCorrection[],
): number {
  if (corrections.length === 0) return 0;
  let stayedRetired = 0;
  for (const correction of corrections) {
    const postMaint = entriesFor(log, correction.scenarioId, "post_maintenance");
    const postReingest = entriesFor(log, correction.scenarioId, "post_reingest");
    const both = [...postMaint, ...postReingest];
    if (both.length === 0) continue;
    const allRetired = both.every((e) =>
      containsNone(joinedRecall(e), correction.retiredContent),
    );
    if (allRetired) stayedRetired += 1;
  }
  return corrections.length > 0 ? stayedRetired / corrections.length : 0;
}

/**
 * collateral — recall over a fixed probe set of UNRELATED facts, before vs
 * after corrections. Returns the delta (after − before); unchanged = 0 is
 * the target. `before` and `after` are parallel arrays of unrelated-probe
 * results (1 if expected content surfaced, 0 otherwise).
 */
export function collateralDelta(
  before: readonly number[],
  after: readonly number[],
): number {
  if (before.length === 0) return 0;
  const mean = (xs: readonly number[]) =>
    xs.reduce((s, x) => s + x, 0) / xs.length;
  return mean(after) - mean(before);
}

/**
 * scope_precision — for scoped corrections, fraction where the namespace-B
 * twin stays intact AND the namespace-A retired fact is retired.
 */
export function scopePrecision(
  log: readonly ProbeLogEntry[],
  corrections: readonly ResolvedCorrection[],
): number {
  let scopedCount = 0;
  let passed = 0;
  for (const correction of corrections) {
    const twin = correction.scopedTwin;
    if (!twin) continue;
    scopedCount += 1;
    const primaryPost = entriesFor(log, correction.scenarioId, "post_correction")
      .filter((e) => e.turnIndex > correction.turnIndex)
      .sort((a, b) => a.turnIndex - b.turnIndex)[0];
    // Twin probe: most recent twin-namespace post-correction probe.
    const twinPost = log
      .filter(
        (e) =>
          e.scenarioId === correction.scenarioId &&
          e.namespace === twin.namespace &&
          e.phase === "post_correction" &&
          e.turnIndex > correction.turnIndex,
      )
      .sort((a, b) => a.turnIndex - b.turnIndex)[0];
    if (!primaryPost || !twinPost) continue;
    const primaryRetired = containsNone(
      joinedRecall(primaryPost),
      correction.retiredContent,
    );
    const twinIntact = containsAll(joinedRecall(twinPost), [twin.twinContent]);
    if (primaryRetired && twinIntact) passed += 1;
  }
  return scopedCount > 0 ? passed / scopedCount : 0;
}

/**
 * false_apply — fraction of anti-events that caused an undesired memory
 * mutation. Detected behaviorally: after ingesting an anti-event, a probe
 * returning the `shouldNotAppear` token counts as a false apply. Lower is
 * better; the prompt-only baseline is expected to score high here.
 */
export function falseApply(
  log: readonly ProbeLogEntry[],
  antiEvents: readonly ResolvedAntiEvent[],
): number {
  if (antiEvents.length === 0) return 0;
  let triggered = 0;
  for (const anti of antiEvents) {
    // The runner records the post-anti probe under post_correction phase
    // (anti-events are ingested between correction and the maintenance
    // cycle); the token is scenario-scoped so cross-scenario leakage
    // cannot inflate the score.
    const probes = log.filter(
      (e) => e.scenarioId === anti.scenarioId && e.phase === "post_correction",
    );
    const leaked = probes.some((e) =>
      containsAll(joinedRecall(e), [anti.shouldNotAppear]),
    );
    if (leaked) triggered += 1;
  }
  return triggered / antiEvents.length;
}

/**
 * reassertion — fraction of re-asserted facts recallable again after the
 * re-assertion event.
 */
export function reassertion(
  log: readonly ProbeLogEntry[],
  reassertions: readonly ResolvedReassertion[],
): number {
  if (reassertions.length === 0) return 0;
  let recalled = 0;
  for (const re of reassertions) {
    const post = entriesFor(log, re.scenarioId, "post_reassertion");
    const found = post.some((e) =>
      containsAll(joinedRecall(e), [re.expectedContent]),
    );
    if (found) recalled += 1;
  }
  return recalled / reassertions.length;
}

/**
 * provenance_fidelity — for systems that expose provenance, fraction of
 * corrected states whose recall cites the correction event. The runner
 * passes `null` (and the bundle reports n/a) when the adapter does not
 * surface provenance. `citeLog` parallels `corrections`: 1 if the
 * post-correction recall cited the correction event, 0 otherwise.
 */
export function provenanceFidelity(
  citeLog: readonly (number | null)[],
): number | null {
  if (citeLog.length === 0) return null;
  if (citeLog.every((v) => v === null)) return null;
  const scored = citeLog.filter((v): v is number => v !== null);
  if (scored.length === 0) return null;
  return scored.reduce((s, v) => s + v, 0) / scored.length;
}

/** Compute the full metric bundle from resolved inputs. */
export function computeMetricBundle(args: {
  log: readonly ProbeLogEntry[];
  corrections: readonly ResolvedCorrection[];
  antiEvents: readonly ResolvedAntiEvent[];
  reassertions: readonly ResolvedReassertion[];
  collateralBefore: readonly number[];
  collateralAfter: readonly number[];
  provenanceCites: readonly (number | null)[];
  uptakeLatencyCap: number;
}): MemCorrectMetricBundle {
  const latency = uptakeLatency(
    args.log,
    args.corrections,
    args.uptakeLatencyCap,
  );
  return {
    uptake_at_next: uptakeAtNext(args.log, args.corrections),
    uptake_latency: latency.mean,
    uptake_latency_censored: latency.censored,
    non_resurrection: nonResurrection(args.log, args.corrections),
    collateral_delta: collateralDelta(args.collateralBefore, args.collateralAfter),
    scope_precision: scopePrecision(args.log, args.corrections),
    false_apply: falseApply(args.log, args.antiEvents),
    reassertion: reassertion(args.log, args.reassertions),
    provenance_fidelity: provenanceFidelity(args.provenanceCites),
  };
}
