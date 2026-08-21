/**
 * MemoryArena runner — Benchmarking Agent Memory in Interdependent Multi-Session Agentic Tasks.
 *
 * 701 tasks across 5 domains, each with sequential interdependent questions.
 * The agent must store context from earlier subtasks to solve later ones.
 *
 * Domains:
 *   bundled_shopping (150)  |  progressive_search (221)  |  group_travel_planner (270)
 *   formal_reasoning_math (40)  |  formal_reasoning_phys (20)
 *
 * Published baselines: Agents perform poorly despite near-saturated performance
 * on existing long-context memory benchmarks.
 *
 * Dataset: https://huggingface.co/datasets/ZexueHe/memoryarena
 * Paper:   MemoryArena: Benchmarking Agent Memory in Interdependent Multi-Session Agentic Tasks (2025)
 */

import { readFile, readdir } from "node:fs/promises";
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

// ── Dataset types (matches data.jsonl per domain) ──

interface ArenaAnswer {
  target_asin?: string;
  attributes?: string[];
  [key: string]: unknown;
}

interface ArenaTask {
  id: number;
  questions: string[];    // Sequential subtask prompts
  answers: ArenaAnswer[]; // Expected answers (one per question)
  category: string;
}

interface DomainData {
  domain: string;
  tasks: ArenaTask[];
}

async function loadDataset(datasetDir: string, limit?: number): Promise<DomainData[]> {
  const domainFiles = (await readdir(datasetDir)).filter((f) => f.endsWith(".jsonl"));
  if (domainFiles.length === 0) {
    throw new Error(
      `MemoryArena dataset not found at ${datasetDir}. Download with:\n` +
      `  git clone --depth 1 https://huggingface.co/datasets/ZexueHe/memoryarena /tmp/memoryarena\n` +
      `  for d in /tmp/memoryarena/*/; do cp "$d/data.jsonl" "${datasetDir}/$(basename $d).jsonl"; done`,
    );
  }

  const domains: DomainData[] = [];
  for (const file of domainFiles.sort()) {
    const domain = file.replace(".jsonl", "");
    const raw = await readFile(path.join(datasetDir, file), "utf-8");
    let tasks = raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as ArenaTask);
    if (limit !== undefined) tasks = tasks.slice(0, limit);
    domains.push({ domain, tasks });
    console.log(`  [memory-arena] ${domain}: ${tasks.length} tasks`);
  }
  return domains;
}

/** Serialize an answer object into a comparable string. */
function answerToString(answer: ArenaAnswer): string {
  if (typeof answer === "string") return answer;
  const parts: string[] = [];
  if (answer.target_asin) parts.push(answer.target_asin);
  if (answer.attributes) parts.push(answer.attributes.join(", "));
  // For other answer formats, serialize relevant fields
  for (const [key, val] of Object.entries(answer)) {
    if (key !== "target_asin" && key !== "attributes" && val !== undefined) {
      parts.push(`${key}: ${typeof val === "string" ? val : JSON.stringify(val)}`);
    }
  }
  return parts.join(" | ");
}

const meta: BenchmarkMeta = {
  name: "memory-arena",
  version: "2.0.0",
  description: "Interdependent multi-session agentic memory — 701 tasks across 5 domains",
  category: "agentic",
  citation: "MemoryArena: Benchmarking Agent Memory in Interdependent Multi-Session Agentic Tasks (2025)",
};

async function run(
  system: MemorySystem,
  options: { limit?: number; datasetDir: string },
): Promise<BenchmarkResult> {
  const domains = await loadDataset(options.datasetDir, options.limit);
  const scores: TaskScore[] = [];
  const overallStart = performance.now();

  for (const { domain, tasks } of domains) {
    for (let ti = 0; ti < tasks.length; ti++) {
      const task = tasks[ti];
      await system.reset();

      const sessionId = `arena-${domain}-${task.id}`;

      // Process subtasks sequentially — each builds on the previous
      for (let qi = 0; qi < task.questions.length; qi++) {
        const question = task.questions[qi];
        const expectedAnswer = task.answers[qi];
        const expectedStr = answerToString(expectedAnswer);

        // Store the question as context (simulates the agent receiving the task)
        await system.store(sessionId, [
          { role: "user", content: question },
          { role: "assistant", content: `Processing subtask ${qi + 1}: ${question.slice(0, 100)}...` },
        ]);

        // Recall relevant context from previous subtasks
        const { result: recallText, durationMs } = await timed(async () => {
          return system.recall(sessionId, question);
        });

        const f1 = f1Score(recallText, expectedStr);
        const contains = containsAnswer(recallText, expectedStr);
        const judgeScore = await llmJudgeScore(system.judge, question, recallText, expectedStr);

        const metrics: Record<string, number> = {
          f1,
          contains_answer: contains,
        };
        if (judgeScore >= 0) metrics.llm_judge = judgeScore;

        scores.push({
          taskId: `${domain}-t${task.id}-q${qi}`,
          metrics,
          details: {
            domain,
            task_id: task.id,
            subtask_index: qi,
            category: task.category,
            question: question.slice(0, 200),
            expected: expectedStr.slice(0, 200),
            recalled_length: recallText.length,
          },
          latencyMs: durationMs,
        });

        // Store the answer as context for subsequent subtasks
        await system.store(sessionId, [
          { role: "assistant", content: `Answer for subtask ${qi + 1}: ${expectedStr}` },
        ]);
      }
    }
  }

  const durationMs = Math.round(performance.now() - overallStart);

  // Overall aggregate
  const aggregate = aggregateScores(scores.map((s) => s.metrics));

  // Per-domain aggregates
  for (const { domain } of domains) {
    const domainScores = scores.filter((s) => (s.details as any)?.domain === domain);
    if (domainScores.length > 0) {
      const domF1 = domainScores.map((s) => s.metrics.f1);
      const domContains = domainScores.map((s) => s.metrics.contains_answer);
      aggregate[`${domain}_f1`] = domF1.reduce((a, b) => a + b, 0) / domF1.length;
      aggregate[`${domain}_accuracy`] = domContains.reduce((a, b) => a + b, 0) / domContains.length;
      aggregate[`${domain}_count`] = domainScores.length;
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
      domains_run: domains.map((d) => d.domain),
    },
    durationMs,
  });
}

export const memoryArenaRunner: BenchmarkRunner = { meta, run };
