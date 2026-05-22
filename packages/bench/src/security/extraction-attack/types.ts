/**
 * Types for the ADAM-style memory-extraction attack harness.
 *
 * See docs/security/memory-extraction-threat-model.md for the threat model
 * this harness probes. The harness targets the modeled read-path surfaces
 * enumerated in §4 of that document (recall / memory_search /
 * memory_entities_list / …), driven in-process against a seeded memory
 * fixture so tests do not need a running daemon.
 */

/**
 * Attacker knowledge tier the harness simulates.
 *
 * These correspond to the T1/T2/T3 tiers in the threat model (§3):
 *
 * - `zero-knowledge` — attacker has no prior information about the memory
 *   contents, must probe purely from seed vocabulary. Roughly T1 with a
 *   minimal token (or T2 on a newly-provisioned namespace).
 * - `same-namespace` — attacker holds a valid token for the same namespace as
 *   the seeded memories and may use entity-graph enumeration as side channel.
 *   This is the primary T2 tier.
 * - `cross-namespace` — attacker holds a valid token for a *different*
 *   namespace but attempts to leak memories from the victim namespace via
 *   shared-namespace auto-promotion or debug snapshots (T3).
 */
export type AttackerMode =
  | "zero-knowledge"
  | "same-namespace"
  | "cross-namespace";

/**
 * A single seeded memory the harness treats as ground truth.
 *
 * Ground-truth labelling is intentionally coarse: `tokens` is the set of
 * salient lowercase tokens that uniquely identify this memory to a human.
 * A recovered query transcript is considered to have leaked the memory if
 * the response contains a substring that covers a configurable fraction of
 * these tokens (see `recoveryTokenOverlap`).
 */
export interface SeededMemory {
  /** Stable identifier. */
  id: string;
  /** Raw memory text as it would be stored. */
  content: string;
  /**
   * Category bucket (fact / preference / decision / entity / …). Mirrors the
   * buckets the threat model lists in §2 (Assets). Used by the harness only
   * for reporting; not used in the attack loop itself.
   */
  category: "fact" | "preference" | "decision" | "entity" | "other";
  /** Namespace the memory lives in. */
  namespace: string;
  /**
   * Optional set of salient tokens that define "the attacker recovered this
   * memory". If omitted, defaults to all alphanumeric tokens of length > 2 in
   * `content`.
   */
  tokens?: string[];
}

/**
 * One retrieval result returned by the target surface.
 *
 * The shape is intentionally narrower than `MemoryRecord` in core — the
 * harness only needs the attacker-observable subset.
 */
export interface AttackRetrievalHit {
  /**
   * Stable memory identifier if the surface exposes one. Attackers can use
   * this as a side channel (memory IDs are disclosed by recall responses in
   * the current MCP surface), so we model it explicitly.
   */
  memoryId?: string;
  /** Namespace the memory came from, if the surface discloses it. */
  namespace?: string;
  /** Text content (summary or full) the surface returned. */
  content: string;
  /** Optional relevance score. */
  score?: number;
}

/**
 * Minimal contract an attack target must satisfy.
 *
 * Callers wrap the real `EngramAccessService.recall()` or a test stub. The
 * harness deliberately does not depend on `@remnic/core` directly; PR 3
 * will provide the binding to the real orchestrator.
 */
export interface ExtractionAttackTarget {
  /**
   * Execute a recall query against the target and return its hits.
   *
   * Should throw (or return an empty array) when the target denies the
   * query — the harness treats both as "no information gained".
   */
  recall(query: string, options?: AttackRecallOptions): Promise<AttackRetrievalHit[]>;
  /**
   * Optional side channel: enumerate known entity names. Present iff the
   * attacker mode was granted access to `memory_entities_list`.
   */
  listEntities?(): Promise<string[]>;
}

export interface AttackRecallOptions {
  /** Top-K to request. Defaults to harness budget. */
  topK?: number;
  /** Namespace override (harness uses this for T3 cross-namespace probes). */
  namespace?: string;
}

/**
 * Deterministic PRNG interface. Callers can pass a seeded PRNG to make runs
 * reproducible.
 */
export interface HarnessRng {
  /** Returns a float in [0, 1). */
  next(): number;
}

/**
 * Configuration for a single harness run.
 */
