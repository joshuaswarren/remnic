/**
 * Shared types for the Assistant bench tier.
 *
 * Every Assistant benchmark shares the same shape:
 *   - A synthetic memory graph (facts, stances, entities) the agent may read.
 *   - A scenario prompt given to the agent.
 *   - A sealed-rubric judge pass that scores the agent's output along
 *     identity_accuracy / stance_coherence / novelty / calibration.
 *
 * The goal is reviewability: each benchmark folder ships a small fixture.ts
 * that returns `AssistantScenario` values, and the runner wires the shared
 * multi-run + bootstrap-CI infrastructure around them.
 */

import type {
  AssistantRubricDimension,
  AssistantRubricScores,
  StructuredJudge,
} from "../../../judges/sealed-rubric.js";

export interface AssistantMemoryFact {
  id: string;
  summary: string;
  /**
   * Free-form tags (topic, entity) used to render the memory-graph summary
   * that is handed to the judge. Not shown to the agent.
   */
  tags?: string[];
}

export interface AssistantStance {
  topic: string;
  position: string;
}

export interface AssistantMemoryGraph {
  userHandle: string;
  userRole: string;
  /** Fixed scenario date shown to the agent and judge for reproducible temporal reasoning. */
  currentDate?: string;
  facts: AssistantMemoryFact[];
  stances: AssistantStance[];
  openThreads: string[];
}

export interface AssistantScenario {
  id: string;
  title: string;
  scenarioPrompt: string;
  memoryGraph: AssistantMemoryGraph;
  /**
   * Small label describing what the scenario is meant to exercise. Useful in
   * dashboards for filtering. Never exposed to the agent.
   */
  focus: string;
}

/**
 * Minimal agent contract for the Assistant tier. The agent receives the
 * scenario prompt plus a pre-rendered memory view (analogous to what the
 * Remnic recall stack would hand to a downstream chat model), and returns
 * its final answer text.
 */
export interface AssistantAgent {
  respond(request: {
    scenarioId: string;
    prompt: string;
    memoryView: string;
    seed: number;
    runIndex: number;
    runCount: number;
  }): Promise<string>;
}

export interface AssistantRunnerOptions {
  agent: AssistantAgent;
  judge: StructuredJudge | undefined;
  rubricId?: string;
  /**
   * Directory where per-run spot-check JSONL files are appended. Defaults to
   * `<cwd>/benchmarks/results/spot-checks`.
   */
  spotCheckDir?: string;
  /**
   * Seed array for deterministic multi-run scheduling. When omitted the
   * benchmark runner picks a fresh seed array via `buildBenchmarkRunSeeds`.
   */
  seeds?: number[];
  /**
   * Override used by tests and CLI smoke runs to cap iterations. Must be
   * `>= 1`. The production contract is `>= 5` per the issue spec.
   */
  runCount?: number;
  /**
   * Random-number factory for bootstrap sampling. Injected in tests.
   */
  random?: () => number;
}

export type { AssistantRubricDimension, AssistantRubricScores };
