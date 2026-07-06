/**
 * MemCorrect — an open correction/steerability benchmark (issue #1584).
 *
 * Type definitions for the system-agnostic adapter contract, the synthetic
 * scenario corpus, and the probe log the runner records while driving an
 * adapter through the correction protocol.
 *
 * Design notes
 * ------------
 * The adapter interface is deliberately minimal and system-agnostic: that
 * is what makes MemCorrect a *field* benchmark rather than a Remnic-only
 * regression test. Any memory system that can ingest turns, recall ranked
 * context, accept a correction, and run maintenance can be scored on
 * identical scenarios with identical metrics.
 *
 * Time windows are half-open `[start, end)` everywhere (checklist §23):
 * a probe at exactly the correction timestamp belongs to the pre-correction
 * window; the post-correction window opens strictly after the correction.
 */

/** Fact categories the generator spreads across the corpus. */
export type FactCategory =
  | "fact"
  | "preference"
  | "decision"
  | "commitment"
  | "relationship";

/** The four correction shapes the benchmark measures. */
export type CorrectionShape =
  | "explicit-targeted"
  | "conversational"
  | "scoped"
  | "re-assertion";

/** A single conversational turn that establishes (or re-asserts) a fact. */
export interface EstablishingTurn {
  role: "user" | "assistant";
  text: string;
  /** ISO timestamp; the generator emits monotonically increasing values. */
  at: string;
}

/**
 * A scripted correction event. `retiredContent` is the token set that must
 * be ABSENT from recall after the correction takes effect; `correctedContent`
 * is the token set that must be PRESENT.
 */
export interface CorrectionEvent {
  shape: CorrectionShape;
  /** Turn that delivers the correction through the adapter's normal path. */
  turn: EstablishingTurn;
  /** Tokens (lowercased) that should no longer surface after correction. */
  retiredContent: string[];
  /** Tokens (lowercased) that should surface after correction. */
  correctedContent: string[];
}
/**
 * Internal generator plan for one persona-fact. Exported so the generator
 * module can be unit-tested at the plan level without re-declaring the shape.
 */
export interface PersonaFactPlanLike {
  persona: string;
  namespace: string;
  category: FactCategory;
  subject: string;
  oldValue: string;
  newValue: string;
  shape: CorrectionShape;
}

/**
 * An event that must NOT cause a durable memory mutation: quoting someone
 * else, a hypothetical, a third-party correction. `shouldNotAppear` is the
 * token that, if it surfaces in a subsequent probe, indicates a false apply.
 */
export interface AntiEvent {
  kind: "quoting-other" | "hypothetical" | "third-party-correction";
  turn: EstablishingTurn;
  probeQuery: string;
  shouldNotAppear: string;
}

/**
 * A probe query used to test recall at each protocol phase. `mustContain`
 * tokens must surface; `mustAbsent` tokens must not.
 */
export interface ProbeQuery {
  query: string;
  mustContain: string[];
  mustAbsent: string[];
}

/** A scoped twin: the same-text fact seeded in a second namespace. */
export interface ScopedTwin {
  namespace: string;
  /** Turns that seed the twin in its own namespace. */
  establishingTurns: EstablishingTurn[];
  /** Token that must KEEP surfacing in the twin namespace after the scoped
   * correction lands in the primary namespace. */
  twinContent: string;
}

/** Re-assertion block: after a correction, the user walks it back. */
export interface Reassertion {
  turn: EstablishingTurn;
  /** Token that must surface again after the re-assertion. */
  expectedContent: string;
}

/** A probe over an unrelated fact, used for the collateral metric. */
export interface UnrelatedProbe {
  query: string;
  expectedContent: string;
  /**
   * Turns that seed the unrelated fact in the primary namespace BEFORE the
   * baseline probe. Without these the collateral metric recalls facts that
   * were never stored. Each turn carries the expected value so deduping or
   * summarizing systems still capture it.
   */
  establishingTurns: EstablishingTurn[];
}

