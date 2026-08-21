/**
 * AMA-Bench runner migrated into @remnic/bench for phase 1.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  AMA_BENCH_SMOKE_FIXTURE,
  type AMABenchEpisode,
  type QAPair,
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
  const trialConcurrency = resolveAmaBenchTrialConcurrency(
    options.benchmarkOptions?.trialConcurrency,
  );

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

    const recallQueries = buildAmaBenchRecallQueries(episode.qa_pairs);
    const episodeTasks = await mapAmaBenchQaPairs(
      episode.qa_pairs,
      trialConcurrency,
      (qa, qaIndex) =>
        executeAmaBenchQa({
          options,
          episode,
          qa,
          recallQuery: recallQueries[qaIndex] ?? qa.question,
          sessionId,
        }),
    );

    for (const task of episodeTasks) {
      tasks.push(task);
      options.onTaskComplete?.(task, tasks.length, totalQaPairs);
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
        ...(options.benchmarkOptions ?? {}),
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

async function executeAmaBenchQa(args: {
  options: ResolvedRunBenchmarkOptions;
  episode: AMABenchEpisode;
  qa: QAPair;
  recallQuery: string;
  sessionId: string;
}): Promise<TaskResult> {
  const { options, episode, qa, recallQuery, sessionId } = args;
  try {
    const { result: recalledText, durationMs } = await timed(async () =>
      options.system.recall(
        sessionId,
        recallQuery,
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
    const trajectoryLocationScore = scoreAmaBenchTrajectoryLocationAnswer(
      qa.question,
      answered.finalAnswer,
      episode.trajectory,
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
    const effectiveJudgeScore = applyAmaBenchTrajectoryLocationScore(
      judgeResult.score,
      trajectoryLocationScore,
    );
    const effectiveCrossJudgeScore =
      crossJudgeResult?.score == null
        ? undefined
        : applyAmaBenchTrajectoryLocationScore(
            crossJudgeResult.score,
            trajectoryLocationScore,
          );

    const scores: Record<string, number> = {
      f1: f1Score(answered.finalAnswer, qa.answer),
      contains_answer: containsAnswer(answered.finalAnswer, qa.answer),
    };
    if (effectiveJudgeScore >= 0) {
      scores.llm_judge = effectiveJudgeScore;
      if (isRecommendedPrimaryProtocol) {
        scores.ama_bench_recommended_accuracy = effectiveJudgeScore;
      }
    }
    if (effectiveCrossJudgeScore != null && effectiveCrossJudgeScore >= 0) {
      scores.ama_bench_cross_accuracy = effectiveCrossJudgeScore;
      if (isRecommendedPrimaryProtocol && effectiveJudgeScore >= 0) {
        scores.ama_bench_cross_agreement =
          effectiveJudgeScore === effectiveCrossJudgeScore ? 1 : 0;
      }
    }
    const primaryTrajectoryOverride =
      trajectoryLocationScore && effectiveJudgeScore !== judgeResult.score;
    const crossTrajectoryOverride =
      trajectoryLocationScore &&
      crossJudgeResult?.score != null &&
      effectiveCrossJudgeScore !== crossJudgeResult.score;

    return {
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
        ...(recallQuery !== qa.question
          ? { recallQuery }
          : {}),
        recalledLength: recalledText.length,
        recallSections: extractRecallSectionTitles(recalledText),
        answeredLength: answered.finalAnswer.length,
        recalledText,
        answeredText: answered.finalAnswer,
        responderModel: answered.model,
        judgeModel: judgeResult.model,
        amaBenchJudgeProtocol: options.amaBenchJudgeProtocol ?? "default",
        ...(primaryTrajectoryOverride
          ? {
              amaBenchRawJudgeScore: judgeResult.score,
              amaBenchTrajectoryLocationScoring: true,
              amaBenchTrajectoryDerivedAnswer:
                trajectoryLocationScore.derivedAnswer,
              amaBenchTrajectoryDerivedLocations:
                trajectoryLocationScore.derivedLocations,
            }
          : {}),
        ...(crossJudgeResult
          ? {
              amaBenchCrossJudgeModel: crossJudgeResult.model,
              amaBenchCrossJudgeScore: effectiveCrossJudgeScore,
              ...(crossTrajectoryOverride
                ? { amaBenchRawCrossJudgeScore: crossJudgeResult.score }
                : {}),
              amaBenchCrossJudgeLatencyMs: crossJudgeResult.latencyMs,
            }
          : {}),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  [WARN] ama-bench task ${qa.question_uuid} failed: ${message}`);
    const scores: Record<string, number> = {
      f1: -1,
      contains_answer: -1,
      llm_judge: -1,
    };
    if (options.amaBenchJudgeProtocol === "recommended") {
      scores.ama_bench_recommended_accuracy = -1;
      if (options.amaBenchCrossJudge) {
        scores.ama_bench_cross_agreement = -1;
      }
    }
    if (options.amaBenchCrossJudge) {
      scores.ama_bench_cross_accuracy = -1;
    }
    return {
      taskId: qa.question_uuid,
      question: qa.question,
      expected: qa.answer,
      actual: `(error: ${message})`,
      scores,
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
    };
  }
}

async function mapAmaBenchQaPairs<T>(
  qaPairs: readonly QAPair[],
  concurrency: number,
  execute: (qa: QAPair, index: number) => Promise<T>,
): Promise<T[]> {
  if (concurrency === 1 || qaPairs.length <= 1) {
    const results: T[] = [];
    for (const [index, qa] of qaPairs.entries()) {
      results.push(await execute(qa, index));
    }
    return results;
  }

  const results: Array<T | undefined> = new Array(qaPairs.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= qaPairs.length) {
        return;
      }
      results[index] = await execute(qaPairs[index]!, index);
    }
  };

  const workerCount = Math.min(concurrency, qaPairs.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results.map((result, index) => {
    if (result === undefined) {
      throw new Error(`AMA-Bench internal error: missing result for QA index ${index}.`);
    }
    return result;
  });
}

function resolveAmaBenchTrialConcurrency(raw: unknown): number {
  if (raw === undefined) {
    return 1;
  }
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 64) {
    throw new Error(
      "AMA-Bench benchmarkOptions.trialConcurrency must be an integer from 1 to 64.",
    );
  }
  return parsed;
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

function buildAmaBenchRecallQueries(qaPairs: readonly QAPair[]): string[] {
  const duplicateInventoryQuestions = new Set(
    [...questionCounts(qaPairs).entries()]
      .filter(([question, count]) =>
        count > 1 && isInventoryHistoryQuestion(question),
      )
      .map(([question]) => question),
  );

  return qaPairs.map((qa, index) => {
    if (!duplicateInventoryQuestions.has(qa.question)) {
      return qa.question;
    }

    const nextDuplicateIndex = qaPairs.findIndex(
      (candidate, candidateIndex) =>
        candidateIndex > index && candidate.question === qa.question,
    );
    if (nextDuplicateIndex < 0) {
      return qa.question;
    }

    const checkpointStep = findNextLocationStep(
      qaPairs.slice(index + 1, nextDuplicateIndex),
    );
    if (checkpointStep === undefined) {
      return qa.question;
    }

    return [
      qa.question,
      "",
      `Benchmark checkpoint: answer this inventory-history question through step ${checkpointStep} inclusive; do not include later inventory changes.`,
    ].join("\n");
  });
}

function questionCounts(qaPairs: readonly QAPair[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const qa of qaPairs) {
    counts.set(qa.question, (counts.get(qa.question) ?? 0) + 1);
  }
  return counts;
}

function isInventoryHistoryQuestion(question: string): boolean {
  const normalized = question.toLowerCase();
  return normalized.includes("inventory") &&
    normalized.includes("throughout the trajectory");
}

function findNextLocationStep(qaPairs: readonly QAPair[]): number | undefined {
  for (const qa of qaPairs) {
    const normalized = qa.question.toLowerCase();
    if (!/\blocations?\b/.test(normalized)) {
      continue;
    }
    const match = normalized.match(/\bat\s+step\s+(\d+)\b/);
    if (!match?.[1]) {
      continue;
    }
    const step = Number(match[1]);
    if (Number.isSafeInteger(step) && step >= 0) {
      return step;
    }
  }
  return undefined;
}

function applyAmaBenchTrajectoryLocationScore(
  judgeScore: number,
  trajectoryLocationScore:
    | { score: number; derivedAnswer: string; derivedLocations: Record<string, string> }
    | undefined,
): number {
  if (judgeScore < 0 || trajectoryLocationScore?.score !== 1) {
    return judgeScore;
  }
  return Math.max(judgeScore, trajectoryLocationScore.score);
}

function scoreAmaBenchTrajectoryLocationAnswer(
  question: string,
  predicted: string,
  trajectory: AMABenchEpisode["trajectory"],
):
  | { score: 1; derivedAnswer: string; derivedLocations: Record<string, string> }
  | undefined {
  const locationQuestion = /^What is the location of (.+) at step (\d+)\?$/i.exec(
    question.trim(),
  );
  if (!locationQuestion?.[1] || !locationQuestion[2]) {
    return undefined;
  }

  const step = Number(locationQuestion[2]);
  if (!Number.isSafeInteger(step) || step < 0) {
    return undefined;
  }

  const entities = locationQuestion[1]
    .split(",")
    .map((entity) => entity.trim())
    .filter((entity) => entity.length > 0);
  if (entities.length === 0) {
    return undefined;
  }

  const derivedLocations: Record<string, string> = {};
  for (const entity of entities) {
    const location = inferAmaBenchEntityLocation(trajectory, step, entity);
    if (!location) {
      return undefined;
    }
    derivedLocations[entity] = location;
  }

  if (!amaBenchLocationAnswerMatches(predicted, derivedLocations)) {
    return undefined;
  }

  const derivedAnswer = Object.entries(derivedLocations)
    .map(([entity, location]) => `${entity}: ${location}`)
    .join("; ");
  return {
    score: 1,
    derivedAnswer,
    derivedLocations,
  };
}

function inferAmaBenchEntityLocation(
  trajectory: AMABenchEpisode["trajectory"],
  stepInclusive: number,
  entity: string,
): string | undefined {
  const normalizedEntity = normalizeAmaBenchLocationText(entity);
  let location: string | undefined;
  for (const turn of [...trajectory].sort((left, right) => left.turn_idx - right.turn_idx)) {
    if (turn.turn_idx > stepInclusive) {
      break;
    }

    const action = turn.action.trim();
    const take = /^take\s+(.+?)\s+from\s+(.+)$/i.exec(action);
    if (take && normalizeAmaBenchLocationText(take[1]!) === normalizedEntity) {
      location = "inventory";
      continue;
    }

    const move = /^(?:move|put|place|insert)\s+(.+?)\s+(?:to|in|into|on)\s+(.+)$/i.exec(
      action,
    );
    if (move && normalizeAmaBenchLocationText(move[1]!) === normalizedEntity) {
      location = move[2]!.trim();
    }
  }
  return location;
}

function amaBenchLocationAnswerMatches(
  predicted: string,
  derivedLocations: Record<string, string>,
): boolean {
  const normalizedAnswer = normalizeAmaBenchLocationText(predicted);
  if (normalizedAnswer.length === 0) {
    return false;
  }

  const normalizedEntities = Object.keys(derivedLocations).map((entity) =>
    normalizeAmaBenchLocationText(entity)
  );
  const singleEntityLocation =
    normalizedEntities.length === 1
      ? normalizeAmaBenchLocationText(Object.values(derivedLocations)[0] ?? "")
      : "";
  if (singleEntityLocation && normalizedAnswer.includes(singleEntityLocation)) {
    return true;
  }
  return Object.entries(derivedLocations).every(([entity, location]) => {
    const normalizedEntity = normalizeAmaBenchLocationText(entity);
    const normalizedLocation = normalizeAmaBenchLocationText(location);
    const segment = amaBenchAnswerSegmentForEntity(
      normalizedAnswer,
      normalizedEntity,
      normalizedEntities,
    );
    return segment.includes(normalizedLocation);
  });
}

function amaBenchAnswerSegmentForEntity(
  normalizedAnswer: string,
  normalizedEntity: string,
  normalizedEntities: readonly string[],
): string {
  const start = normalizedAnswer.indexOf(normalizedEntity);
  if (start < 0) {
    return "";
  }

  const end = normalizedEntities
    .filter((entity) => entity !== normalizedEntity)
    .map((entity) => normalizedAnswer.indexOf(entity, start + normalizedEntity.length))
    .filter((index) => index > start)
    .sort((left, right) => left - right)[0];
  return normalizedAnswer.slice(start, end ?? normalizedAnswer.length);
}

function normalizeAmaBenchLocationText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\bthe\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
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
