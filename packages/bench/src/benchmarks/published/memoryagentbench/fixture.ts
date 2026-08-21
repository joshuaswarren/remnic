import type { Message } from "../../../adapters/types.js";

export type MemoryAgentBenchCompetency =
  | "accurate_retrieval"
  | "test_time_learning"
  | "long_range_understanding"
  | "conflict_resolution";

export interface MemoryAgentBenchTurn {
  role: Message["role"];
  content: string;
  has_answer?: boolean;
}

export interface MemoryAgentBenchMetadata {
  source: string;
  competency: MemoryAgentBenchCompetency;
  demo?: string | null;
  haystack_sessions?: MemoryAgentBenchTurn[][] | null;
  keypoints?: string[] | null;
  previous_events?: string[] | null;
  qa_pair_ids?: string[] | null;
  question_dates?: string[] | null;
  question_ids?: string[] | null;
  question_types?: string[] | null;
}

export interface MemoryAgentBenchItem {
  context: string;
  questions: string[];
  answers: string[][];
  metadata: MemoryAgentBenchMetadata;
}

export const MEMORY_AGENT_BENCH_SMOKE_FIXTURE: MemoryAgentBenchItem[] = [
  {
    context: [
      "Event log:",
      "1. Maya boarded the blue tram to the museum.",
      "2. She bought a ticket for the modern art exhibit.",
      "3. After lunch, she walked to the riverside market.",
    ].join("\n"),
    questions: ["After Maya visited the museum, where did she go next?"],
    answers: [["the riverside market", "riverside market"]],
    metadata: {
      source: "eventqa_full",
      competency: "accurate_retrieval",
      qa_pair_ids: ["mab-smoke-ar-q1"],
      question_types: ["event_prediction"],
    },
  },
  {
    context: [
      "Example mappings:",
      "A weather complaint should be labeled label: 12.",
      "A billing problem should be labeled label: 48.",
      "A password reset request should be labeled label: 73.",
    ].join("\n"),
    questions: ["Classify this request: I need help resetting my password."],
    answers: [["label: 73", "73"]],
    metadata: {
      source: "icl_nlu_8296shot_balance",
      competency: "test_time_learning",
      qa_pair_ids: ["mab-smoke-ttl-q1"],
      question_types: ["classification"],
    },
  },
  {
    context: [
      "Case notes:",
      "Nora found mud on the balcony and a wet umbrella in the hallway.",
      "The gardener said the balcony door was locked all afternoon.",
      "A delivery rider remembered Owen arriving soaked just before the alarm.",
      "The missing ledger was later discovered in Owen's satchel.",
    ].join("\n"),
    questions: ["Who most likely took the missing ledger?"],
    answers: [["Owen"]],
    metadata: {
      source: "detective_qa",
      competency: "long_range_understanding",
      qa_pair_ids: ["mab-smoke-lru-q1"],
      question_types: ["inference"],
      keypoints: ["mud on balcony", "wet umbrella", "ledger in satchel"],
    },
  },
  {
    context: [
      "Knowledge pool:",
      "0. The current project codename is Atlas.",
      "1. The deployment region is us-east-1.",
      "2. The current project codename is Zephyr.",
    ].join("\n"),
    questions: ["What is the current project codename?"],
    answers: [["Zephyr"]],
    metadata: {
      source: "factconsolidation_sh_6k",
      competency: "conflict_resolution",
      qa_pair_ids: ["mab-smoke-cr-q1"],
      question_types: ["knowledge_conflict"],
    },
  },
];
