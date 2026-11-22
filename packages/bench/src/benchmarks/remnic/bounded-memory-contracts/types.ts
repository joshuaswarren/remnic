
export type BoundedMemoryTaskFamily =
  | "recall-needed"
  | "stale-memory-trap"
  | "wrong-scope-trap"
  | "skill-positive"
  | "skill-negative"
  | "ask-needed"
  | "act-when-enough";

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

export interface BoundedMemoryTask {
  id: string;
  family: BoundedMemoryTaskFamily;
  prompt: string;
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
  memoryItems: FixtureMemoryItem[];
  skills: FixtureSkill[];
}

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
  maxTotalTokens: number;
  slots: MemoryContractSlot[];
}

export interface MemoryPackItem {
  itemId: string;
  category: string;
  scope: string;
  status: string;
  content: string;
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

export interface SkillTriggerLogEntry {
  taskId: string;
  skillId: string;
  considered: boolean;
  injected: boolean;
  triggerReason: string;
  confidence: number;
  outcome: "helped" | "harmed" | "irrelevant";
}

export interface BoundedMemoryTaskScores {
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

export interface ScoredTaskPair {
  task: BoundedMemoryTask;
  scores: BoundedMemoryTaskScores;
}

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
  skillTriggerPrecision: number;
  skillTriggerRecall: number;
  skillFalsePositiveRate: number;
  skillFalseNegativeRate: number;
  skillHelpedCount: number;
  skillHarmedCount: number;
  skillIrrelevantCount: number;
}
