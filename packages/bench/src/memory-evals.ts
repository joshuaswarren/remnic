export const MEMORY_EVAL_PUBLIC_LINE =
  "Agent memory without evals is vibes with a database." as const;

export type MemoryEvalDimensionId =
  | "repeated_context_reduction"
  | "unnecessary_clarification_reduction"
  | "retrieval_correctness"
  | "stale_memory_harm"
  | "scope_respect"
  | "ask_when_needed"
  | "act_when_enough_context"
  | "personalization_quality";

export type MemoryEvalCategory =
  | "context-efficiency"
  | "retrieval-quality"
  | "boundary-respect"
  | "action-confidence"
  | "personalization";

export interface MemoryEvalMetric {
  name: string;
  higherIsBetter: boolean;
  description: string;
}

export interface MemoryEvalDimension {
  id: MemoryEvalDimensionId;
  question: string;
  category: MemoryEvalCategory;
  metrics: readonly MemoryEvalMetric[];
  quickBenchmarkIds: readonly string[];
  fullModeGuidance: string;
}

export const MEMORY_EVAL_DIMENSIONS: readonly MemoryEvalDimension[] = [
  {
    id: "repeated_context_reduction",
    question: "Did memory reduce repeated context?",
    category: "context-efficiency",
    metrics: [
      {
        name: "repeated_context_turns_saved",
        higherIsBetter: true,
        description:
          "Estimated number of user turns avoided because the agent reused durable context.",
      },
      {
        name: "context_repetition_rate",
        higherIsBetter: false,
        description:
          "Share of task turns where the user had to restate information Remnic should already know.",
      },
    ],
    quickBenchmarkIds: [
      "assistant-synthesis",
      "assistant-morning-brief",
      "longmemeval",
    ],
    fullModeGuidance:
      "Run seeded assistant tasks against a baseline with memory disabled and compare repeated setup turns.",
  },
  {
    id: "unnecessary_clarification_reduction",
    question: "Did memory reduce unnecessary clarification?",
    category: "context-efficiency",
    metrics: [
      {
        name: "low_value_clarification_rate",
        higherIsBetter: false,
        description:
          "Share of clarifying questions whose answer was already present in safe retrieved memory.",
      },
      {
        name: "clarification_precision",
        higherIsBetter: true,
        description:
          "Share of clarifying questions that were justified by missing, conflicting, stale, or risky context.",
      },
    ],
    quickBenchmarkIds: [
      "assistant-next-best-action",
      "buffer-surprise-trigger",
    ],
    fullModeGuidance:
      "Judge ask/draft/act choices over real trajectories where the user previously supplied the needed context.",
  },
  {
    id: "retrieval_correctness",
    question: "Did the agent retrieve the right memory?",
    category: "retrieval-quality",
    metrics: [
      {
        name: "memory_recall_at_k",
        higherIsBetter: true,
        description:
          "Recall of labeled relevant memory ids in the top-k retrieved context.",
      },
      {
        name: "memory_precision_at_k",
        higherIsBetter: true,
        description:
          "Precision of labeled relevant memory ids in the top-k retrieved context.",
      },
    ],
    quickBenchmarkIds: [
      "retrieval-personalization",
      "retrieval-direct-answer",
      "coding-recall",
    ],
    fullModeGuidance:
      "Use sealed qrels for real user-aware tasks and report retrieval precision/recall by scope.",
  },
  {
    id: "stale_memory_harm",
    question: "Did stale memory harm the answer?",
    category: "retrieval-quality",
    metrics: [
      {
        name: "stale_memory_harm_rate",
        higherIsBetter: false,
        description:
          "Share of tasks where stale, superseded, or corrected memory changed the output for the worse.",
      },
      {
        name: "freshness_filter_success",
        higherIsBetter: true,
        description:
          "Share of tasks where stale memory was withheld, downgraded, or surfaced with the right caveat.",
      },
    ],
    quickBenchmarkIds: [
      "retrieval-temporal",
      "retention-aged-dataset",
      "contradiction-detection",
    ],
    fullModeGuidance:
      "Include correction and supersession fixtures with known stale distractors and outcome labels.",
  },
  {
    id: "scope_respect",
    question: "Did the agent respect scope?",
    category: "boundary-respect",
    metrics: [
      {
        name: "scope_violation_rate",
        higherIsBetter: false,
        description:
          "Share of tasks where private, temporary, client, repo, or do-not-use-outside memory crossed its boundary.",
      },
      {
        name: "allowed_scope_recall",
        higherIsBetter: true,
        description:
          "Recall of relevant memories that were safe to use in the current scope.",
      },
    ],
    quickBenchmarkIds: [
      "coding-recall",
      "retrieval-personalization",
      "memoryagentbench",
    ],
    fullModeGuidance:
      "Run multi-namespace cases with explicit private and do-not-use-outside distractors.",
  },
  {
    id: "ask_when_needed",
    question: "Did the agent ask when it should have asked?",
    category: "action-confidence",
    metrics: [
      {
        name: "required_ask_recall",
        higherIsBetter: true,
        description:
          "Recall of cases where the correct action was to ask before proceeding.",
      },
      {
        name: "unsafe_action_rate",
        higherIsBetter: false,
        description:
          "Share of risky cases where the agent acted despite missing context, stale memory, or user ask-before rules.",
      },
    ],
    quickBenchmarkIds: [
      "assistant-next-best-action",
      "buffer-surprise-trigger",
    ],
    fullModeGuidance:
      "Evaluate action-confidence traces against labeled ask-before, uncertainty, and risk-threshold cases.",
  },
  {
    id: "act_when_enough_context",
    question: "Did the agent act when it had enough context?",
    category: "action-confidence",
    metrics: [
      {
        name: "unnecessary_interruption_rate",
        higherIsBetter: false,
        description:
          "Share of low-risk, sufficient-context cases where the agent spent the user's attention anyway.",
      },
      {
        name: "sufficient_context_action_rate",
        higherIsBetter: true,
        description:
          "Share of cases where the agent proceeded appropriately because memory gave it enough safe context.",
      },
    ],
    quickBenchmarkIds: [
      "assistant-next-best-action",
      "assistant-morning-brief",
    ],
    fullModeGuidance:
      "Compare memory-enabled and memory-disabled runs on low-risk tasks with complete scoped context.",
  },
  {
    id: "personalization_quality",
    question: "Did personalization improve the output?",
    category: "personalization",
    metrics: [
      {
        name: "personalization_lift",
        higherIsBetter: true,
        description:
          "Quality delta between generic output and user-aware output under the same task.",
      },
      {
        name: "preference_alignment",
        higherIsBetter: true,
        description:
          "Share of outputs that honor the user's preferences, constraints, risk tolerance, and definition of good.",
      },
    ],
    quickBenchmarkIds: [
      "retrieval-personalization",
      "assistant-synthesis",
      "personamem",
    ],
    fullModeGuidance:
      "Use paired generic-vs-user-aware judge prompts with provenance and scope annotations preserved.",
  },
] as const;

export function listMemoryEvalDimensions(): readonly MemoryEvalDimension[] {
  return MEMORY_EVAL_DIMENSIONS;
}

export function getMemoryEvalDimension(
  id: MemoryEvalDimensionId,
): MemoryEvalDimension {
  const dimension = MEMORY_EVAL_DIMENSIONS.find((candidate) => candidate.id === id);
  if (!dimension) {
    throw new Error(`Unknown memory eval dimension: ${id}`);
  }
  return dimension;
}

export function listMemoryEvalBenchmarkIds(): string[] {
  return Array.from(
    new Set(
      MEMORY_EVAL_DIMENSIONS.flatMap((dimension) => dimension.quickBenchmarkIds),
    ),
  ).sort();
}
