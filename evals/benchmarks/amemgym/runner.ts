/**
 * AMemGym runner — Interactive Memory Benchmarking for Assistants in Long-Horizon Conversations.
 *
 * 20 user profiles, each with ~10 evolution periods and 10 evaluation questions.
 * 200 total QA pairs testing memory-driven personalization.
 *
 * Sessions contain user queries that expose latent state variables (preferences, life events).
 * QA pairs test whether the system captured state changes across periods.
 *
 * Published baselines (Memory Score, on-policy):
 *   Claude Sonnet 4:  0.336  |  GPT-4.1-mini: 0.203
 *   AWE (best agent):  0.291  |  Native LLMs: < 50% of upper bound
 *
 * Dataset: https://huggingface.co/datasets/AGI-Eval/AMemGym
 * Paper:   AMemGym: Interactive Memory Benchmarking for Assistants in Long-Horizon Conversations (2025)
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  BenchmarkRunner,
  BenchmarkResult,
  BenchmarkMeta,
  MemorySystem,
  TaskScore,
} from "../../adapter/types.js";
import { f1Score, containsAnswer, llmJudgeScore, aggregateScores, timed } from "../../scorer.js";
import { enrichResult } from "../../reporter.js";

// ── Dataset types (matches amemgym-v1-base.json) ──

interface UserProfile {
  uuid: string;
  name: string;
  age: number;
  gender: string;
  [key: string]: unknown;
}

interface AMemGymSession {
  event: string | null;
  exposed_states: Record<string, string>;
  query: string;
  messages: Array<{ role: string; content: string }>;
  session_time: string;
}

interface AMemGymPeriod {
  period_start: string;
  period_end: string;
  period_summary: string;
  sessions: AMemGymSession[];
  state: Record<string, string>;
  updates: Record<string, string>;
  update_cnts: Record<string, number>;
}

interface AnswerChoice {
  state: string[];
  answer: string;
}

interface AMemGymQA {
  query: string;
  required_info: string[];
  answer_choices: AnswerChoice[];
}

interface AMemGymProfile {
  id: string;
  start_time: string;
  user_profile: UserProfile;
  state_schema: Record<string, any>;
  periods: AMemGymPeriod[];
  qas: AMemGymQA[];
}

async function loadDataset(datasetDir: string, limit?: number): Promise<AMemGymProfile[]> {
  for (const filename of ["amemgym-v1-base.json", "amemgym-tasks.json", "data.json"]) {
    try {
      const raw = await readFile(path.join(datasetDir, filename), "utf-8");
      const data: AMemGymProfile[] = JSON.parse(raw);
      console.log(`  Loaded ${data.length} user profiles (${data.reduce((s, p) => s + p.qas.length, 0)} QA pairs)`);
      return limit !== undefined ? data.slice(0, limit) : data;
    } catch {
      continue;
    }
  }
  throw new Error(
    `AMemGym dataset not found at ${datasetDir}. Download with:\n` +
    `  git clone --depth 1 https://huggingface.co/datasets/AGI-Eval/AMemGym /tmp/amemgym && cp /tmp/amemgym/v1.base/data.json ${datasetDir}/amemgym-v1-base.json`,
  );
}

/**
 * For each QA, find the correct answer based on the final state.
 * The QA has answer_choices, each tied to specific state values.
 * We pick the one matching the user's final state.
 */
function findBestAnswer(qa: AMemGymQA, finalState: Record<string, string>): string {
  // Check each answer choice against the final state
  for (const choice of qa.answer_choices) {
    const requiredStates = choice.state;
    const matchValues = qa.required_info.map((key) => finalState[key]);
    // Check if this choice's state matches the final state
    if (requiredStates.length === matchValues.length &&
      requiredStates.every((s, i) => s === matchValues[i])) {
      return choice.answer;
    }
  }
  // Fallback: return the first answer choice
  return qa.answer_choices[0]?.answer ?? "";
}

const meta: BenchmarkMeta = {
  name: "amemgym",
  version: "2.0.0",
  description: "Interactive memory benchmarking — 200 QA pairs across 20 user profiles with state evolution",
  category: "agentic",
  citation: "AMemGym: Interactive Memory Benchmarking for Assistants in Long-Horizon Conversations (2025)",
};

async function run(
  system: MemorySystem,
  options: { limit?: number; datasetDir: string },
): Promise<BenchmarkResult> {
  const profiles = await loadDataset(options.datasetDir, options.limit);
  const scores: TaskScore[] = [];
  const overallStart = performance.now();

  for (let pi = 0; pi < profiles.length; pi++) {
    const profile = profiles[pi];
    await system.reset();

    console.log(`  [amemgym] Profile ${pi + 1}/${profiles.length} (${profile.user_profile.name}): ${profile.periods.length} periods, ${profile.qas.length} QA`);

    const sessionId = `amemgym-${profile.id}`;

    // Phase 1: Ingest all periods' sessions chronologically
    // Build up the final state across all periods
    let finalState: Record<string, string> = {};

    for (const period of profile.periods) {
      // Update final state with this period's state
      Object.assign(finalState, period.state);

      for (const session of period.sessions) {
        const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

        // If there's an event (life change), add it as context
        if (session.event) {
          messages.push({
            role: "assistant",
            content: `[Context update]: ${session.event}`,
          });
        }

        // Add the user query
        if (session.query) {
          messages.push({
            role: "user",
            content: session.query,
          });
        }

        // Add any existing messages from the session
        for (const m of session.messages) {
          messages.push({
            role: m.role as "user" | "assistant",
            content: m.content,
          });
        }

        // If no messages but we have exposed states, create a context message
        if (messages.length === 0 && Object.keys(session.exposed_states).length > 0) {
          const stateDesc = Object.entries(session.exposed_states)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ");
          messages.push({
            role: "user",
            content: `[User state]: ${stateDesc}`,
          });
        }

        if (messages.length > 0) {
          await system.store(sessionId, messages);
        }
      }
    }

    // Phase 2: Evaluate QA pairs
    for (let qi = 0; qi < profile.qas.length; qi++) {
      const qa = profile.qas[qi];
      const expectedAnswer = findBestAnswer(qa, finalState);

      const { result: recallText, durationMs } = await timed(async () => {
        return system.recall(sessionId, qa.query);
      });

      const f1 = f1Score(recallText, expectedAnswer);
      const contains = containsAnswer(recallText, expectedAnswer);
      const judgeScore = await llmJudgeScore(system.judge, qa.query, recallText, expectedAnswer);

      const metrics: Record<string, number> = {
        f1,
        contains_answer: contains,
      };
      if (judgeScore >= 0) metrics.llm_judge = judgeScore;

      scores.push({
        taskId: `${profile.id}-q${qi}`,
        metrics,
        details: {
          question: qa.query,
          expected: expectedAnswer.slice(0, 200),
          required_info: qa.required_info,
          profile_name: profile.user_profile.name,
          num_periods: profile.periods.length,
          recalled_length: recallText.length,
        },
        latencyMs: durationMs,
      });
    }
  }

  const durationMs = Math.round(performance.now() - overallStart);

  const aggregate = aggregateScores(scores.map((s) => s.metrics));

  return enrichResult({
    meta,
    engramVersion: "",
    gitSha: "",
    timestamp: "",
    adapterMode: "direct",
    taskCount: scores.length,
    scores,
    aggregate,
    config: {
      limit: options.limit,
      datasetDir: options.datasetDir,
      profiles_run: profiles.length,
    },
    durationMs,
  });
}

export const amemGymRunner: BenchmarkRunner = { meta, run };
