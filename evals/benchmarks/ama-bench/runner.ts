/**
 * AMA-Bench runner — Evaluating Long-Horizon Memory for Agentic Applications.
 *
 * 208 agent trajectories across 6 domains, 2,496 QA pairs total.
 * Each trajectory is a sequence of (action, observation) turns that must be memorized,
 * then the system is probed with questions about what happened.
 *
 * Domains: Game, EMBODIED_AI, OPENWORLD_QA, TEXT2SQL, SOFTWARE, WEB
 * QA types: recall, causal_inference, state_updating, state_abstraction
 *
 * Published baselines (Accuracy, Qwen3-32B backbone):
 *   AMA-Agent: 0.5722  |  MemoRAG: 0.4606  |  HippoRAG2: 0.4480
 *   MemoryBank: 0.3397  |  MemAgent: 0.2768
 *   GPT-5.2 (long-context): 0.7226 (strongest overall)
 *
 * Dataset: https://huggingface.co/datasets/AMA-bench/AMA-bench
 * Paper:   AMA-Bench: Evaluating Long-Horizon Memory for Agentic Applications (2025)
 * Code:    https://github.com/AMA-Bench/AMA-Hub
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

// ── Dataset types (matches open_end_qa_set.jsonl) ──

interface TrajectoryTurn {
  turn_idx: number;
  action: string;
  observation: string;
}

interface QAPair {
  question: string;
  answer: string;
  type: string; // recall, causal_inference, state_updating, state_abstraction
  question_uuid: string;
}

interface AMABenchEpisode {
  episode_id: number;
  task: string;
  task_type: string;
  domain: string;
  success: boolean;
  num_turns: number;
  total_tokens: number;
  trajectory: TrajectoryTurn[];
  qa_pairs: QAPair[];
}

async function loadDataset(datasetDir: string, limit?: number): Promise<AMABenchEpisode[]> {
  const filePath = path.join(datasetDir, "open_end_qa_set.jsonl");
  try {
    const raw = await readFile(filePath, "utf-8");
    const episodes = raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as AMABenchEpisode);
    console.log(`  Loaded ${episodes.length} episodes (${episodes.reduce((s, e) => s + e.qa_pairs.length, 0)} QA pairs)`);
    return limit !== undefined ? episodes.slice(0, limit) : episodes;
  } catch {
    throw new Error(
      `AMA-Bench dataset not found at ${filePath}. Download with:\n` +
      `  git clone --depth 1 https://huggingface.co/datasets/AMA-bench/AMA-bench /tmp/amabench && cp /tmp/amabench/test/open_end_qa_set.jsonl ${datasetDir}/`,
    );
  }
}

const meta: BenchmarkMeta = {
  name: "ama-bench",
  version: "2.0.0",
  description: "Agent Memory Abilities — 2,496 QA pairs across 208 agentic trajectories in 6 domains",
  category: "agentic",
  citation: "AMA-Bench: Evaluating Long-Horizon Memory for Agentic Applications (2025)",
};

async function run(
  system: MemorySystem,
  options: { limit?: number; datasetDir: string },
): Promise<BenchmarkResult> {
  const episodes = await loadDataset(options.datasetDir, options.limit);
  const scores: TaskScore[] = [];
  const overallStart = performance.now();

  for (let ei = 0; ei < episodes.length; ei++) {
    const ep = episodes[ei];
    await system.reset();

    if ((ei + 1) % 10 === 0 || ei === 0) {
      console.log(`  [ama-bench] Episode ${ei + 1}/${episodes.length} (${ep.domain}, ${ep.num_turns} turns, ${ep.qa_pairs.length} QA)`);
    }

    const sessionId = `ama-ep-${ep.episode_id}`;

    // Phase 1: Ingest trajectory as alternating user/assistant turns
    // action → user message, observation → assistant response
    const messages = ep.trajectory.flatMap((t) => [
      { role: "user" as const, content: `[Action ${t.turn_idx}]: ${t.action}` },
      { role: "assistant" as const, content: `[Observation ${t.turn_idx}]: ${t.observation}` },
    ]);

    // Store in batches to avoid overwhelming the buffer
    const BATCH_SIZE = 50;
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      const batch = messages.slice(i, i + BATCH_SIZE);
      await system.store(sessionId, batch);
    }

    // Phase 2: Probe with QA pairs
    for (const qa of ep.qa_pairs) {
      const { result: recallText, durationMs } = await timed(async () => {
        return system.recall(sessionId, qa.question);
      });

      const f1 = f1Score(recallText, qa.answer);
      const contains = containsAnswer(recallText, qa.answer);
      const judgeScore = await llmJudgeScore(system.judge, qa.question, recallText, qa.answer);

      const metrics: Record<string, number> = {
        f1,
        contains_answer: contains,
      };
      if (judgeScore >= 0) metrics.llm_judge = judgeScore;

      scores.push({
        taskId: qa.question_uuid,
        metrics,
        details: {
          question: qa.question,
          expected: qa.answer.slice(0, 200), // Truncate for readability in results
          qa_type: qa.type,
          domain: ep.domain,
          episode_id: ep.episode_id,
          num_turns: ep.num_turns,
          total_tokens: ep.total_tokens,
          recalled_length: recallText.length,
        },
        latencyMs: durationMs,
      });
    }
  }

  const durationMs = Math.round(performance.now() - overallStart);

  // Overall aggregate
  const aggregate = aggregateScores(scores.map((s) => s.metrics));

  // Per-domain aggregates
  const domains = [...new Set(episodes.map((e) => e.domain))];
  for (const domain of domains) {
    const domainScores = scores.filter((s) => (s.details as any)?.domain === domain);
    if (domainScores.length > 0) {
      const domF1 = domainScores.map((s) => s.metrics.f1);
      const domContains = domainScores.map((s) => s.metrics.contains_answer);
      aggregate[`${domain}_f1`] = domF1.reduce((a, b) => a + b, 0) / domF1.length;
      aggregate[`${domain}_accuracy`] = domContains.reduce((a, b) => a + b, 0) / domContains.length;
      aggregate[`${domain}_count`] = domainScores.length;
    }
  }

  // Per-QA-type aggregates
  const qaTypes = [...new Set(scores.map((s) => (s.details as any)?.qa_type).filter(Boolean))];
  for (const qt of qaTypes) {
    const qtScores = scores.filter((s) => (s.details as any)?.qa_type === qt);
    if (qtScores.length > 0) {
      const qtF1 = qtScores.map((s) => s.metrics.f1);
      aggregate[`${qt}_f1`] = qtF1.reduce((a, b) => a + b, 0) / qtF1.length;
      aggregate[`${qt}_count`] = qtScores.length;
    }
  }

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
      episodes_run: episodes.length,
    },
    durationMs,
  });
}

export const amaBenchRunner: BenchmarkRunner = { meta, run };
