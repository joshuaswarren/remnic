/**
 * MemoryAgentBench runner migrated into @remnic/bench for phase 1.
 */

import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { Message } from "../../../adapters/types.js";
import { answerBenchmarkQuestion } from "../../../answering.js";
import { benchmarkRecallBudgetForSessionCount } from "../../../recall-budget.js";
import {
  MEMORY_AGENT_BENCH_SMOKE_FIXTURE,
  type MemoryAgentBenchCompetency,
  type MemoryAgentBenchItem,
  type MemoryAgentBenchMetadata,
  type MemoryAgentBenchTurn,
} from "./fixture.js";
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
  recallAtK,
  rougeL,
  timed,
} from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";

const DATASET_SPLITS = [
  {
    split: "Accurate_Retrieval",
    competency: "accurate_retrieval" as const,
    sourcePrefix: "eventqa",
    candidates: [
      "Accurate_Retrieval.json",
      "Accurate_Retrieval.jsonl",
      "accurate_retrieval.json",
      "accurate_retrieval.jsonl",
    ],
  },
  {
    split: "Test_Time_Learning",
    competency: "test_time_learning" as const,
    sourcePrefix: "icl_",
    candidates: [
      "Test_Time_Learning.json",
      "Test_Time_Learning.jsonl",
      "test_time_learning.json",
      "test_time_learning.jsonl",
    ],
  },
  {
    split: "Long_Range_Understanding",
    competency: "long_range_understanding" as const,
    sourcePrefix: "detective_",
    candidates: [
      "Long_Range_Understanding.json",
      "Long_Range_Understanding.jsonl",
      "long_range_understanding.json",
      "long_range_understanding.jsonl",
    ],
  },
  {
    split: "Conflict_Resolution",
    competency: "conflict_resolution" as const,
    sourcePrefix: "factconsolidation",
    candidates: [
      "Conflict_Resolution.json",
      "Conflict_Resolution.jsonl",
      "conflict_resolution.json",
      "conflict_resolution.jsonl",
    ],
  },
] as const;

const DATASET_BUNDLE_CANDIDATES = [
  "memoryagentbench.json",
  "memoryagentbench.jsonl",
  "MemoryAgentBench.json",
  "MemoryAgentBench.jsonl",
] as const;

const VISIBLE_CUE_ANCHOR_PREFIX = "MemoryAgentBench visible anchors:";
const RECOMMENDATION_CUE_PATTERN =
  /\b(?:recommend(?:ed|s|ing|ation|ations)?|recommender|suggest(?:ed|s|ing|ion|ions)?)\b/i;
const RECOMMENDATION_CUE_GLOBAL_PATTERN =
  /\b(?:recommend(?:ed|s|ing|ation|ations)?|recommender|suggest(?:ed|s|ing|ion|ions)?)\b/gi;

type MemoryAgentBenchProtocol =
  | "ruler_qa"
  | "longmemeval"
  | "eventqa"
  | "in_context_learning"
  | "recsys_redial"
  | "infbench_sum"
  | "detective_qa"
  | "factconsolidation";

interface RecSysEntityMapping {
  idToName: Map<number, string>;
  movieCandidates: string[];
  aliasCounts: Map<string, number>;
  sourcePath: string;
}

export const memoryAgentBenchDefinition: BenchmarkDefinition = {
  id: "memoryagentbench",
  title: "MemoryAgentBench",
  tier: "published",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "memoryagentbench",
    version: "2.0.0",
    description:
      "Incremental multi-turn memory benchmark spanning accurate retrieval, test-time learning, long-range understanding, and conflict resolution.",
    category: "agentic",
    citation:
      "Hu et al. Evaluating Memory in LLM Agents via Incremental Multi-Turn Interactions. ICLR 2026.",
  },
};