export interface ExtractionAttackOptions {
  target: ExtractionAttackTarget;
  /** Ground-truth memories the harness is trying to recover. */
  groundTruth: readonly SeededMemory[];
  /** Attacker knowledge tier. */
  attackerMode: AttackerMode;
  /** Maximum number of recall queries the harness is allowed to issue. */
  queryBudget: number;
  /**
   * Hyper-parameter for the adaptive loop: when the normalized entropy of
   * the response distribution falls below this value, the harness switches
   * to exploitation (repeating high-signal tokens) rather than exploration.
   * Defaults to 0.3.
   */
  entropyThreshold?: number;
  /**
   * Deterministic RNG. Callers should pass a seeded instance to get
   * reproducible results.
   */
  rng?: HarnessRng;
  /**
   * Seed vocabulary the attacker starts from. In `zero-knowledge` mode this
   * is the *only* prior information; in `same-namespace` mode it is a seed
   * for exploration. Defaults to a small English stop-list plus common
   * personal-memory topics.
   */
  seedVocabulary?: readonly string[];
  /**
   * Fraction of ground-truth tokens a single retrieved response must cover
   * to count as "recovered". Defaults to 0.5.
   */
  recoveryTokenOverlap?: number;
  /** If true, every query and response is kept in `timeline`. */
  captureTimeline?: boolean;
  /** TopK to request per query. Defaults to 10. */
  topK?: number;
  /**
   * Namespace the attacker addresses their queries to. When set, every
   * `target.recall()` is invoked with `namespace: attackerNamespace`.
   * Useful for T3-class runs where the caller wants to simulate an
   * attacker holding a token for a specific cross-namespace tenant.
   *
   * Defaults:
   * - `zero-knowledge`: undefined (target uses its own default).
   * - `same-namespace`: undefined (target uses its own default).
   * - `cross-namespace`: `"shared"` (matches the residual-leak path the
   *   threat model calls out in §5, but callers targeting other namespace
   *   models should pass an explicit value here).
   */
  attackerNamespace?: string;
  /**
   * Optional absolute deadline in ms since epoch. If the harness crosses it
   * during the attack loop, it terminates early with a partial result. Used
   * by tests to keep runs bounded.
   */
  deadlineMs?: number;
  /**
   * When true, a thrown error from `target.recall` aborts the attack
   * loop and re-throws. Default false — errors are counted in
   * `ExtractionAttackResult.backendErrorCount` so callers can distinguish
   * genuine empty recalls from backend failures. Flip to true in CI
   * gating scripts that must not silently publish ASR from a degraded
   * target.
   */
  failOnBackendError?: boolean;
}

export interface RecoveredMemory {
  memoryId: string;
  memory: SeededMemory;
  recoveredContent: string;
  queriesUsed: number;
  /** Index into `timeline` that first recovered this memory. */
  firstHitAt: number;
}

export interface TimelineEntry {
  query: string;
  hits: AttackRetrievalHit[];
  entropy: number;
  newlyRecoveredMemoryIds: string[];
  /** Which strategy chose this query. Useful for diagnosing the algorithm. */
  strategy:
    | "seed"
    | "exploit-entity"
    | "exploit-token"
    | "explore-random"
    | "explore-entropy";
}

export interface ExtractionAttackResult {
  /** Attack Success Rate: fraction of ground-truth memories recovered. */
  asr: number;
  /** Number of queries issued (may be less than budget on early exit). */
  queriesIssued: number;
  /** Attacker mode this run simulated. */
  attackerMode: AttackerMode;
  /** Recovered memories with per-memory metadata. */
  recovered: RecoveredMemory[];
  /** Ground-truth memories the attacker failed to recover within budget. */
  missed: SeededMemory[];
  /** Full query-by-query trace. Empty unless `captureTimeline: true`. */
  timeline: TimelineEntry[];
  /** Seconds of wall time spent inside the attack loop. */
  durationMs: number;
  /** True iff the run stopped because `deadlineMs` was reached. */
  hitDeadline: boolean;
  /**
   * Number of `target.recall` calls that threw and were treated as empty
   * hits. A high value means the harness was talking to a degraded
   * backend — low/zero ASR in that case is not a security statement
   * about the system, it is a measurement failure. Callers that want to
   * fail-fast on backend errors can pass `failOnBackendError: true`.
   */
  backendErrorCount: number;
}
