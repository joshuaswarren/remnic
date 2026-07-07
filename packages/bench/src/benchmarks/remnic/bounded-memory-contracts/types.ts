/**
 * Bounded-memory contract benchmark types (issue #1708).
 *
 * This benchmark compares four memory/context strategies under a controlled,
 * fully-offline, deterministic harness. No LLM is called in quick mode — the
 * "agent" is a pure deterministic function of the assembled memory pack, so
 * every run with the same seed produces byte-identical scores and artifacts.
 *
 * The thesis under test (from the issue): typed, scoped, citable memory
 * primitives carry metadata (status, scope, supersession, category) that raw
 * transcript text does not. The deterministic agent reasons over whatever
 * metadata the condition exposes, so the four conditions produce genuinely
 * different quality / governance / cost tradeoffs — not hard-coded outcomes.
 */

/** The seven task families the smoke fixture covers. */
export type BoundedMemoryTaskFamily =
  | "recall-needed"
  | "stale-memory-trap"
  | "wrong-scope-trap"
  | "skill-positive"
  | "skill-negative"
  | "ask-needed"
  | "act-when-enough";

/**
 * The four experiment conditions.
 *
 * C0–C3 mirror the issue's condition labels. The directory names match the
 * issue's required-artifacts tree so saved packs land under
 * `conditions/<dir>/`.
 */
export type BoundedMemoryConditionId =
  | "no-memory" // C0
  | "raw-transcript" // C1
  | "typed-contract" // C2
  | "typed-plus-skills"; // C3

export const BOUNDED_MEMORY_CONDITIONS: readonly BoundedMemoryConditionId[] = [
  "no-memory",
  "raw-transcript",
  "typed-contract",
  "typed-plus-skills",
] as const;

export const BOUNDED_MEMORY_CONDITION_LABELS: Record<
  BoundedMemoryConditionId,
  string
> = {
  "no-memory": "C0 no-memory",
  "raw-transcript": "C1 raw-transcript",
  "typed-contract": "C2 typed-contract",
  "typed-plus-skills": "C3 typed-plus-skills",
};

/** A synthetic memory item in a task's trace. */
export interface FixtureMemoryItem {
  id: string;
  category:
    | "fact"
    | "decision"
    | "preference"
    | "principle"
    | "entity"
    | "correction"
    | "boundary";
  /** Scope tag, e.g. "project:acme" or "user:alice". */
  scope: string;
  status: "active" | "pending_review" | "superseded";
  /** Id of the item that supersedes this one, when status === "superseded". */
  supersededBy?: string;
  content: string;
  /** Keywords used for deterministic relevance matching. */
  subjectKeywords: string[];
  /** The answer value this item implies, when it bears on a task. */
  answerToken?: string;
  /** Whether this is a wrong-scope decoy that must NOT leak into the task. */
  wrongScope?: boolean;
  /** Approximate token cost of the rendered line. */
  tokens: number;
  /** Chronological position in the trace (higher = more recent). */
  turn: number;
}

/** A procedural/skill memory available for trigger-based injection (C3). */
export interface FixtureSkill {
  id: string;
  title: string;
  trigger: string;
  appliesWhen: string[];
  doesNotApplyWhen: string[];
  steps: string[];
  status: "active" | "pending_review" | "deprecated";
  sourceMemoryIds: string[];
  confidence: number;
  tokens: number;
}

/** A single benchmark task. */
export interface BoundedMemoryTask {
  id: string;
  family: BoundedMemoryTaskFamily;
  prompt: string;
  /** The scope the task operates in (scope filter uses this). */
  scope: string;
  subjectKeywords: string[];
  expectedAnswer: string;
  /** Memory id the correct answer depends on (recall-needed / stale / scope). */
  shouldRecallId?: string;
  /** Item ids that MUST be excluded (stale / wrong-scope decoys). */
  shouldExcludeIds: string[];
  /** Skill id that SHOULD trigger for skill-positive tasks. */
  shouldUseSkillId?: string;
  /** Skill id that MUST NOT trigger for skill-negative tasks. */
  shouldNotUseSkillId?: string;
  /** Boundary tasks: whether the correct behavior is to ask (true) or act. */
  shouldAsk?: boolean;
  /** The synthetic memory trace available to this task. */
  memoryItems: FixtureMemoryItem[];
  /** Procedural/skill memories available for trigger-based injection. */
  skills: FixtureSkill[];
}