export async function runMemoryAgentBenchBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const rawDataset = await loadDataset(options.mode, options.datasetDir, options.limit);
  const trialLimit = resolveTrialLimit(options.benchmarkOptions?.trialLimit);
  const benchmarkOptions =
    trialLimit === undefined
      ? options.benchmarkOptions
      : { ...(options.benchmarkOptions ?? {}), trialLimit };
  const dataset = applyTrialLimit(rawDataset, trialLimit);
  const validateRecsysMappingBeforeExecution =
    options.adapterMode === "dry-run" && hasRecSysRedialItems(dataset);
  let recsysMapping: RecSysEntityMapping | null = validateRecsysMappingBeforeExecution
    ? await requireRecSysEntityMapping(options.datasetDir)
    : null;
  let recsysMappingLoaded = recsysMapping !== null;
  const tasks: TaskResult[] = [];

  const totalQuestions = dataset.reduce(
    (sum, item) => sum + item.questions.length,
    0,
  );

  for (const [itemIndex, item] of dataset.entries()) {
    await options.system.reset();

    const sessionIds = await storeBenchmarkContext(options, item, itemIndex);
    try {
      await options.system.drain?.();
    } catch (drainErr) {
      const drainMessage = drainErr instanceof Error ? drainErr.message : String(drainErr);
      console.error(`  [WARN] memoryagentbench drain failed for sample ${item.metadata.source}: ${drainMessage}`);
      for (let questionIndex = 0; questionIndex < item.questions.length; questionIndex += 1) {
        const question = item.questions[questionIndex]!;
        const answerVariants = item.answers[questionIndex];
        if (answerVariants === undefined || answerVariants.length === 0) {
          throw new Error(
            `MemoryAgentBench sample ${item.metadata.source} is missing answers for question index ${questionIndex}.`,
          );
        }
        const taskResultId =
          item.metadata.qa_pair_ids?.[questionIndex] ??
          `${item.metadata.source}-q${questionIndex}`;
        const protocol = getProtocolForSource(item.metadata.source);
        const message = `memoryagentbench drain failed before scoring: ${drainMessage}`;
        tasks.push({
          taskId: taskResultId,
          question,
          expected: answerVariants[0]!,
          actual: `(error: ${message})`,
          scores: errorScoresForProtocol(protocol),
          latencyMs: 0,
          tokens: { input: 0, output: 0 },
          details: {
            error: message,
            drainFailed: true,
            competency: item.metadata.competency,
            source: item.metadata.source,
            sessionIds,
            storedSessionCount: sessionIds.length,
          },
        });
        options.onTaskComplete?.(tasks[tasks.length - 1]!, tasks.length, totalQuestions);
      }
      continue;
    }
    for (let questionIndex = 0; questionIndex < item.questions.length; questionIndex += 1) {
      const question = item.questions[questionIndex]!;
      const answerVariants = item.answers[questionIndex];
      if (answerVariants === undefined || answerVariants.length === 0) {
        throw new Error(
          `MemoryAgentBench sample ${item.metadata.source} is missing answers for question index ${questionIndex}.`,
        );
      }

      const taskResultId =
        item.metadata.qa_pair_ids?.[questionIndex] ??
        `${item.metadata.source}-q${questionIndex}`;
      let protocol: MemoryAgentBenchProtocol | undefined;

      try {
        protocol = getProtocolForSource(item.metadata.source);
        const officialQuestion = buildOfficialQuery(protocol, question);
        const { result: recalledText, durationMs } = await timed(async () => {
          const recallBudget = benchmarkRecallBudgetForSessionCount(
            sessionIds.length,
          );
          const recalledSessions = await Promise.all(
            sessionIds.map((sessionId) =>
              options.system.recall(sessionId, question, recallBudget),
            ),
          );
          return recalledSessions.filter(Boolean).join("\n\n");
        });
        const answerRecalledText = stripVisibleCueAnchors(recalledText);
        if (protocol === "recsys_redial" && !recsysMappingLoaded) {
          recsysMapping = await loadRecSysEntityMapping(options.datasetDir);
          recsysMappingLoaded = true;
        }
        const answered = await answerBenchmarkQuestion({
          question: officialQuestion,
          recalledText: answerRecalledText,
          responder: options.system.responder,
          answerMode: "strict",
        });
        const refinedAnswer = refineMemoryAgentBenchAnswerFromRecall({
          protocol,
          question,
          recalledText: answerRecalledText,
          answeredText: answered.finalAnswer,
          recsysMapping: protocol === "recsys_redial" ? recsysMapping : null,
        });
        const finalAnswer = refinedAnswer ?? answered.finalAnswer;
        const officialScoring = scoreOfficialProtocol({
          protocol,
          actual: finalAnswer,
          answerVariants,
          recsysMapping: protocol === "recsys_redial" ? recsysMapping : null,
        });
        const answerForScoring = officialScoring.parsedAnswer ?? finalAnswer;
        const bestExpectedAnswer = selectBestMatchingAnswer(
          answerForScoring,
          answerVariants,
        );
        const judgeResult = await llmJudgeScoreDetailed(
          options.system.judge,
          question,
          answerForScoring,
          bestExpectedAnswer,
        );

        const scores: Record<string, number> = {
          f1: scoreAgainstVariants(
            answerForScoring,
            answerVariants,
            f1Score,
          ),
          contains_answer: answerVariants.some((variant) =>
            containsAnswer(answerForScoring, variant),
          )
            ? 1
            : 0,
          rouge_l: scoreAgainstVariants(
            answerForScoring,
            answerVariants,
            rougeL,
          ),
          ...officialScoring.scores,
        };
        if (judgeResult.score >= 0) {
          scores.llm_judge = judgeResult.score;
        }

        const details: Record<string, unknown> = {
          competency: item.metadata.competency,
          source: item.metadata.source,
          questionType: item.metadata.question_types?.[questionIndex],
          questionId: item.metadata.question_ids?.[questionIndex],
          questionDate: item.metadata.question_dates?.[questionIndex],
          previousEvent: item.metadata.previous_events?.[questionIndex],
          keypoints: item.metadata.keypoints ?? [],
          officialProtocol: protocol,
          officialQuestion,
          answerVariants,
          bestExpectedAnswer,
          parsedOfficialAnswer: officialScoring.parsedAnswer,
          sessionIds,
          storedSessionCount: sessionIds.length,
          recalledLength: answerRecalledText.length,
          answeredLength: finalAnswer.length,
          recalledText: answerRecalledText,
          answeredText: finalAnswer,
          ...(refinedAnswer
            ? {
                originalAnsweredText: answered.finalAnswer,
                answerRefinementReason:
                  "benchmark recalled-evidence refinement",
              }
            : {}),
          responderModel: answered.model,
          judgeModel: judgeResult.model,
        };
        if (protocol === "recsys_redial") {
          details.recsysScoringReady = officialScoring.recsysScoringReady;
          details.recsysEntityMappingPath = recsysMapping?.sourcePath;
          details.recsysGroundTruthMovies = officialScoring.groundTruthMovies;
          details.recsysPredictedMovies = officialScoring.predictedMovies;
        }

        tasks.push({
          taskId: taskResultId,
          question,
          expected: answerVariants[0]!,
          actual: finalAnswer,
          scores,
          latencyMs: durationMs + answered.latencyMs + judgeResult.latencyMs,
          tokens: {
            input: answered.tokens.input + judgeResult.tokens.input,
            output: answered.tokens.output + judgeResult.tokens.output,
          },
          details,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  [WARN] memoryagentbench task ${taskResultId} failed: ${message}`);
        tasks.push({
          taskId: taskResultId,
          question,
          expected: answerVariants[0]!,
          actual: `(error: ${message})`,
          scores: errorScoresForProtocol(protocol),
          latencyMs: 0,
          tokens: { input: 0, output: 0 },
          details: { error: message },
        });
      }

      options.onTaskComplete?.(tasks[tasks.length - 1]!, tasks.length, totalQuestions);
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
      ...(benchmarkOptions ? { benchmarkOptions } : {}),
    },
    cost: {
      totalTokens: totalInputTokens + totalOutputTokens,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      estimatedCostUsd: 0,
      totalLatencyMs,
      meanQueryLatencyMs: tasks.length > 0 ? totalLatencyMs / tasks.length : 0,
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

function resolveTrialLimit(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      "MemoryAgentBench benchmarkOptions.trialLimit must be a non-negative integer.",
    );
  }
  return parsed;
}

function applyTrialLimit(
  dataset: MemoryAgentBenchItem[],
  trialLimit: number | undefined,
): MemoryAgentBenchItem[] {
  if (trialLimit === undefined) {
    return dataset;
  }
  if (trialLimit === 0) {
    return [];
  }

  const limited: MemoryAgentBenchItem[] = [];
  let remaining = trialLimit;
  for (const item of dataset) {
    if (remaining <= 0) {
      break;
    }
    const questionCount = Math.min(item.questions.length, remaining);
    if (questionCount > 0) {
      limited.push({
        ...item,
        questions: item.questions.slice(0, questionCount),
        answers: item.answers.slice(0, questionCount),
        metadata: truncateQuestionMetadata(item.metadata, questionCount),
      });
      remaining -= questionCount;
    }
  }
  return limited;
}

function truncateQuestionMetadata(
  metadata: MemoryAgentBenchMetadata,
  questionCount: number,
): MemoryAgentBenchMetadata {
  return {
    ...metadata,
    previous_events: sliceOptional(metadata.previous_events, questionCount),
    qa_pair_ids: sliceOptional(metadata.qa_pair_ids, questionCount),
    question_dates: sliceOptional(metadata.question_dates, questionCount),
    question_ids: sliceOptional(metadata.question_ids, questionCount),
    question_types: sliceOptional(metadata.question_types, questionCount),
  };
}

function sliceOptional<T>(
  values: T[] | null | undefined,
  count: number,
): T[] | null | undefined {
  return Array.isArray(values) ? values.slice(0, count) : values;
}

function errorScoresForProtocol(
  protocol: MemoryAgentBenchProtocol | undefined,
): Record<string, number> {
  const scores: Record<string, number> = {
    f1: -1,
    contains_answer: -1,
    rouge_l: -1,
    llm_judge: -1,
    official_protocol_ready: 0,
  };
  if (protocol !== "recsys_redial") {
    scores.official_exact_match = -1;
    scores.official_f1 = -1;
    scores.official_substring_exact_match = -1;
    scores.official_rouge_l = -1;
  }
  if (protocol === "eventqa") {
    scores.eventqa_recall = -1;
  }
  if (protocol === "recsys_redial") {
    scores.recsys_recall_at_1 = -1;
    scores.recsys_recall_at_5 = -1;
    scores.recsys_recall_at_10 = -1;
  }
  return scores;
}

function hasRecSysRedialItems(dataset: MemoryAgentBenchItem[]): boolean {
  return dataset.some((item) =>
    item.metadata.source.toLowerCase().startsWith("recsys_"),
  );
}

function getProtocolForSource(source: string): MemoryAgentBenchProtocol {
  const normalized = source.toLowerCase();
  if (normalized.startsWith("ruler_")) {
    return "ruler_qa";
  }
  if (normalized.startsWith("longmemeval")) {
    return "longmemeval";
  }
  if (normalized.startsWith("eventqa")) {
    return "eventqa";
  }
  if (normalized.startsWith("icl_")) {
    return "in_context_learning";
  }
  if (normalized.startsWith("recsys_")) {
    return "recsys_redial";
  }
  if (normalized.startsWith("infbench_")) {
    return "infbench_sum";
  }
  if (normalized.startsWith("detective_")) {
    return "detective_qa";
  }
  if (normalized.startsWith("factconsolidation")) {
    return "factconsolidation";
  }
  throw new Error(
    `MemoryAgentBench metadata.source "${source}" does not map to a supported official protocol.`,
  );
}

function buildOfficialQuery(
  protocol: MemoryAgentBenchProtocol,
  question: string,
): string {
  switch (protocol) {
    case "ruler_qa":
      return [
        "Answer the question based on the memorized documents. Only give me the answer and do not output any other words.",
        "",
        `Question: ${question}`,
        "",
        "Answer:",
      ].join("\n");
    case "longmemeval":
      return [
        "The history chats are between you and a user. Based on the relevant chat history, answer the question as concisely as you can, using a single phrase if possible.",
        "",
        question,
        "",
        "Answer:",
      ].join("\n");
    case "eventqa":
      return [
        "Based on the context you memorized, complete the task below:",
        "",
        question,
        "",
        "The event that happens next is:",
      ].join("\n");
    case "in_context_learning":
      return [
        "Use the provided mapping from the context to numerical label to assign a numerical label to the context.",
        'Only output "label: {label}" and nothing else.',
        "",
        question,
        "",
        "label:",
      ].join("\n");
    case "recsys_redial":
      return [
        "Pretend you are a movie recommender system. You need to recommend movies based on the dialogues you have memorized.",
        "Now I will give you a new conversation between a user and you, a recommender system.",
        "Based on the conversation, reply with 20 movie recommendations without extra sentences.",
        "",
        "For Example:",
        "",
        "[Conversation]",
        "",
        "The recommendations are:",
        "1. movie1",
        "2. movie2",
        "...",
        "",
        `Here is the conversation: ${question}`,
        "",
        "The recommendations are:",
      ].join("\n");
    case "infbench_sum":
      return [
        "You are given a book above and you are tasked to summarize it.",
        "",
        question,
        "",
        "Now summarize the book.",
      ].join("\n");
    case "detective_qa":
      return [
        "Based on the context you memorized, answer the question below. You are required to answer the question based on the strict output format.",
        "",
        question,
      ].join("\n");
    case "factconsolidation":
      return [
        "Pretend you are a knowledge management system. Each fact in the knowledge pool is provided with a serial number at the beginning, and the newer fact has larger serial number.",
        "You need to solve conflicts in the knowledge pool by finding the newest fact with the larger serial number.",
        "Answer only from the knowledge pool you memorized, not from real-world facts. Give a very concise answer without other words.",
        "",
        "For example:",
        "",
        "[Knowledge Pool]",
        "",
        "Question: Based on the provided Knowledge Pool, what is the name of the current president of Russia?",
        "Answer: Donald Trump",
        "",
        `Now Answer the Question: Based on the provided Knowledge Pool, ${question}`,
        "Answer:",
      ].join("\n");
  }
}

function refineMemoryAgentBenchAnswerFromRecall(args: {
  protocol: MemoryAgentBenchProtocol;
  question: string;
  recalledText: string;
  answeredText: string;
  recsysMapping?: RecSysEntityMapping | null;
}): string | undefined {
  if (args.protocol === "recsys_redial" && args.recsysMapping) {
    return refineRecSysRecommendationsFromRecall(
      args.answeredText,
      args.recalledText,
      args.recsysMapping,
    );
  }

  if (args.protocol !== "eventqa" || !/\bwhere\b/i.test(args.question)) {
    return undefined;
  }

  const answerLocation = extractEventQaDestination(args.answeredText);
  for (const line of rankedMemoryAgentBenchLines(args.question, args.recalledText)) {
    const destination = extractEventQaDestination(line);
    if (!destination) {
      continue;
    }
    if (
      !answerLocation ||
      normalizeOfficialAnswer(answerLocation).includes(
        normalizeOfficialAnswer(destination),
      ) ||
      normalizeOfficialAnswer(destination).includes(
        normalizeOfficialAnswer(answerLocation),
      )
    ) {
      return destination;
    }
  }

  return undefined;
}

function refineRecSysRecommendationsFromRecall(
  answeredText: string,
  recalledText: string,
  recsysMapping: RecSysEntityMapping,
): string | undefined {
  const recalledMovies = extractRecalledRecommendationMovies(
    recalledText,
    recsysMapping.movieCandidates,
    recsysMapping.aliasCounts,
  );
  if (recalledMovies.length === 0) {
    return undefined;
  }

  const answeredMovies = extractRecommendationMovies(
    answeredText,
    recsysMapping.movieCandidates,
    recsysMapping.aliasCounts,
  );
  const answeredTop = answeredMovies[0];
  const recallSupportsAnsweredTop =
    answeredTop !== undefined &&
    recalledMovies.some((movie) => sameOfficialAnswer(movie, answeredTop));
  const rankedMovies = uniquePreservingOrder(
    recallSupportsAnsweredTop
      ? [...answeredMovies, ...recalledMovies]
      : [...recalledMovies, ...answeredMovies],
  ).slice(0, 20);
  if (
    rankedMovies.length === answeredMovies.length &&
    rankedMovies.every((movie, index) => movie === answeredMovies[index])
  ) {
    return undefined;
  }

  return rankedMovies
    .map((movie, index) => `${index + 1}. ${movie}`)
    .join("\n");
}

function extractRecalledRecommendationMovies(
  recalledText: string,
  movieCandidates: string[],
  aliasCounts: Map<string, number>,
): string[] {
  const spans: string[] = [];
  let inRecommendationList = false;

  for (const line of recalledText
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")) {
    const span = recalledRecommendationSpan(line, inRecommendationList);
    if (span !== undefined) {
      spans.push(span);
    }

    const trimmed = line.trim();
    if (trimmed.length === 0) {
      inRecommendationList = false;
    } else if (isRecommendationHeader(trimmed)) {
      inRecommendationList = true;
    } else if (!/^\d+[\.)]\s+/.test(trimmed)) {
      inRecommendationList = false;
    }
  }

  return spans.flatMap((line) =>
    extractRecommendationMoviesFromLine(line, movieCandidates, aliasCounts),
  );
}

function recalledRecommendationSpan(
  line: string,
  inRecommendationList = false,
): string | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (/^\d+[\.)]\s+/.test(trimmed)) {
    const unnumbered = trimmed.replace(/^\d+[\.)]\s+/, "");
    return inRecommendationList ? unnumbered : recommendationCueSpan(unnumbered);
  }

  return recommendationCueSpan(trimmed);
}

function recommendationCueSpan(line: string): string | undefined {
  const cues = [...line.matchAll(RECOMMENDATION_CUE_GLOBAL_PATTERN)];
  const lastCue = cues.at(-1);
  if (lastCue?.index === undefined) {
    return undefined;
  }
  return line.slice(lastCue.index);
}

function isRecommendationHeader(line: string): boolean {
  return RECOMMENDATION_CUE_PATTERN.test(line) && /:\s*$/.test(line);
}

function uniquePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const key = normalizeOfficialAnswer(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(value);
  }
  return unique;
}

function sameOfficialAnswer(left: string, right: string): boolean {
  return normalizeOfficialAnswer(left) === normalizeOfficialAnswer(right);
}

function rankedMemoryAgentBenchLines(
  question: string,
  recalledText: string,
): string[] {
  const questionTokens = new Set(
    question.toLowerCase().match(/[a-z0-9]+/g) ?? [],
  );
  return recalledText
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => ({
      line,
      index,
      score: scoreMemoryAgentBenchLine(line, questionTokens),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score === left.score
        ? left.index - right.index
        : right.score - left.score,
    )
    .map((entry) => entry.line);
}

function scoreMemoryAgentBenchLine(
  line: string,
  questionTokens: Set<string>,
): number {
  const lineTokens = new Set(line.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  let score = 0;
  for (const token of questionTokens) {
    if (token.length > 2 && lineTokens.has(token)) {
      score += token.length > 4 ? 2 : 1;
    }
  }
  if (/\b(?:next|after)\b/i.test(line)) {
    score += 2;
  }
  if (/\b(?:walked|went|headed|drove|traveled|travelled|moved|returned)\s+to\b/i.test(line)) {
    score += 4;
  }
  return score;
}

function extractEventQaDestination(text: string): string | undefined {
  const match = text.match(
    /\b(?:walked|went|headed|drove|traveled|travelled|moved|returned)\s+to\s+([^.;|\n]+)(?:[.;|\n]|$)/i,
  );
  if (!match?.[1]) {
    return undefined;
  }
  const destination = match[1]
    .replace(/^(?:a|an)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return destination.length > 0 ? destination : undefined;
}

function scoreOfficialProtocol(options: {
  protocol: MemoryAgentBenchProtocol;
  actual: string;
  answerVariants: string[];
  recsysMapping: RecSysEntityMapping | null;
}): {
  scores: Record<string, number>;
  parsedAnswer: string | undefined;
  recsysScoringReady?: boolean;
  predictedMovies?: string[];
  groundTruthMovies?: string[];
} {
  if (options.protocol === "recsys_redial") {
    return scoreRecSysRedial(options.actual, options.answerVariants, options.recsysMapping);
  }

  const parsedAnswer =
    options.protocol === "in_context_learning"
      ? parseIclLabel(options.actual)
      : options.protocol === "eventqa"
        ? parseEventQaAnswer(options.actual)
        : parseOfficialAnswer(options.actual);
  const answerForScoring = parsedAnswer ?? options.actual;
  const textScores = calculateOfficialTextScores(answerForScoring, options.answerVariants);
  const scores: Record<string, number> = {
    official_exact_match: textScores.exactMatch,
    official_f1: textScores.f1,
    official_substring_exact_match: textScores.substringExactMatch,
    official_rouge_l: scoreAgainstVariants(answerForScoring, options.answerVariants, rougeL),
    official_protocol_ready: 1,
  };

  if (options.protocol === "eventqa") {
    scores.eventqa_recall =
      options.answerVariants.some((variant) =>
        answerForScoring.toLowerCase().includes(variant.toLowerCase()),
      )
        ? 1
        : 0;
  }

  return { scores, parsedAnswer: answerForScoring };
}

function calculateOfficialTextScores(
  prediction: string,
  answerVariants: string[],
): {
  exactMatch: number;
  f1: number;
  substringExactMatch: number;
} {
  return answerVariants.reduce(
    (best, answer) => {
      const normalizedPrediction = normalizeOfficialAnswer(prediction);
      const normalizedAnswer = normalizeOfficialAnswer(answer);
      return {
        exactMatch: Math.max(
          best.exactMatch,
          normalizedPrediction === normalizedAnswer ? 1 : 0,
        ),
        f1: Math.max(best.f1, officialF1(prediction, answer)),
        substringExactMatch: Math.max(
          best.substringExactMatch,
          normalizedPrediction.includes(normalizedAnswer) ? 1 : 0,
        ),
      };
    },
    { exactMatch: 0, f1: 0, substringExactMatch: 0 },
  );
}

function scoreRecSysRedial(
  actual: string,
  answerVariants: string[],
  recsysMapping: RecSysEntityMapping | null,
): {
  scores: Record<string, number>;
  parsedAnswer: string | undefined;
  recsysScoringReady: boolean;
  predictedMovies?: string[];
  groundTruthMovies?: string[];
} {
  if (!recsysMapping) {
    return {
      scores: { official_protocol_ready: 0 },
      parsedAnswer: parseOfficialAnswer(actual),
      recsysScoringReady: false,
    };
  }

  const predictedMovies = extractRecommendationMovies(
    actual,
    recsysMapping.movieCandidates,
    recsysMapping.aliasCounts,
  );
  const groundTruthIds = answerVariants.map(parseStrictReDialEntityId);
  const hasIncompleteGroundTruthMapping =
    groundTruthIds.length === 0 ||
    groundTruthIds.some(
      (id) => id === null || !recsysMapping.idToName.has(id),
    );

  if (hasIncompleteGroundTruthMapping) {
    return {
      scores: { official_protocol_ready: 0 },
      parsedAnswer: predictedMovies.join("\n"),
      recsysScoringReady: false,
      predictedMovies,
    };
  }

  const groundTruthMovies = groundTruthIds.map((id) => recsysMapping.idToName.get(id!)!);

  return {
    scores: {
      recsys_recall_at_1: recallAtK(predictedMovies, groundTruthMovies, 1),
      recsys_recall_at_5: recallAtK(predictedMovies, groundTruthMovies, 5),
      recsys_recall_at_10: recallAtK(predictedMovies, groundTruthMovies, 10),
      official_protocol_ready: 1,
    },
    parsedAnswer: predictedMovies.join("\n"),
    recsysScoringReady: true,
    predictedMovies,
    groundTruthMovies,
  };
}

function parseStrictReDialEntityId(value: string): number | null {
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseOfficialAnswer(output: string): string {
  const matches = [...output.matchAll(/answer:\s*/gi)];
  const lastMatch = matches.at(-1);
  if (lastMatch?.index !== undefined) {
    const answerStart = lastMatch.index + lastMatch[0].length;
    const answer = output.slice(answerStart).trim();
    if (answer.length > 0) {
      return answer;
    }
  }
  return output.trim();
}

function parseIclLabel(output: string): string {
  const officialAnswer = parseOfficialAnswer(output);
  const finalTokenMatch =
    /\blabel\s*:\s*([A-Za-z0-9_-]+)\s*[.!?]?\s*$/i.exec(officialAnswer);
  if (finalTokenMatch?.[1]) {
    return finalTokenMatch[1].trim();
  }
  return officialAnswer;
}

function parseEventQaAnswer(output: string): string {
  return parseOfficialAnswer(output)
    .replace(/^the event that happens next is\s*:?\s*/i, "")
    .trim();
}

function normalizeOfficialAnswer(answer: string): string {
  return answer
    .toLowerCase()
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "")
    .replace(/\b(a|an|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function officialF1(prediction: string, groundTruth: string): number {
  const normalizedPrediction = normalizeOfficialAnswer(prediction);
  const normalizedGroundTruth = normalizeOfficialAnswer(groundTruth);
  if (
    new Set(["yes", "no", "noanswer"]).has(normalizedPrediction) !==
      new Set(["yes", "no", "noanswer"]).has(normalizedGroundTruth) ||
    (new Set(["yes", "no", "noanswer"]).has(normalizedPrediction) &&
      normalizedPrediction !== normalizedGroundTruth)
  ) {
    return 0;
  }

  const predictionTokens = normalizedPrediction.split(" ").filter(Boolean);
  const groundTruthTokens = normalizedGroundTruth.split(" ").filter(Boolean);
  if (predictionTokens.length === 0 || groundTruthTokens.length === 0) {
    return 0;
  }

  const predictionCounts = countTokens(predictionTokens);
  const groundTruthCounts = countTokens(groundTruthTokens);
  let common = 0;
  for (const [token, predictionCount] of predictionCounts) {
    common += Math.min(predictionCount, groundTruthCounts.get(token) ?? 0);
  }
  if (common === 0) {
    return 0;
  }
  const precision = common / predictionTokens.length;
  const recall = common / groundTruthTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function extractRecommendationMovies(
  output: string,
  movieCandidates: string[],
  aliasCounts: Map<string, number>,
): string[] {
  let recommendationText = output;
  const numberedStart = output.search(/\b1\.\s*/);
  if (numberedStart >= 0) {
    recommendationText = output.slice(numberedStart).replace(/^\s*1\.\s*/, "");
  }

  return recommendationText
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*\d+[\.)]\s*/, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean)
    .flatMap((line) =>
      extractRecommendationMoviesFromLine(line, movieCandidates, aliasCounts),
    );
}

function extractRecommendationMoviesFromLine(
  line: string,
  movieCandidates: string[],
  aliasCounts: Map<string, number>,
): string[] {
  const exactMatches = findMovieCandidateMentions(line, movieCandidates, aliasCounts);
  if (exactMatches.length > 0) {
    return exactMatches;
  }

  const commaSeparatedMovies = line
    .split(/\s*,\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (commaSeparatedMovies.length > 1) {
    return commaSeparatedMovies.flatMap((movie) =>
      /\(\d{4}\)/.test(movie)
        ? findNearestMovieIfClose(movie, movieCandidates)
        : extractRecommendationMoviesFromLine(movie, movieCandidates, aliasCounts),
    );
  }

  if (/\(\d{4}\)/.test(line)) {
    return findNearestMovieIfClose(line, movieCandidates);
  }

  return [];
}

function findMovieCandidateMentions(
  line: string,
  movieCandidates: string[],
  aliasCounts: Map<string, number>,
): string[] {
  const normalizedLine = line.toLowerCase();
  const mentions = movieCandidates
    .map((movie) => findMovieCandidateMention(normalizedLine, movie, aliasCounts))
    .filter((mention): mention is { movie: string; index: number; end: number } =>
      mention !== null,
    )
    .sort((a, b) => b.movie.length - a.movie.length || a.index - b.index);

  const selected: typeof mentions = [];
  for (const mention of mentions) {
    if (
      selected.some(
        (existing) => mention.index < existing.end && existing.index < mention.end,
      )
    ) {
      continue;
    }
    selected.push(mention);
  }

  return selected.sort((a, b) => a.index - b.index).map((mention) => mention.movie);
}

function findMovieCandidateMention(
  normalizedLine: string,
  movie: string,
  aliasCounts: Map<string, number>,
): { movie: string; index: number; end: number } | null {
  for (const alias of movieAliases(movie)) {
    const normalizedAlias = alias.toLowerCase();
    if ((aliasCounts.get(normalizedAlias) ?? 0) > 1) {
      continue;
    }
    if (
      normalizedAlias.length < 4 &&
      stripTrailingRecommendationPunctuation(normalizedLine) !== normalizedAlias
    ) {
      continue;
    }
    const index = findDelimitedIndex(normalizedLine, normalizedAlias);
    if (index >= 0) {
      return { movie, index, end: index + alias.length };
    }
  }
  return null;
}

function stripTrailingRecommendationPunctuation(value: string): string {
  return value
    .replace(/^["'`]+/g, "")
    .replace(/["'`.!?;:]+$/g, "")
    .trim();
}

function countMovieAliases(movieCandidates: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const movie of movieCandidates) {
    for (const alias of movieAliases(movie)) {
      const normalizedAlias = alias.toLowerCase();
      counts.set(normalizedAlias, (counts.get(normalizedAlias) ?? 0) + 1);
    }
  }
  return counts;
}

function movieAliases(movie: string): string[] {
  const aliases = [movie];
  const titleWithoutYear = movie.replace(/\s*\(\d{4}\)\s*$/, "").trim();
  if (titleWithoutYear.length >= 2 && titleWithoutYear !== movie) {
    aliases.push(titleWithoutYear);
  }
  const titleWithoutArticle = titleWithoutYear.replace(/^(?:the|a|an)\s+/i, "").trim();
  if (titleWithoutArticle.length >= 2 && titleWithoutArticle !== titleWithoutYear) {
    aliases.push(titleWithoutArticle);
  }
  return aliases;
}

function findDelimitedIndex(haystack: string, needle: string): number {
  let start = 0;
  while (start < haystack.length) {
    const index = haystack.indexOf(needle, start);
    if (index < 0) {
      return -1;
    }
    const before = index > 0 ? haystack[index - 1] : undefined;
    const after = haystack[index + needle.length];
    if (isMovieAliasBoundary(before) && isMovieAliasBoundary(after)) {
      return index;
    }
    start = index + 1;
  }
  return -1;
}

function isMovieAliasBoundary(char: string | undefined): boolean {
  return char === undefined || !/[a-z0-9]/i.test(char);
}

function findNearestMovieIfClose(
  targetName: string,
  movieCandidates: string[],
): string[] {
  const match = findNearestMovieMatch(targetName, movieCandidates);
  if (!match) {
    return [];
  }
  const maxLength = Math.max(targetName.length, match.movie.length);
  const maxDistance = Math.max(3, Math.ceil(maxLength * 0.35));
  return match.distance <= maxDistance ? [match.movie] : [];
}

function findNearestMovieMatch(
  targetName: string,
  movieCandidates: string[],
): { movie: string; distance: number } | null {
  if (movieCandidates.length === 0) {
    return null;
  }
  let bestMovie = movieCandidates[0] ?? targetName;
  let bestDistance = Number.POSITIVE_INFINITY;
  const normalizedTarget = targetName.toLowerCase();

  for (const candidate of movieCandidates) {
    const distance = editDistance(normalizedTarget, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestMovie = candidate;
      bestDistance = distance;
    }
  }

  return { movie: bestMovie, distance: bestDistance };
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + substitutionCost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[b.length] ?? 0;
}

async function loadRecSysEntityMapping(
  datasetDir: string | undefined,
): Promise<RecSysEntityMapping | null> {
  const candidates = recsysEntityMappingCandidates(datasetDir);
  for (const candidate of candidates) {
    if (!(await fileExists(candidate))) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(candidate, "utf8")) as unknown;
    } catch (error) {
      console.error(
        `  [WARN] MemoryAgentBench ReDial entity mapping ${candidate} is invalid JSON; trying the next candidate: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error(
        `  [WARN] MemoryAgentBench ReDial entity mapping ${candidate} must be an object; trying the next candidate.`,
      );
      continue;
    }

    const idToName = new Map<number, string>();
    let invalidMapping = false;
    for (const [rawName, rawId] of Object.entries(parsed)) {
      const id = typeof rawId === "number" ? rawId : Number(rawId);
      if (!Number.isInteger(id)) {
        console.error(
          `  [WARN] MemoryAgentBench ReDial entity mapping ${candidate} has non-integer id for ${rawName}; trying the next candidate.`,
        );
        invalidMapping = true;
        break;
      }
      idToName.set(id, extractMovieName(rawName));
    }
    if (invalidMapping) {
      continue;
    }
    if (idToName.size === 0) {
      console.error(
        `  [WARN] MemoryAgentBench ReDial entity mapping ${candidate} is empty; trying the next candidate.`,
      );
      continue;
    }

    return {
      idToName,
      movieCandidates: [...new Set(idToName.values())],
      aliasCounts: countMovieAliases([...new Set(idToName.values())]),
      sourcePath: candidate,
    };
  }
  return null;
}

async function requireRecSysEntityMapping(
  datasetDir: string | undefined,
): Promise<RecSysEntityMapping> {
  const mapping = await loadRecSysEntityMapping(datasetDir);
  if (!mapping) {
    throw new Error(
      "MemoryAgentBench ReDial samples require a valid ReDial entity mapping. " +
        `Expected one of: ${recsysEntityMappingCandidates(datasetDir).join(", ") || "entity2id.json under the dataset directory"}.`,
    );
  }
  return mapping;
}

function recsysEntityMappingCandidates(datasetDir: string | undefined): string[] {
  if (!datasetDir) {
    return [];
  }
  const absoluteDatasetDir = path.resolve(datasetDir);
  const roots = [
    absoluteDatasetDir,
    path.dirname(absoluteDatasetDir),
  ];

  const canonicalSuffixes = [
    path.join("processed_data", "Recsys_Redial", "entity2id.json"),
    path.join("Recsys_Redial", "entity2id.json"),
  ];
  const looseSuffixes = ["entity2id.json"];

  return [
    ...roots.flatMap((root) =>
      canonicalSuffixes.map((suffix) => path.join(root, suffix)),
    ),
    ...looseSuffixes.map((suffix) => path.join(absoluteDatasetDir, suffix)),
  ];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function extractMovieName(rawName: string): string {
  const filename = rawName.split("/").pop() ?? rawName;
  const decodedFilename = decodeUrlComponentSafely(filename);
  return decodedFilename
    .replace(/[_>]+/g, " ")
    .replace(/\((\d{4})\s+film\)$/i, "($1)")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeUrlComponentSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function loadDataset(
  mode: "full" | "quick",
  datasetDir: string | undefined,
  limit?: number,
): Promise<MemoryAgentBenchItem[]> {
  const normalizedLimit = normalizeLimit(limit);
  const ensureDatasetItems = (items: MemoryAgentBenchItem[]): MemoryAgentBenchItem[] => {
    if (items.length === 0) {
      throw new Error(
        "MemoryAgentBench dataset is empty after applying the requested limit.",
      );
    }
    return items;
  };

  if (datasetDir) {
    const datasetErrors: string[] = [];

    for (const filename of DATASET_BUNDLE_CANDIDATES) {
      const parsed = await tryReadDatasetFile(
        path.join(datasetDir, filename),
        filename,
        datasetErrors,
      );
      if (parsed) {
        return ensureDatasetItems(applyLimit(parsed, normalizedLimit));
      }
    }

    const splitItems: MemoryAgentBenchItem[] = [];
    let remainingLimit = normalizedLimit;
    for (const splitConfig of DATASET_SPLITS) {
      if (remainingLimit === 0) {
        break;
      }

      let splitData: MemoryAgentBenchItem[] | undefined;
      for (const filename of splitConfig.candidates) {
        try {
          splitData = await readDatasetFile(path.join(datasetDir, filename), filename);
          break;
        } catch (error) {
          if (!isFileNotFoundError(error)) {
            throw error;
          }
          datasetErrors.push(
            `${filename}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (!splitData) {
        continue;
      }

      const filtered = splitData.filter(
        (item) =>
          item.metadata.competency === splitConfig.competency ||
          item.metadata.source.toLowerCase().startsWith(splitConfig.sourcePrefix),
      );
      const limited = applyLimit(filtered, remainingLimit);
      splitItems.push(...limited);
      if (remainingLimit !== undefined) {
        remainingLimit = Math.max(0, remainingLimit - limited.length);
      }
    }

    if (splitItems.length > 0) {
      return ensureDatasetItems(splitItems);
    }

    throw new Error(
      `MemoryAgentBench dataset not found under ${datasetDir}. Tried bundle files (${DATASET_BUNDLE_CANDIDATES.join(", ")}) and split files for ${DATASET_SPLITS.map((split) => split.split).join(", ")}. Errors: ${datasetErrors.join(" | ")}`,
    );
  }

  if (mode === "full") {
    throw new Error(
      "MemoryAgentBench full mode requires datasetDir. Pass a dataset path or use quick mode to run the bundled smoke fixture.",
    );
  }

  return ensureDatasetItems(applyLimit(MEMORY_AGENT_BENCH_SMOKE_FIXTURE, normalizedLimit));
}

async function readDatasetFile(
  filePath: string,
  filename: string,
): Promise<MemoryAgentBenchItem[]> {
  const raw = await readFile(filePath, "utf8");
  const parsed = filename.endsWith(".jsonl")
    ? parseJsonLines(raw, filename)
    : parseJsonArray(raw, filename);

  return parsed.map((item, index) =>
    parseMemoryAgentBenchItem(item, `${filename} item ${index + 1}`),
  );
}

function parseJsonArray(raw: string, filename: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `MemoryAgentBench dataset file ${filename} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `MemoryAgentBench dataset file ${filename} must contain an array of samples.`,
    );
  }

  return parsed;
}

function parseJsonLines(raw: string, filename: string): unknown[] {
  const rows: unknown[] = [];

  raw.split("\n").forEach((line, lineIndex) => {
    if (line.trim().length === 0) {
      return;
    }

    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new Error(
        `MemoryAgentBench dataset file ${filename} contains invalid JSON on line ${lineIndex + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  return rows;
}

function parseMemoryAgentBenchItem(
  value: unknown,
  location: string,
): MemoryAgentBenchItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${location} must be an object.`);
  }

  const record = value as Record<string, unknown>;
  if (typeof record.context !== "string" || record.context.trim().length === 0) {
    throw new Error(`${location} must include a non-empty string context.`);
  }

  const questions = normalizeStringArray(record.questions, `${location}.questions`);
  const answers = normalizeAnswerVariants(record.answers, `${location}.answers`);
  if (questions.length === 0) {
    throw new Error(`${location} must include at least one question.`);
  }
  if (questions.length !== answers.length) {
    throw new Error(
      `${location} must include the same number of questions and answer groups.`,
    );
  }

  return {
    context: record.context,
    questions,
    answers,
    metadata: parseMetadata(record.metadata, location),
  };
}

function parseMetadata(
  value: unknown,
  location: string,
): MemoryAgentBenchMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${location}.metadata must be an object.`);
  }

  const record = value as Record<string, unknown>;
  if (typeof record.source !== "string" || record.source.trim().length === 0) {
    throw new Error(`${location}.metadata.source must be a non-empty string.`);
  }

  const competency = inferCompetency(record.source);
  return {
    source: record.source,
    competency,
    demo: typeof record.demo === "string" || record.demo === null ? (record.demo ?? null) : null,
    haystack_sessions: normalizeHaystackSessions(
      record.haystack_sessions,
      `${location}.metadata.haystack_sessions`,
    ),
    keypoints: normalizeOptionalStringArray(record.keypoints, `${location}.metadata.keypoints`),
    previous_events: normalizeOptionalStringArray(
      record.previous_events,
      `${location}.metadata.previous_events`,
    ),
    qa_pair_ids: normalizeOptionalStringArray(
      record.qa_pair_ids,
      `${location}.metadata.qa_pair_ids`,
    ),
    question_dates: normalizeOptionalStringArray(
      record.question_dates,
      `${location}.metadata.question_dates`,
    ),
    question_ids: normalizeOptionalStringArray(
      record.question_ids,
      `${location}.metadata.question_ids`,
    ),
    question_types: normalizeOptionalStringArray(
      record.question_types,
      `${location}.metadata.question_types`,
    ),
  };
}

