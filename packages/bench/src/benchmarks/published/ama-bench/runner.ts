/**
 * AMA-Bench runner migrated into @remnic/bench for phase 1.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  AMA_BENCH_SMOKE_FIXTURE,
  type AMABenchEpisode,
} from "./fixture.js";
import { answerBenchmarkQuestion } from "../../../answering.js";
import { DEFAULT_BENCH_RECALL_BUDGET_CHARS } from "../../../recall-budget.js";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
  TaskResult,
} from "../../../types.js";
import {
  aggregateTaskScores,
  containsAnswer,
  f1Score,
  llmJudgeScoreDetailed,
  timed,
} from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import { BENCH_RECALL_SECTION_TITLE_SET } from "../../../recall-sections.js";

export const amaBenchDefinition: BenchmarkDefinition = {
  id: "ama-bench",
  title: "AMA-Bench",
  tier: "published",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "ama-bench",
    version: "2.0.0",
    description:
      "Long-horizon agentic memory benchmark across multi-turn trajectories and QA probes.",
    category: "agentic",
    citation:
      "AMA-Bench: Evaluating Long-Horizon Memory for Agentic Applications (2025)",
  },
};

export async function runAmaBenchBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const dataset = await loadDataset(options.mode, options.datasetDir, options.limit);
  const tasks: TaskResult[] = [];
  const totalQaPairs = dataset.reduce((sum, ep) => sum + ep.qa_pairs.length, 0);

  for (const episode of dataset) {
    await options.system.reset();

    const sessionId = `ama-ep-${episode.episode_id}`;
    const messages = episode.trajectory.flatMap((turn) => [
      { role: "user" as const, content: `[Action ${turn.turn_idx}]: ${turn.action}` },
      {
        role: "assistant" as const,
        content: `[Observation ${turn.turn_idx}]: ${turn.observation}`,
      },
    ]);

    for (let index = 0; index < messages.length; index += 50) {
      await options.system.store(sessionId, messages.slice(index, index + 50));
    }

    try {
      await options.system.drain?.();
    } catch (drainErr) {
      const message = drainErr instanceof Error ? drainErr.message : String(drainErr);
      throw new Error(
        `AMA-Bench drain failed for episode ${episode.episode_id}: ${message}`,
      );
    }

    for (const qa of episode.qa_pairs) {
      try {
        const { result: recalledText, durationMs } = await timed(async () =>
          options.system.recall(
            sessionId,
            qa.question,
            DEFAULT_BENCH_RECALL_BUDGET_CHARS,
          ),
        );
        const answered = await answerBenchmarkQuestion({
          question: qa.question,
          recalledText,
          responder: options.system.responder,
          answerMode: "agentic-memory",
          questionContext: {
            benchmark: "AMA-Bench",
            domain: episode.domain,
            task: episode.task,
            taskType: episode.task_type,
            qaType: qa.type,
          },
          retryUnknownWithEvidence: true,
        });
        const judgeResult = await llmJudgeScoreDetailed(
          options.system.judge,
          qa.question,
          answered.finalAnswer,
          qa.answer,
        );
        const crossJudgeResult = options.amaBenchCrossJudge
          ? await llmJudgeScoreDetailed(
              options.amaBenchCrossJudge,
              qa.question,
              answered.finalAnswer,
              qa.answer,
            )
          : undefined;
        const crossJudgeLatencyMs = crossJudgeResult?.latencyMs ?? 0;
        const crossJudgeTokens = crossJudgeResult?.tokens ?? {
          input: 0,
          output: 0,
        };
        const isRecommendedPrimaryProtocol =
          options.amaBenchJudgeProtocol === "recommended";

        const scores: Record<string, number> = {
          f1: f1Score(answered.finalAnswer, qa.answer),
          contains_answer: containsAnswer(answered.finalAnswer, qa.answer),
        };
        if (judgeResult.score >= 0) {
          scores.llm_judge = judgeResult.score;
          if (isRecommendedPrimaryProtocol) {
            scores.ama_bench_recommended_accuracy = judgeResult.score;
          }
        }
        if (crossJudgeResult?.score != null && crossJudgeResult.score >= 0) {
          scores.ama_bench_cross_accuracy = crossJudgeResult.score;
          if (isRecommendedPrimaryProtocol && judgeResult.score >= 0) {
            scores.ama_bench_cross_agreement =
              judgeResult.score === crossJudgeResult.score ? 1 : 0;
          }
        }

        tasks.push({
          taskId: qa.question_uuid,
          question: qa.question,
          expected: qa.answer,
          actual: answered.finalAnswer,
          scores,
          latencyMs:
            durationMs +
            answered.latencyMs +
            judgeResult.latencyMs +
            crossJudgeLatencyMs,
          tokens: {
            input:
              answered.tokens.input +
              judgeResult.tokens.input +
              crossJudgeTokens.input,
            output:
              answered.tokens.output +
              judgeResult.tokens.output +
              crossJudgeTokens.output,
          },
          details: {
            qaType: qa.type,
            domain: episode.domain,
            episodeId: episode.episode_id,
            task: episode.task,
            taskType: episode.task_type,
            numTurns: episode.num_turns,
            totalTokens: episode.total_tokens,
            recalledLength: recalledText.length,
            recallSections: extractRecallSectionTitles(recalledText),
            answeredLength: answered.finalAnswer.length,
            recalledText,
            answeredText: answered.finalAnswer,
            responderModel: answered.model,
            judgeModel: judgeResult.model,
            amaBenchJudgeProtocol: options.amaBenchJudgeProtocol ?? "default",
            ...(crossJudgeResult
              ? {
                  amaBenchCrossJudgeModel: crossJudgeResult.model,
                  amaBenchCrossJudgeScore: crossJudgeResult.score,
                  amaBenchCrossJudgeLatencyMs: crossJudgeResult.latencyMs,
                }
              : {}),
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  [WARN] ama-bench task ${qa.question_uuid} failed: ${message}`);
        tasks.push({
          taskId: qa.question_uuid,
          question: qa.question,
          expected: qa.answer,
          actual: `(error: ${message})`,
          scores: { f1: -1, contains_answer: -1, llm_judge: -1 },
          latencyMs: 0,
          tokens: { input: 0, output: 0 },
          details: {
            error: message,
            qaType: qa.type,
            domain: episode.domain,
            episodeId: episode.episode_id,
            task: episode.task,
            taskType: episode.task_type,
            numTurns: episode.num_turns,
            totalTokens: episode.total_tokens,
          },
        });
      }

      options.onTaskComplete?.(tasks[tasks.length - 1], tasks.length, totalQaPairs);
    }
  }

  const remnicVersion = await getRemnicVersion();
  const totalLatencyMs = tasks.reduce((sum, task) => sum + task.latencyMs, 0);
  const totalInputTokens = tasks.reduce((sum, task) => sum + task.tokens.input, 0);
  const totalOutputTokens = tasks.reduce((sum, task) => sum + task.tokens.output, 0);

  return {
    meta: {
      id: randomUUID(),
      benchmark: options.benchmark.id,
      benchmarkTier: options.benchmark.tier,
      version: options.benchmark.meta.version,
      remnicVersion,
      gitSha: getGitSha(),
      timestamp: new Date().toISOString(),
      mode: options.mode,
      runCount: 1,
      seeds: [options.seed ?? 0],
    },
    config: {
      systemProvider: options.systemProvider ?? null,
      judgeProvider: options.judgeProvider ?? null,
      adapterMode: options.adapterMode ?? "direct",
      remnicConfig: options.remnicConfig ?? {},
      benchmarkOptions: {
        amaBenchJudgeProtocol: options.amaBenchJudgeProtocol ?? "default",
        amaBenchCrossJudgeProvider: options.amaBenchCrossJudgeProvider ?? null,
      },
    },
    cost: {
      totalTokens: totalInputTokens + totalOutputTokens,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      estimatedCostUsd: 0,
      totalLatencyMs,
      meanQueryLatencyMs:
        tasks.length > 0 ? totalLatencyMs / tasks.length : 0,
    },
    results: {
      tasks,
      aggregates: aggregateTaskScores(tasks.map((task) => task.scores)),
    },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
      hardware: process.arch,
    },
  };
}

async function loadDataset(
  mode: "full" | "quick",
  datasetDir: string | undefined,
  limit?: number,
): Promise<AMABenchEpisode[]> {
  const normalizedLimit = normalizeLimit(limit);
  const ensureDatasetEpisodes = (episodes: AMABenchEpisode[]): AMABenchEpisode[] => {
    if (episodes.length === 0) {
      throw new Error(
        "AMA-Bench dataset is empty after applying the requested limit.",
      );
    }
    return episodes;
  };

  if (datasetDir) {
    const filePath = path.join(datasetDir, "open_end_qa_set.jsonl");
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      throw new Error(
        `AMA-Bench dataset not found at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const episodes: AMABenchEpisode[] = [];
    raw.split("\n").forEach((line, lineIndex) => {
      if (line.trim().length === 0) {
        return;
      }
      episodes.push(parseEpisode(line, lineIndex + 1));
    });
    return ensureDatasetEpisodes(applyLimit(episodes, normalizedLimit));
  }

  if (mode === "full") {
    throw new Error(
      "AMA-Bench full mode requires datasetDir. Pass a dataset path or use quick mode to run the bundled smoke fixture.",
    );
  }

  return ensureDatasetEpisodes(
    applyLimit(AMA_BENCH_SMOKE_FIXTURE, normalizedLimit),
  );
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(
      `AMA-Bench limit must be a non-negative integer when provided; received ${limit}.`,
    );
  }
  return limit;
}

function applyLimit<T>(items: T[], limit: number | undefined): T[] {
  if (limit === undefined) {
    return [...items];
  }
  return items.slice(0, limit);
}

function extractRecallSectionTitles(recalledText: string): string[] {
  const titles = new Set<string>();
  for (const match of recalledText.matchAll(/^##\s+(.+)$/gm)) {
    const title = match[1]?.trim();
    if (title && BENCH_RECALL_SECTION_TITLE_SET.has(title)) {
      titles.add(title);
    }
  }
  return [...titles];
}

function parseEpisode(line: string, lineNumber: number): AMABenchEpisode {
  const location = `AMA-Bench dataset line ${lineNumber}`;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(
      `AMA-Bench dataset contains invalid JSON on line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${location} must be an object.`);
  }

  const record = parsed as Record<string, unknown>;
  if (!Number.isInteger(record.episode_id)) {
    throw new Error(`${location} must include an integer episode_id.`);
  }
  if (typeof record.task !== "string" || typeof record.task_type !== "string") {
    throw new Error(`${location} must include string task and task_type fields.`);
  }
  if (typeof record.domain !== "string") {
    throw new Error(`${location} must include a string domain.`);
  }
  if (typeof record.success !== "boolean") {
    throw new Error(`${location} must include a boolean success flag.`);
  }
  if (!Number.isFinite(record.num_turns) || !Number.isFinite(record.total_tokens)) {
    throw new Error(`${location} must include numeric num_turns and total_tokens fields.`);
  }
  if (!isValidQaPairs(record.qa_pairs)) {
    throw new Error(`${location} must include a qa_pairs array with question/answer/type/question_uuid strings.`);
  }

  const trajectory = normalizeTrajectory(record.trajectory, location);

  return {
    episode_id: record.episode_id as number,
    task: record.task as string,
    task_type: record.task_type as string,
    domain: record.domain as string,
    success: record.success as boolean,
    num_turns: record.num_turns as number,
    total_tokens: record.total_tokens as number,
    trajectory,
    qa_pairs: record.qa_pairs as AMABenchEpisode["qa_pairs"],
  };
}

function normalizeTrajectory(
  value: unknown,
  location: string,
): AMABenchEpisode["trajectory"] {
  if (!Array.isArray(value)) {
    throw new Error(`${location} must include a trajectory array with action/observation turns.`);
  }

  return value.map((turn, index) => {
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) {
      throw new Error(`${location} trajectory[${index}] must be an object.`);
    }

    const record = turn as Record<string, unknown>;
    if (!Number.isInteger(record.turn_idx)) {
      throw new Error(`${location} trajectory[${index}] must include an integer turn_idx.`);
    }
    if (!("action" in record) || !("observation" in record)) {
      throw new Error(
        `${location} must include a trajectory array with action/observation turns.`,
      );
    }

    return {
      turn_idx: record.turn_idx as number,
      action: normalizeTrajectoryText(record.action, `${location} trajectory[${index}].action`),
      observation: normalizeTrajectoryText(
        record.observation,
        `${location} trajectory[${index}].observation`,
      ),
    };
  });
}

function normalizeTrajectoryText(value: unknown, field: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "";
  }
  throw new Error(`${field} must be a string or null.`);
}

function isValidQaPairs(value: unknown): value is AMABenchEpisode["qa_pairs"] {
  return Array.isArray(value)
    && value.every(
      (qa) =>
        !!qa
        && typeof qa === "object"
        && !Array.isArray(qa)
        && typeof (qa as Record<string, unknown>).question === "string"
        && typeof (qa as Record<string, unknown>).answer === "string"
        && typeof (qa as Record<string, unknown>).type === "string"
        && typeof (qa as Record<string, unknown>).question_uuid === "string",
    );
}
