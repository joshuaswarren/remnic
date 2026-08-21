/**
 * Custom benchmark schema types.
 */

import type { BenchmarkCategory } from "../../types.js";

export type CustomBenchmarkScoring =
  | "exact_match"
  | "f1"
  | "rouge_l"
  | "llm_judge";

export interface CustomBenchmarkTask {
  question: string;
  expected: string;
  tags?: string[];
}

export interface CustomBenchmarkSpec {
  name: string;
  description?: string;
  version?: string;
  category?: BenchmarkCategory;
  citation?: string;
  scoring: CustomBenchmarkScoring;
  tasks: CustomBenchmarkTask[];
}