async function tryReadDatasetFile(
  filePath: string,
  filename: string,
  datasetErrors: string[],
): Promise<MemoryAgentBenchItem[] | undefined> {
  try {
    return await readDatasetFile(filePath, filename);
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
    datasetErrors.push(
      `${filename}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function inferCompetency(source: string): MemoryAgentBenchCompetency {
  const normalizedSource = source.toLowerCase();
  if (
    normalizedSource.startsWith("eventqa") ||
    normalizedSource.startsWith("longmemeval") ||
    normalizedSource.startsWith("ruler_")
  ) {
    return "accurate_retrieval";
  }
  if (normalizedSource.startsWith("icl_") || normalizedSource.startsWith("recsys_")) {
    return "test_time_learning";
  }
  if (normalizedSource.startsWith("detective_") || normalizedSource.startsWith("infbench_")) {
    return "long_range_understanding";
  }
  if (normalizedSource.startsWith("factconsolidation")) {
    return "conflict_resolution";
  }

  throw new Error(
    `MemoryAgentBench metadata.source "${source}" does not map to a supported competency.`,
  );
}

function normalizeStringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${location} must be an array of strings.`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`${location}[${index}] must be a non-empty string.`);
    }
    return entry;
  });
}

function normalizeOptionalStringArray(
  value: unknown,
  location: string,
): string[] | null {
  if (value === undefined || value === null) {
    return null;
  }
  return normalizeStringArray(value, location);
}