/** One MemCorrect scenario. The runner emits one task per scenario. */
export interface MemCorrectScenario {
  id: string;
  /** Primary namespace the corrected fact lives in. */
  namespace: string;
  category: FactCategory;
  /** Transcript that establishes the original (about-to-be-corrected) fact. */
  establishingTurns: EstablishingTurn[];
  correction: CorrectionEvent;
  /** Probe used at every post-correction phase. */
  probe: ProbeQuery;
  antiEvents: AntiEvent[];
  /** Present only for `scoped` and `re-assertion` scenarios. */
  scopedTwin?: ScopedTwin;
  reassertion?: Reassertion;
  /** Unchanged facts whose recall should be undamaged by the correction. */
  unrelatedProbes: UnrelatedProbe[];
}

/** The full seeded corpus. */
export interface MemCorrectCorpus {
  options: MemCorrectGeneratorOptions;
  scenarios: MemCorrectScenario[];
}

/** Generator options. Deterministic given an identical `seed`. */
export interface MemCorrectGeneratorOptions {
  /** Number of personas (each owns ≥2 namespaces). */
  personaCount: number;
  /** Facts per persona, spread across categories. */
  factsPerPersona: number;
  /** PRNG seed. */
  seed: number;
  /** Anchor "now"; all timestamps derive from this. */
  nowIso: string;
  /** Maintenance cycles applied between post-correction and post-reingest. */
  maintenanceCycles: number;
  /** Latency cap (in interaction turns) for `uptake_latency`. */
  uptakeLatencyCap: number;
}

/**
 * The system-agnostic adapter contract. This is the public surface a
 * third-party memory system implements to be scored on MemCorrect.
 *
 * Implementations MUST be isolated: `reset()` returns the system to a clean
 * slate, and no call reaches into another system's durable store.
 */
export interface MemCorrectSystemAdapter {
  /** Human-readable label for artifact metadata (e.g. "remnic-native"). */
  readonly label: string;
  /** Reset to a clean slate before each scenario. */
  reset(): Promise<void>;
  /** Ingest one conversational turn through the system's normal observe path. */
  ingestTurn(
    sessionKey: string,
    role: "user" | "assistant",
    text: string,
    at: string,
  ): Promise<void>;
  /** Ranked memory/context strings for a probe query in a session. */
  recall(query: string, sessionKey: string): Promise<string[]>;
  /** However the system accepts a correction (explicit tool, turn, contract). */
  correct(text: string, sessionKey: string): Promise<void>;
  /**
   * Consolidation / dreams / pattern-reinforcement / contradiction scan.
   * A no-op is allowed; the protocol runs this N times between phases and
   * the `non_resurrection` metric measures whether retired facts survive it.
   */
  runMaintenance(): Promise<void>;
}

/** Protocol phase a probe was recorded at. Half-open window ordering. */
export type ProbePhase =
  | "baseline"
  | "post_correction"
  | "post_maintenance"
  | "post_reingest"
  | "post_reassertion";

/** One row of the probe log the runner records while driving the adapter. */
export interface ProbeLogEntry {
  scenarioId: string;
  phase: ProbePhase;
  /** Monotonic interaction-turn counter across the whole scenario run. */
  turnIndex: number;
  namespace: string;
  query: string;
  recalled: string[];
  /** ISO timestamp of the probe (for half-open window logic). */
  at: string;
}

/** A correction's resolved metadata for metric computation. */
export interface ResolvedCorrection {
  scenarioId: string;
  namespace: string;
  turnIndex: number;
  retiredContent: string[];
  correctedContent: string[];
  /** Present for scoped scenarios. */
  scopedTwin?: ScopedTwin;
}

/** Anti-event resolution for the false_apply metric. */
export interface ResolvedAntiEvent {
  scenarioId: string;
  namespace: string;
  probeQuery: string;
  shouldNotAppear: string;
}

/** Re-assertion resolution for the reassertion metric. */
export interface ResolvedReassertion {
  scenarioId: string;
  namespace: string;
  expectedContent: string;
}

/** The structured metric bundle the runner emits under task `details`. */
export interface MemCorrectMetricBundle {
  uptake_at_next: number;
  uptake_latency: number;
  uptake_latency_censored: number;
  non_resurrection: number;
  collateral_delta: number;
  scope_precision: number;
  false_apply: number;
  reassertion: number;
  /** 0..1 when the adapter exposes provenance; `null` when n/a. */
  provenance_fidelity: number | null;
}

/** Marker the runner sets when an adapter does not expose provenance. */
export const PROVENANCE_NOT_SUPPORTED: unique symbol = Symbol(
  "memcorrect.provenance.not-supported",
);