/**
 * Benchmark-local memory contract. Designed so it could graduate into Remnic
 * core later, but intentionally kept local for the first slice (issue non-goal:
 * do not reimplement the memory system inside the benchmark).
 */
export interface MemoryContractSlot {
  id: string;
  memoryCategories: string[];
  maxItems: number;
  required: boolean;
  excludeIfSuperseded: boolean;
  requireCitation: boolean;
}

export interface MemoryContract {
  id: string;
  description: string;
  /** Shared token budget — C1 and C2/C3 are compared under the same budget. */
  maxTotalTokens: number;
  slots: MemoryContractSlot[];
}

/** One item as assembled into a condition's pack. */
export interface MemoryPackItem {
  itemId: string;
  category: string;
  scope: string;
  status: string;
  content: string;
  /** Keywords carried through from the source item for deterministic ranking. */
  subjectKeywords: string[];
  citation: string;
  tokens: number;
  superseded: boolean;
  wrongScope: boolean;
  /**
   * Whether the agent can see status/scope/category metadata. C1 (raw
   * transcript) exposes only flat text, so the agent cannot guard on scope or
   * supersession. C2/C3 expose the typed metadata.
   */
  exposedMetadata: boolean;
}

/** The full assembled pack for one (task, condition) pair. */
export interface AssembledMemoryPack {
  condition: BoundedMemoryConditionId;
  slots: Array<{ id: string; items: MemoryPackItem[] }>;
  /** C1 only: the raw transcript text block stuffed into the prompt. */
  transcriptBlock: string | null;
  /** Boundary memory lifted to a cited, scored pack item for typed conditions. */
  boundaryItem: MemoryPackItem | null;
  totalTokens: number;
  /** Tokens the full untruncated transcript would consume. */
  fullTranscriptTokens: number;
}

/** The deterministic agent's decision for one (task, condition) pair. */
export interface AgentDecision {
  answer: string;
  askedClarification: boolean;
  acted: boolean;
  recalledItemIds: string[];
  usedSkillIds: string[];
  consideredSkillIds: string[];
  /** Wrong-scope decoy ids that leaked into the visible pack / decision. */
  wrongScopeLeakedIds: string[];
  /** Superseded item ids that leaked into the visible pack. */
  staleLeakedIds: string[];
}

/** Skill-trigger log entry recorded for C3 transparency. */
export interface SkillTriggerLogEntry {
  taskId: string;
  skillId: string;
  considered: boolean;
  injected: boolean;
  triggerReason: string;
  confidence: number;
  outcome: "helped" | "harmed" | "irrelevant";
}

/** Per-(task, condition) scored metrics. */
export interface BoundedMemoryTaskScores {
  /** Index signature so the bundle is assignable to TaskResult's Record<string, number>. */
  [key: string]: number;
  task_success: number;
  should_ask_accuracy: number;
  unnecessary_clarification_rate: number;
  action_boundary_violation_rate: number;
  relevant_memory_recall: number;
  stale_memory_harm_rate: number;
  wrong_scope_retrieval_rate: number;
  supersession_respected_rate: number;
  citation_coverage: number;
  memory_tokens_injected: number;
  retrieved_item_count: number;
  compression_ratio_vs_raw_transcript: number;
}

/** A task paired with its computed per-pair scores, for aggregation. */
export interface ScoredTaskPair {
  task: BoundedMemoryTask;
  scores: BoundedMemoryTaskScores;
}

/** The headline aggregate metric bundle, one entry per condition. */
export interface BoundedMemoryConditionAggregate {
  condition: BoundedMemoryConditionId;
  taskCount: number;
  taskSuccessRate: number;
  shouldAskAccuracy: number;
  unnecessaryClarificationRate: number;
  actionBoundaryViolationRate: number;
  relevantMemoryRecall: number;
  staleMemoryHarmRate: number;
  wrongScopeRetrievalRate: number;
  supersessionRespectedRate: number;
  citationCoverage: number;
  meanMemoryTokensInjected: number;
  meanRetrievedItemCount: number;
  meanCompressionRatio: number;
  // Skill-trigger metrics (non-zero only for C3)
  skillTriggerPrecision: number;
  skillTriggerRecall: number;
  skillFalsePositiveRate: number;
  skillFalseNegativeRate: number;
  skillHelpedCount: number;
  skillHarmedCount: number;
  skillIrrelevantCount: number;
}