function normalizeAnswerVariants(value: unknown, location: string): string[][] {
  if (!Array.isArray(value)) {
    throw new Error(`${location} must be an array of answer groups.`);
  }

  return value.map((entry, index) => {
    const answerGroup = Array.isArray(entry) ? entry : [entry];
    const normalized = answerGroup
      .map((candidate, candidateIndex) => {
        if (typeof candidate !== "string" || candidate.trim().length === 0) {
          throw new Error(
            `${location}[${index}][${candidateIndex}] must be a non-empty string.`,
          );
        }
        return candidate;
      })
      .filter(Boolean);

    if (normalized.length === 0) {
      throw new Error(`${location}[${index}] must include at least one answer variant.`);
    }

    return normalized;
  });
}

function normalizeHaystackSessions(
  value: unknown,
  location: string,
): MemoryAgentBenchTurn[][] | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${location} must be an array of sessions.`);
  }

  return value.map((session, sessionIndex) => {
    if (!Array.isArray(session)) {
      throw new Error(`${location}[${sessionIndex}] must be an array of turns.`);
    }

    return session.map((turn, turnIndex) => {
      if (!turn || typeof turn !== "object" || Array.isArray(turn)) {
        throw new Error(
          `${location}[${sessionIndex}][${turnIndex}] must be an object with role/content.`,
        );
      }

      const record = turn as Record<string, unknown>;
      if (
        record.role !== "user" &&
        record.role !== "assistant" &&
        record.role !== "system"
      ) {
        throw new Error(
          `${location}[${sessionIndex}][${turnIndex}].role must be user, assistant, or system.`,
        );
      }
      if (typeof record.content !== "string" || record.content.trim().length === 0) {
        throw new Error(
          `${location}[${sessionIndex}][${turnIndex}].content must be a non-empty string.`,
        );
      }

      return {
        role: record.role,
        content: record.content,
        has_answer:
          typeof record.has_answer === "boolean" ? record.has_answer : undefined,
      };
    });
  });
}

async function storeBenchmarkContext(
  options: ResolvedRunBenchmarkOptions,
  item: MemoryAgentBenchItem,
  itemIndex: number,
): Promise<string[]> {
  const sourceSlug = item.metadata.source.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const baseSessionId = `memoryagentbench-${sourceSlug}-${itemIndex}`;
  const storedSessionIds: string[] = [];

  if (item.metadata.haystack_sessions && item.metadata.haystack_sessions.length > 0) {
    for (const [sessionIndex, turns] of item.metadata.haystack_sessions.entries()) {
      const sessionId = `${baseSessionId}-session-${sessionIndex}`;
      const messages = turns.map<Message>((turn, turnIndex) =>
        buildVisibleCueMessage(
          {
            role: turn.role,
            content: turn.content,
          },
          turnIndex,
        ),
      );
      if (messages.length > 0) {
        await storeMessagesInChunks(options, sessionId, messages);
        storedSessionIds.push(sessionId);
      }
    }
  }

  if (storedSessionIds.length > 0) {
    return storedSessionIds;
  }

  const chunkedContext = chunkContext(item.context);
  const sessionId = `${baseSessionId}-context`;
  if (chunkedContext.length > 0) {
    await storeMessagesInChunks(
      options,
      sessionId,
      chunkedContext.map<Message>((content, chunkIndex) =>
        buildVisibleCueMessage({ role: "user", content }, chunkIndex),
      ),
    );
  }
  return [sessionId];
}

function buildVisibleCueMessage(message: Message, index: number): Message {
  const anchors = collectVisibleCueAnchors(message.content, index);
  if (anchors.length === 0) {
    return message;
  }
  return {
    ...message,
    content: [
      message.content,
      `${VISIBLE_CUE_ANCHOR_PREFIX} ${anchors.join("; ")}.`,
    ].join("\n"),
  };
}

function collectVisibleCueAnchors(content: string, index: number): string[] {
  const anchors = new Set<string>([
    `chunk ${index}`,
    `chunk_id=${index}`,
    `memoryagentbench_chunk=${index}`,
  ]);

  for (const match of content.matchAll(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?Z?)?\b/g)) {
    const date = match[0];
    anchors.add(date);
    anchors.add(`date=${date}`);
  }
  for (const match of content.matchAll(/\b(?:event|episode|fact|keypoint|clue|case)\s*#?\s*([A-Za-z0-9_.:-]{1,40})\b/gi)) {
    const label = match[0].replace(/\s+/g, " ").trim();
    const id = match[1]?.trim();
    if (!id) {
      continue;
    }
    anchors.add(label);
    anchors.add(`${match[0].split(/\s+/)[0]!.toLowerCase()}_id=${id}`);
  }
  for (const match of content.matchAll(/(?:^|\n)\s*(\d{1,6})[\.)]\s+/g)) {
    const serial = match[1];
    if (!serial) {
      continue;
    }
    anchors.add(`fact ${serial}`);
    anchors.add(`fact_id=${serial}`);
    anchors.add(`serial=${serial}`);
  }

  return [...anchors].sort((left, right) => left.localeCompare(right));
}

function stripVisibleCueAnchors(content: string): string {
  return content
    .split("\n")
    .filter((line) => !line.startsWith(VISIBLE_CUE_ANCHOR_PREFIX))
    .join("\n")
    .trim();
}

async function storeMessagesInChunks(
  options: ResolvedRunBenchmarkOptions,
  sessionId: string,
  messages: Message[],
): Promise<void> {
  for (let index = 0; index < messages.length; index += 20) {
    await options.system.store(sessionId, messages.slice(index, index + 20));
  }
}

function chunkContext(context: string): string[] {
  const paragraphs = context
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const chunks = paragraphs.length > 0 ? paragraphs : [context.trim()].filter(Boolean);
  return chunks.flatMap((chunk) => splitLongChunk(chunk, 1_200));
}

function splitLongChunk(chunk: string, maxLength: number): string[] {
  if (chunk.length <= maxLength) {
    return [chunk];
  }

  const segments: string[] = [];
  let remaining = chunk;
  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    let keepTrailingPunctuation = false;
    if (splitIndex < maxLength * 0.5) {
      splitIndex = remaining.lastIndexOf(". ", maxLength);
      keepTrailingPunctuation = splitIndex >= maxLength * 0.5;
    }
    if (splitIndex < maxLength * 0.5) {
      splitIndex = maxLength;
      keepTrailingPunctuation = false;
    } else if (keepTrailingPunctuation) {
      splitIndex += 1;
    }

    segments.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  if (remaining.length > 0) {
    segments.push(remaining);
  }

  return segments.filter(Boolean);
}

function scoreAgainstVariants(
  actual: string,
  variants: string[],
  scorer: (actual: string, expected: string) => number,
): number {
  return variants.reduce(
    (best, variant) => Math.max(best, scorer(actual, variant)),
    Number.NEGATIVE_INFINITY,
  );
}

function selectBestMatchingAnswer(actual: string, variants: string[]): string {
  return variants.reduce((best, candidate) => {
    if (!best) {
      return candidate;
    }

    const currentScore = scoreAgainstVariants(actual, [best], f1Score);
    const candidateScore = scoreAgainstVariants(actual, [candidate], f1Score);
    return candidateScore > currentScore ? candidate : best;
  }, "");
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(
      "MemoryAgentBench limit must be a non-negative integer when provided.",
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
