/**
 * MemBench runner migrated into @remnic/bench for phase 1.
 */

import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  MEMBENCH_SMOKE_FIXTURE,
  type MemBenchCase,
} from "./fixture.js";
import { answerBenchmarkQuestion } from "../../../answering.js";
import { DEFAULT_BENCH_RECALL_BUDGET_CHARS } from "../../../recall-budget.js";
import type { Message } from "../../../adapters/types.js";
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

type MemBenchChoice = "A" | "B" | "C" | "D";

interface MemBenchQuestionAnswer {
  id?: string;
  question: string;
  answer: string;
  choices?: Record<MemBenchChoice, string>;
  correctChoice?: MemBenchChoice;
  questionTime?: string;
  targetStepIds?: number[];
  targetStepCoordinates?: number[][];
}

interface NormalizedMemBenchTurns {
  turns: Message[];
  coordinateIndex: Map<string, number>;
}

const DATASET_FILENAMES = [
  "membench.json",
  "membench.jsonl",
  "data.json",
] as const;

const UPSTREAM_DATASET_FILENAME_PATTERNS = [
  /^(?:First|Third)Agent(?:Data)?(?:High|Low)Level\.jsonl?$/i,
  /^(?:First|Third)Agent(?:High|Low)Level\.jsonl?$/i,
] as const;

interface MemBenchHints {
  memoryType?: MemBenchCase["memoryType"];
  scenario?: MemBenchCase["scenario"];
  level?: string;
}

export const memBenchDefinition: BenchmarkDefinition = {
  id: "membench",
  title: "MemBench",
  tier: "published",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "membench",
    version: "2.0.0",
    description:
      "Factual versus reflective memory benchmark across participant and observer scenarios.",
    category: "retrieval",
    citation:
      "MemBench: Evaluating Factual and Reflective Memory in Long-Context Assistants (ACL 2025).",
  },
};

export async function runMemBenchBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const dataset = await loadDataset(options.mode, options.datasetDir, options.limit);
  const tasks: TaskResult[] = [];

  const totalTasks = dataset.length;

  for (const testCase of dataset) {
    try {
      await options.system.reset();

      const sessionId = `membench-${testCase.id}`;
      const storedTurns = buildStoredTurns(testCase);
      if (storedTurns.length > 0) {
        await options.system.store(sessionId, storedTurns);
      }

      try {
        await options.system.drain?.();
      } catch (drainErr) {
        throw new Error(
          `MemBench drain failed for ${testCase.id}: ${drainErr instanceof Error ? drainErr.message : String(drainErr)}`,
        );
      }

      const recallQuery = buildRecallQuery(testCase);
      const { result: recalledText, durationMs } = await timed(async () =>
        options.system.recall(
          sessionId,
          recallQuery,
          DEFAULT_BENCH_RECALL_BUDGET_CHARS,
        ),
      );
      const answerQuestion = buildQuestionPrompt(testCase);
      const answerRecalledText = stripMemBenchStepAnchors(recalledText);
      const answered = await answerBenchmarkQuestion({
        question: answerQuestion,
        recalledText: answerRecalledText,
        responder: options.system.responder,
        answerMode: "strict",
      });
      const predictedChoice = testCase.choices
        ? extractChoice(answered.finalAnswer, testCase.choices)
        : undefined;
      const actualAnswer = predictedChoice && testCase.choices
        ? testCase.choices[predictedChoice]
        : answered.finalAnswer;
      const judgeResult = await llmJudgeScoreDetailed(
        options.system.judge,
        testCase.question,
        actualAnswer,
        testCase.answer,
      );

      const scores: Record<string, number> = {
        f1: f1Score(actualAnswer, testCase.answer),
        contains_answer: containsAnswer(actualAnswer, testCase.answer),
      };
      if (testCase.correctChoice) {
        scores.membench_accuracy = predictedChoice === testCase.correctChoice ? 1 : 0;
      } else {
        scores.membench_accuracy = memBenchExactAnswerMatch(actualAnswer, testCase.answer);
      }
      if (judgeResult.score >= 0) {
        scores.llm_judge = judgeResult.score;
      }
      const recallScore = await scoreRecallAt10(options.system, sessionId, testCase);
      if (recallScore !== undefined) {
        scores.membench_recall_at_10 = recallScore;
      }

      tasks.push({
        taskId: testCase.id,
        question: testCase.question,
        expected: testCase.correctChoice ?? testCase.answer,
        actual: predictedChoice ?? answered.finalAnswer,
        scores,
        latencyMs: durationMs + answered.latencyMs + judgeResult.latencyMs,
        tokens: {
          input: answered.tokens.input + judgeResult.tokens.input,
          output: answered.tokens.output + judgeResult.tokens.output,
        },
        details: {
          memoryType: testCase.memoryType,
          scenario: testCase.scenario,
          level: testCase.level,
          turnCount: testCase.turns.length,
          recalledLength: answerRecalledText.length,
          answeredLength: answered.finalAnswer.length,
          officialProtocol: testCase.choices ? "multiple_choice_accuracy" : "exact_answer_accuracy",
          choices: testCase.choices,
          correctChoice: testCase.correctChoice,
          correctAnswer: testCase.answer,
          predictedChoice,
          predictedAnswer: actualAnswer,
          questionTime: testCase.questionTime,
          targetStepIds: testCase.targetStepIds,
          targetStepCoordinates: testCase.targetStepCoordinates,
          recalledText: answerRecalledText,
          answeredText: answered.finalAnswer,
          responderModel: answered.model,
          judgeModel: judgeResult.model,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  [WARN] membench task ${testCase.id} failed: ${message}`);
      const scores: Record<string, number> = {
        f1: -1,
        contains_answer: -1,
        llm_judge: -1,
        membench_accuracy: -1,
      };
      if (testCase.targetStepIds && testCase.targetStepIds.length > 0) {
        scores.membench_recall_at_10 = -1;
      }
      tasks.push({
        taskId: testCase.id,
        question: testCase.question,
        expected: testCase.correctChoice ?? testCase.answer,
        actual: `(error: ${message})`,
        scores,
        latencyMs: 0,
        tokens: { input: 0, output: 0 },
        details: {
          error: message,
          memoryType: testCase.memoryType,
          scenario: testCase.scenario,
          level: testCase.level,
          turnCount: testCase.turns.length,
          officialProtocol: testCase.choices ? "multiple_choice_accuracy" : "exact_answer_accuracy",
          choices: testCase.choices,
          correctChoice: testCase.correctChoice,
          correctAnswer: testCase.answer,
          questionTime: testCase.questionTime,
          targetStepIds: testCase.targetStepIds,
          targetStepCoordinates: testCase.targetStepCoordinates,
        },
      });
    }

    options.onTaskComplete?.(tasks[tasks.length - 1]!, tasks.length, totalTasks);
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
      aggregates: {
        ...aggregateTaskScores(tasks.map((task) => task.scores)),
        ...aggregateMemBenchOfficialBreakdowns(tasks),
      },
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
): Promise<MemBenchCase[]> {
  const normalizedLimit = normalizeLimit(limit);
  const ensureDatasetCases = (cases: MemBenchCase[]): MemBenchCase[] => {
    if (cases.length === 0) {
      throw new Error(
        "MemBench dataset is empty after applying the requested limit.",
      );
    }
    return cases;
  };

  if (datasetDir) {
    const { filenames, scanError } = await discoverDatasetFiles(datasetDir);
    if (filenames.length === 0) {
      throw new Error(buildDatasetNotFoundError(datasetDir, scanError, []));
    }

    const datasetErrors: string[] = [];
    const cases: MemBenchCase[] = [];
    let remainingLimit = normalizedLimit;
    for (const filename of filenames) {
      try {
        const raw = await readFile(path.join(datasetDir, filename), "utf8");
        const parsed = filename.endsWith(".jsonl")
          ? parseJsonlDataset(raw, filename)
          : parseJsonDataset(raw, filename);
        const limitedCases = remainingLimit === 0
          ? []
          : applyLimit(parsed, remainingLimit);
        if (limitedCases.length > 0) {
          cases.push(...limitedCases);
        }
        if (remainingLimit !== undefined && limitedCases.length > 0) {
          remainingLimit = Math.max(remainingLimit - limitedCases.length, 0);
        }
      } catch (error) {
        datasetErrors.push(
          `${filename}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (datasetErrors.length > 0) {
      throw new Error(buildDatasetLoadError(datasetDir, datasetErrors));
    }

    if (cases.length > 0) {
      return ensureDatasetCases(cases);
    }

    throw new Error(buildDatasetNotFoundError(datasetDir, undefined, []));
  }

  if (mode === "full") {
    throw new Error(
      "MemBench full mode requires datasetDir. Pass a dataset path or use quick mode to run the bundled smoke fixture.",
    );
  }

  return ensureDatasetCases(applyLimit(MEMBENCH_SMOKE_FIXTURE, normalizedLimit));
}

function parseJsonDataset(raw: string, filename: string): MemBenchCase[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `MemBench dataset file ${filename} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    const normalizedCases = normalizePublishedDataset(parsed, filename);
    if (normalizedCases.length > 0) {
      return normalizedCases;
    }

    throw new Error(
      `MemBench dataset file ${filename} must contain an array of cases or a nested published dataset structure.`,
    );
  }

  const normalizedCases = normalizePublishedDataset(parsed, filename);
  if (normalizedCases.length > 0) {
    return normalizedCases;
  }

  return parsed.map((entry, index) => parseCase(entry, `${filename}[${index}]`));
}

function parseJsonlDataset(raw: string, filename: string): MemBenchCase[] {
  const cases: MemBenchCase[] = [];
  const hints = inferHintsFromLabel(filename, {});
  raw.split("\n").forEach((line, lineIndex) => {
    if (line.trim().length === 0) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(
        `MemBench dataset file ${filename} contains invalid JSON on line ${lineIndex + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const location = `${filename}:${lineIndex + 1}`;
    const normalizedCases = normalizePublishedNode(parsed, hints, location);
    if (normalizedCases.length > 0) {
      cases.push(...normalizedCases);
      return;
    }

    cases.push(parseCase(parsed, location));
  });
  return cases;
}

function parseCase(entry: unknown, location: string): MemBenchCase {
  if (!isPlainObject(entry)) {
    throw new Error(`MemBench case ${location} must be an object.`);
  }

  const {
    id,
    memoryType,
    scenario,
    level,
    turns,
    question,
      answer,
    choices,
    correctChoice,
    questionTime,
    targetStepIds,
    targetStepCoordinates,
    skipFlatCoordinateFallback,
  } = entry;

  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`MemBench case ${location} must include a non-empty id string.`);
  }

  if (memoryType !== "factual" && memoryType !== "reflective") {
    throw new Error(
      `MemBench case ${location} must include memoryType as "factual" or "reflective".`,
    );
  }

  if (scenario !== "participant" && scenario !== "observation") {
    throw new Error(
      `MemBench case ${location} must include scenario as "participant" or "observation".`,
    );
  }

  if (typeof level !== "string" || level.length === 0) {
    throw new Error(`MemBench case ${location} must include a non-empty level string.`);
  }

  if (typeof question !== "string" || question.length === 0) {
    throw new Error(`MemBench case ${location} must include a non-empty question string.`);
  }

  if (!Array.isArray(turns) || turns.length === 0) {
    throw new Error(`MemBench case ${location} must include a non-empty turns array.`);
  }

  const parsedChoices = parseChoices(choices, location);
  const rawAnswer = typeof answer === "string" && answer.length > 0
    ? answer
    : undefined;
  const parsedCorrectChoice = parseCorrectChoice(correctChoice, rawAnswer, parsedChoices, location);
  const flatCoordinateIndex = buildFlatCoordinateIndex(turns.length);
  const idRefs = parseTargetStepRefs(targetStepIds, flatCoordinateIndex);
  const coordinateRefs = parseTargetStepRefs(
    targetStepCoordinates,
    skipFlatCoordinateFallback === true ? undefined : flatCoordinateIndex,
    { treatSingleArrayAsCoordinate: true },
  );
  const targetRefs = {
    targetStepIds: idRefs.targetStepIds ?? coordinateRefs.targetStepIds,
    targetStepCoordinates: coordinateRefs.targetStepCoordinates ?? idRefs.targetStepCoordinates,
  };
  const parsedAnswer = parsedChoices && parsedCorrectChoice
    ? parsedChoices[parsedCorrectChoice]
    : rawAnswer;
  if (!parsedAnswer) {
    throw new Error(`MemBench case ${location} must include a non-empty answer string or choices with a correct choice.`);
  }

  return {
    id,
    memoryType,
    scenario,
    level,
    turns: turns.map((turn, index) => parseTurn(turn, `${location}.turns[${index}]`)),
    question,
    answer: parsedAnswer,
    choices: parsedChoices,
    correctChoice: parsedCorrectChoice,
    questionTime: typeof questionTime === "string" ? questionTime : undefined,
    targetStepIds: targetRefs.targetStepIds,
    targetStepCoordinates: targetRefs.targetStepCoordinates,
  };
}

async function discoverDatasetFiles(
  datasetDir: string,
): Promise<{ filenames: string[]; scanError?: string }> {
  let directoryEntries: string[];
  try {
    directoryEntries = await readdir(datasetDir);
  } catch (error) {
    return {
      filenames: [],
      scanError: error instanceof Error ? error.message : String(error),
    };
  }

  const filenames = directoryEntries
    .filter((filename) => isRecognizedDatasetFilename(filename))
    .sort((left, right) => left.localeCompare(right));

  return { filenames };
}

function isRecognizedDatasetFilename(filename: string): boolean {
  if (DATASET_FILENAMES.includes(filename as (typeof DATASET_FILENAMES)[number])) {
    return true;
  }

  return UPSTREAM_DATASET_FILENAME_PATTERNS.some((pattern) => pattern.test(filename));
}

function buildDatasetNotFoundError(
  datasetDir: string,
  scanError: string | undefined,
  datasetErrors: string[],
): string {
  const tried = [
    ...DATASET_FILENAMES,
    "FirstAgentDataLowLevel.json",
    "FirstAgentDataHighLevel.json",
    "ThirdAgentDataLowLevel.json",
    "ThirdAgentDataHighLevel.json",
  ].join(", ");
  const details = [scanError, ...datasetErrors].filter(Boolean).join(" | ");
  return details.length > 0
    ? `MemBench dataset not found under ${datasetDir}. Tried ${tried}. Errors: ${details}`
    : `MemBench dataset not found under ${datasetDir}. Tried ${tried}.`;
}

function buildDatasetLoadError(
  datasetDir: string,
  datasetErrors: string[],
): string {
  return [
    `MemBench dataset under ${datasetDir} has invalid recognized shard(s).`,
    `Errors: ${datasetErrors.join(" | ")}`,
  ].join(" ");
}

function normalizePublishedDataset(
  parsed: unknown,
  filename: string,
): MemBenchCase[] {
  const hints = inferHintsFromLabel(filename, {});
  return normalizePublishedNode(parsed, hints, filename);
}

function normalizePublishedNode(
  node: unknown,
  hints: MemBenchHints,
  location: string,
): MemBenchCase[] {
  if (Array.isArray(node)) {
    return node.flatMap((entry, index) =>
      normalizePublishedNode(entry, hints, `${location}[${index}]`),
    );
  }

  if (!isPlainObject(node)) {
    return [];
  }

  const flatCase = normalizeFlatCase(node, hints, location);
  if (flatCase) {
    return [flatCase];
  }

  const leafCases = normalizeTrajectoryQaRecord(node, hints, location);
  if (leafCases.length > 0) {
    return leafCases;
  }

  return Object.entries(node).flatMap(([key, value]) =>
    normalizePublishedNode(
      value,
      inferHintsFromLabel(key, hints),
      `${location}.${key}`,
    ),
  );
}

function normalizeFlatCase(
  record: Record<string, unknown>,
  hints: MemBenchHints,
  location: string,
): MemBenchCase | null {
  const hasAnswer = "answer" in record;
  const hasChoiceAnswer = ("choices" in record || "options" in record)
    && ("correctChoice" in record || "correct_choice" in record);
  if (!("turns" in record) || !("question" in record) || (!hasAnswer && !hasChoiceAnswer)) {
    return null;
  }

  return parseCase(
    {
      id: resolveCaseId(record, location, 0),
      memoryType: resolveMemoryType(record.memoryType, hints),
      scenario: resolveScenario(record.scenario, hints),
      level: resolveLevel(record.level, hints),
      turns: record.turns,
      question: record.question,
      answer: record.answer,
      choices: record.choices ?? record.options,
      correctChoice: record.correctChoice ?? record.correct_choice,
      questionTime: record.questionTime ?? record.question_time ?? record.time,
      targetStepIds: record.targetStepIds ?? record.target_step_ids ?? record.target_step_id,
      targetStepCoordinates:
        record.targetStepCoordinates
        ?? record.target_step_coordinates
        ?? record.target_step_coordinate,
    },
    location,
  );
}

function normalizeTrajectoryQaRecord(
  record: Record<string, unknown>,
  hints: MemBenchHints,
  location: string,
): MemBenchCase[] {
  const trajectory = record.trajectory ?? record.message_list ?? record.messages;
  const rawQa = record.qa ?? record.QA ?? record.qas ?? record.qa_pairs ?? record.question_answers;
  const qa = Array.isArray(rawQa)
    ? rawQa
    : isPlainObject(rawQa)
      ? [rawQa]
      : undefined;

  if (!Array.isArray(trajectory) || !Array.isArray(qa) || qa.length === 0) {
    return [];
  }

  const normalizedTurns = normalizeTrajectoryTurns(trajectory, `${location}.trajectory`);
  if (!normalizedTurns) {
    return [];
  }

  const qaPairs = normalizeQaPairs(qa, `${location}.qa`, normalizedTurns.coordinateIndex);
  if (qaPairs.length === 0) {
    return [];
  }

  return qaPairs.map((pair, index) =>
    parseCase(
      {
        id: pair.id ?? resolveCaseId(record, location, index),
        memoryType: resolveMemoryType(record.memoryType, hints),
        scenario: resolveScenario(record.scenario, hints),
        level: resolveLevel(record.level, hints),
        turns: normalizedTurns.turns,
        question: pair.question,
        answer: pair.answer,
        choices: pair.choices,
        correctChoice: pair.correctChoice,
        questionTime: pair.questionTime,
        targetStepIds: pair.targetStepIds,
        targetStepCoordinates: pair.targetStepCoordinates,
        skipFlatCoordinateFallback: true,
      },
      `${location}.qa[${index}]`,
    ),
  );
}

function normalizeTrajectoryTurns(
  trajectory: unknown[],
  location: string,
): NormalizedMemBenchTurns | null {
  if (trajectory.length === 0) {
    return null;
  }

  const speakerRoles = new Map<string, Message["role"]>();
  let distinctSpeakers = 0;
  const turns: Message[] = [];
  const coordinateIndex = new Map<string, number>();

  for (let index = 0; index < trajectory.length; index += 1) {
    const turn = trajectory[index];
    if (Array.isArray(turn)) {
      for (let nestedIndex = 0; nestedIndex < turn.length; nestedIndex += 1) {
        if (!appendTrajectoryTurn(
          turn[nestedIndex],
          `${location}[${index}][${nestedIndex}]`,
          [index, nestedIndex],
          turns,
          coordinateIndex,
          speakerRoles,
          () => distinctSpeakers++,
        )) {
          return null;
        }
      }
      continue;
    }

    if (!appendTrajectoryTurn(
      turn,
      `${location}[${index}]`,
      [index],
      turns,
      coordinateIndex,
      speakerRoles,
      () => distinctSpeakers++,
    )) {
      return null;
    }
  }

  return turns.length > 0 ? { turns, coordinateIndex } : null;
}

function appendTrajectoryTurn(
  turn: unknown,
  _location: string,
  coordinate: number[],
  turns: Message[],
  coordinateIndex: Map<string, number>,
  speakerRoles: Map<string, Message["role"]>,
  nextSpeakerIndex: () => number,
): boolean {
  const rememberCoordinate = (
    targetCoordinate: number[] = coordinate,
    turnIndex = turns.length,
  ) => {
    coordinateIndex.set(coordinateKey(targetCoordinate), turnIndex);
    if (targetCoordinate.length === 1) {
      const flatAliasKey = coordinateKey([0, targetCoordinate[0]!]);
      if (!coordinateIndex.has(flatAliasKey)) {
        coordinateIndex.set(flatAliasKey, turnIndex);
      }
    }
  };

  if (typeof turn === "string" && turn.trim().length > 0) {
    rememberCoordinate();
    turns.push({ role: "user", content: turn });
    return true;
  }

  if (!isPlainObject(turn)) {
    return false;
  }

  const directMessage = parseDirectMessageTurn(turn);
  if (directMessage) {
    rememberCoordinate();
    turns.push(directMessage);
    return true;
  }

  const speaker = typeof turn.speaker === "string" ? turn.speaker : undefined;
  const text = typeof turn.text === "string"
    ? turn.text
    : typeof turn.content === "string"
      ? turn.content
      : typeof turn.message === "string"
        ? turn.message
        : undefined;
  const userText = firstString(turn.user, turn.user_message);
  const assistantText = firstString(turn.agent, turn.assistant, turn.assistant_message);
  if (userText || assistantText) {
    if (userText) {
      rememberCoordinate();
      rememberCoordinate(pairedTurnCoordinate(coordinate, 0));
      turns.push({ role: "user", content: userText });
    }
    if (assistantText) {
      rememberCoordinate(
        userText ? pairedTurnCoordinate(coordinate, 1) : coordinate,
      );
      turns.push({ role: "assistant", content: assistantText });
    }
    return true;
  }
  if (!speaker || !text) {
    return false;
  }

  let role = speakerRoles.get(speaker);
  if (!role) {
    role = nextSpeakerIndex() === 0 ? "user" : "assistant";
    speakerRoles.set(speaker, role);
  }

  rememberCoordinate();
  turns.push({ role, content: text });
  return true;
}

function parseDirectMessageTurn(turn: Record<string, unknown>): Message | null {
  const { role, content } = turn;
  if ((role === "user" || role === "assistant") && typeof content === "string") {
    return { role, content };
  }
  return null;
}

function normalizeQaPairs(
  qa: unknown[],
  location: string,
  coordinateIndex?: Map<string, number>,
): MemBenchQuestionAnswer[] {
  const pairs: MemBenchQuestionAnswer[] = [];

  for (let index = 0; index < qa.length; index += 1) {
    const item = qa[index];
    if (!isPlainObject(item)) {
      continue;
    }

    const question = firstString(item.question, item.query, item.prompt);
    const choices = parseChoices(item.choices ?? item.options, `${location}[${index}].choices`);
    const rawAnswer = firstString(
      item.answer,
      item.expected,
      item.gold,
      item.reference,
      item.label,
      item.correct_choice,
    );
    const correctChoice = parseCorrectChoice(
      item.correctChoice ?? item.correct_choice,
      rawAnswer,
      choices,
      `${location}[${index}]`,
    );
    const answer = choices && correctChoice
      ? choices[correctChoice]
      : rawAnswer;
    if (!question || !answer) {
      continue;
    }

    const id = firstString(item.id, item.qid, item.question_id);
    const targetRefSource = resolveTargetRefSource(item);
    pairs.push({
      id: id ?? undefined,
      question,
      answer,
      choices: choices ?? undefined,
      correctChoice: correctChoice ?? undefined,
      questionTime: firstString(item.time, item.question_time, item.questionTime) ?? undefined,
      ...parseTargetStepRefs(targetRefSource?.value, coordinateIndex, {
        treatSingleArrayAsCoordinate: targetRefSource?.kind === "coordinates"
          || targetRefSource?.treatSingleArrayAsCoordinate === true,
        fallbackArrayTupleToIds: targetRefSource?.fallbackArrayTupleToIds === true,
      }),
    });
  }

  return pairs;
}

function resolveTargetRefSource(
  item: Record<string, unknown>,
): {
  value: unknown;
  kind: "ids" | "coordinates";
  treatSingleArrayAsCoordinate?: boolean;
  fallbackArrayTupleToIds?: boolean;
} | undefined {
  if (hasUsableTargetIdRef(item.target_step_id)) {
    return {
      value: item.target_step_id,
      kind: "ids",
      treatSingleArrayAsCoordinate: Array.isArray(item.target_step_id),
      fallbackArrayTupleToIds: true,
    };
  }
  if (hasUsableTargetIdRef(item.target_step_ids)) {
    return { value: item.target_step_ids, kind: "ids" };
  }
  if (hasUsableTargetIdRef(item.targetStepIds)) {
    return { value: item.targetStepIds, kind: "ids" };
  }
  if (hasUsableTargetRef(item.target_step_coordinates)) {
    return { value: item.target_step_coordinates, kind: "coordinates" };
  }
  if (hasUsableTargetRef(item.targetStepCoordinates)) {
    return { value: item.targetStepCoordinates, kind: "coordinates" };
  }
  if (hasUsableTargetRef(item.target_step_coordinate)) {
    return { value: item.target_step_coordinate, kind: "coordinates" };
  }
  if (hasUsableTargetRef(item.targetStepCoordinate)) {
    return { value: item.targetStepCoordinate, kind: "coordinates" };
  }
  return undefined;
}

function hasUsableTargetRef(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return value !== undefined
    && value !== null
    && (!Array.isArray(value) || value.length > 0);
}

function hasUsableTargetIdRef(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every(hasUsableTargetIdRef);
  }
  return normalizeTargetRefPart(value) !== undefined;
}

function resolveCaseId(
  record: Record<string, unknown>,
  location: string,
  index: number,
): string {
  return firstString(record.id, record.case_id, record.sample_id)
    ?? `${sanitizeCaseId(location)}-${index}`;
}

function resolveMemoryType(
  value: unknown,
  hints: MemBenchHints,
): MemBenchCase["memoryType"] {
  const normalized = normalizeLabel(value);
  if (normalized.includes("reflective") || normalized.includes("highlevel")) {
    return "reflective";
  }
  if (normalized.includes("factual") || normalized.includes("lowlevel")) {
    return "factual";
  }
  return hints.memoryType ?? "factual";
}

function resolveScenario(
  value: unknown,
  hints: MemBenchHints,
): MemBenchCase["scenario"] {
  const normalized = normalizeLabel(value);
  if (normalized.includes("participant") || normalized.includes("participation") || normalized.includes("firstagent")) {
    return "participant";
  }
  if (normalized.includes("observation") || normalized.includes("thirdagent")) {
    return "observation";
  }
  return hints.scenario ?? "participant";
}

function resolveLevel(value: unknown, hints: MemBenchHints): string {
  const direct = typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
  return direct ?? hints.level ?? "published";
}

function inferHintsFromLabel(
  label: string,
  current: MemBenchHints,
): MemBenchHints {
  const normalized = normalizeLabel(label);
  const next: MemBenchHints = { ...current };

  if (
    normalized.includes("firstagent")
    || normalized.includes("participation")
    || normalized.includes("participant")
  ) {
    next.scenario = "participant";
  } else if (
    normalized.includes("thirdagent")
    || normalized.includes("observation")
  ) {
    next.scenario = "observation";
  }

  if (
    normalized.includes("highlevel")
    || normalized.includes("reflective")
  ) {
    next.memoryType = "reflective";
    next.level ??= "high_level";
  } else if (
    normalized.includes("lowlevel")
    || normalized.includes("factual")
  ) {
    next.memoryType = "factual";
    next.level ??= "low_level";
  }

  return next;
}

function normalizeLabel(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function sanitizeCaseId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-80);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function parseTurn(turn: unknown, location: string): Message {
  if (!isPlainObject(turn)) {
    throw new Error(`MemBench turn ${location} must be an object.`);
  }

  const { role, content } = turn;
  if ((role !== "user" && role !== "assistant") || typeof content !== "string") {
    throw new Error(
      `MemBench turn ${location} must include role/content fields compatible with bench messages.`,
    );
  }

  return { role, content };
}

function buildQuestionPrompt(testCase: MemBenchCase): string {
  if (!testCase.choices) {
    if (isRecommendationQuestion(testCase.question)) {
      return [
        "Answer the MemBench question using only the recalled memory context.",
        "Return only the exact recommended item, option, category, person, place, or phrase that answers the question.",
        "Do not include explanation, hedging, or surrounding sentence text.",
        "",
        `Question: ${testCase.question}`,
      ].join("\n");
    }
    return testCase.question;
  }

  const scenarioInstruction = testCase.scenario === "observation"
    ? "Please answer the following question based on past memories of the user's messages."
    : "Please answer the following question based on past memories of your conversation with the user.";
  const timePrefix = testCase.questionTime
    ? `(current time is ${testCase.questionTime}) `
    : "";

  return [
    scenarioInstruction,
    `Question: ${timePrefix}${testCase.question}`,
    "Choices:",
    `A. ${testCase.choices.A}`,
    `B. ${testCase.choices.B}`,
    `C. ${testCase.choices.C}`,
    `D. ${testCase.choices.D}`,
    "Please output the correct option for the question, only one corresponding letter, without any other messages.",
    "Example: D",
  ].join("\n");
}

function buildRecallQuery(testCase: MemBenchCase): string {
  const baseQuery = testCase.questionTime
    ? `${testCase.question} (${testCase.questionTime})`
    : testCase.question;
  if (!isRecommendationQuestion(testCase.question)) {
    return baseQuery;
  }
  return [
    baseQuery,
    "Retrieve the exact recommendation, suggestion, preference, chosen option, and concrete named item from memory.",
  ].join(" ");
}

function buildStoredTurns(testCase: MemBenchCase): Message[] {
  return testCase.turns.map((message, index) => ({
    ...message,
    content: appendMemBenchSemanticCue(
      appendMemBenchStepAnchor(message.content, index),
      testCase,
    ),
  }));
}

function appendMemBenchStepAnchor(content: string, index: number): string {
  return [
    content,
    `MemBench turn anchors: step ${index}; step_id=${index}; turn ${index}; turn_id=${index}; message ${index}; message_id=${index}.`,
  ].join("\n");
}

function stripMemBenchStepAnchors(content: string): string {
  return content
    .split("\n")
    .filter((line) =>
      !line.startsWith("MemBench turn anchors:")
      && !line.startsWith("MemBench semantic cues:"),
    )
    .join("\n")
    .trim();
}

function appendMemBenchSemanticCue(
  content: string,
  testCase: MemBenchCase,
): string {
  if (!isRecommendationQuestion(testCase.question)) {
    return content;
  }
  return [
    content,
    "MemBench semantic cues: recommendation; suggestion; preference; chosen option; exact answer candidate; preserve concrete named items and categories.",
  ].join("\n");
}

function isRecommendationQuestion(question: string): boolean {
  return /\b(?:recommend|recommendation|suggest|suggestion|prefer|preference|favorite|choice|option|should i|would i|do i usually)\b/i.test(question);
}

function extractChoice(
  answer: string,
  choices?: Record<MemBenchChoice, string>,
): MemBenchChoice | undefined {
  const trimmed = answer.trim();
  const direct = normalizeChoice(trimmed);
  if (direct) {
    return direct;
  }

  const jsonChoice = trimmed.match(/"choice"\s*:\s*"([ABCD])"/i);
  if (jsonChoice?.[1]) {
    return jsonChoice[1].toUpperCase() as MemBenchChoice;
  }

  const leadingMarker = trimmed.match(
    /^\s*(?:(?:OPTION|CHOICE)\s*)?\(?([ABCD])\)?(?:[.)]|:)\s*/i,
  );
  if (leadingMarker?.[1]) {
    return leadingMarker[1].toUpperCase() as MemBenchChoice;
  }

  const answerMarkers = [
    ...trimmed.matchAll(
      /(?:FINAL\s+ANSWER|ANSWER|CHOICE|OPTION)\s*(?:IS|:|-)?\s*\(?([ABCD])\)?\b/gi,
    ),
  ].map((match) => match[1].toUpperCase() as MemBenchChoice);
  if (answerMarkers.length > 0) {
    return answerMarkers.at(-1);
  }

  if (choices) {
    const normalizedAnswer = normalizeComparableForChoiceText(trimmed);
    const matchingChoices = (Object.entries(choices) as Array<[MemBenchChoice, string]>)
      .filter(([, choiceText]) => {
        const normalizedChoice = normalizeComparableForChoiceText(choiceText);
        if (!normalizedChoice) return false;
        return ` ${normalizedAnswer} `.includes(` ${normalizedChoice} `);
      })
      .map(([choice]) => choice);
    if (matchingChoices.length === 1) {
      return matchingChoices[0];
    }
  }

  return undefined;
}

async function scoreRecallAt10(
  system: ResolvedRunBenchmarkOptions["system"],
  sessionId: string,
  testCase: MemBenchCase,
): Promise<number | undefined> {
  if (!testCase.targetStepIds || testCase.targetStepIds.length === 0) {
    return undefined;
  }

  try {
    const results = await system.search(
      buildRecallQuery(testCase),
      10,
      sessionId,
    );
    const relevant = new Set(testCase.targetStepIds);
    const retrieved = new Set(
      results
        .map((result) => result.turnIndex)
        .filter((turnIndex) => relevant.has(turnIndex)),
    );
    return retrieved.size / relevant.size;
  } catch {
    return -1;
  }
}

function aggregateMemBenchOfficialBreakdowns(
  tasks: TaskResult[],
): ReturnType<typeof aggregateTaskScores> {
  const metrics: Array<[string, (task: TaskResult) => boolean]> = [
    ["membench_accuracy_factual_participant", (task) =>
      task.details?.memoryType === "factual" && task.details?.scenario === "participant"],
    ["membench_accuracy_factual_observation", (task) =>
      task.details?.memoryType === "factual" && task.details?.scenario === "observation"],
    ["membench_accuracy_reflective_participant", (task) =>
      task.details?.memoryType === "reflective" && task.details?.scenario === "participant"],
    ["membench_accuracy_reflective_observation", (task) =>
      task.details?.memoryType === "reflective" && task.details?.scenario === "observation"],
  ];
  const breakdownScores = metrics
    .flatMap(([metricName, predicate]) => {
      const categoryTasks = tasks.filter(predicate);
      const accuracyScores = categoryTasks
        .map((task) => task.scores.membench_accuracy)
        .filter((score): score is number => typeof score === "number" && score >= 0)
        .map((score) => ({ [metricName]: score }));
      const errorMetricName = metricName.replace(
        "membench_accuracy_",
        "membench_error_rate_",
      );
      const errorScores = categoryTasks
        .filter((task) => typeof task.scores.membench_accuracy === "number")
        .map((task) => ({
          [errorMetricName]: task.scores.membench_accuracy < 0 ? 1 : 0,
        }));
      return [...accuracyScores, ...errorScores];
    });

  return aggregateTaskScores(breakdownScores);
}

function parseChoices(
  choices: unknown,
  location: string,
): Record<MemBenchChoice, string> | undefined {
  if (Array.isArray(choices)) {
    const parsedArray = choices.map((choice) => firstString(choice));
    if (parsedArray.length === 0) {
      return undefined;
    }
    if (parsedArray.length !== 4 || parsedArray.some((choice) => !choice)) {
      throw new Error(
        `MemBench choices ${location} must include exactly four non-empty options when provided as an array.`,
      );
    }
    return {
      A: parsedArray[0]!,
      B: parsedArray[1]!,
      C: parsedArray[2]!,
      D: parsedArray[3]!,
    };
  }

  if (!isPlainObject(choices)) {
    return undefined;
  }

  const parsed = {
    A: firstString(choices.A, choices.a),
    B: firstString(choices.B, choices.b),
    C: firstString(choices.C, choices.c),
    D: firstString(choices.D, choices.d),
  };

  if (!parsed.A && !parsed.B && !parsed.C && !parsed.D) {
    return undefined;
  }
  if (!parsed.A || !parsed.B || !parsed.C || !parsed.D) {
    throw new Error(
      `MemBench choices ${location} must include non-empty A, B, C, and D options.`,
    );
  }

  return parsed as Record<MemBenchChoice, string>;
}

function parseCorrectChoice(
  directChoice: unknown,
  answer: unknown,
  choices: Record<MemBenchChoice, string> | undefined,
  location: string,
): MemBenchChoice | undefined {
  if (!choices) {
    return undefined;
  }

  const normalizedDirect = normalizeChoice(directChoice);
  if (normalizedDirect) {
    return normalizedDirect;
  }

  const normalizedAnswer = normalizeChoice(answer);
  if (normalizedAnswer) {
    return normalizedAnswer;
  }

  const answerText = firstString(answer);
  if (!answerText) {
    throw new Error(
      `MemBench case ${location} includes choices but no answer or correct choice.`,
    );
  }

  const matchingChoices = (Object.entries(choices) as Array<[MemBenchChoice, string]>)
    .filter(([, value]) => normalizeComparable(value) === normalizeComparable(answerText))
    .map(([choice]) => choice);
  if (matchingChoices.length === 1) {
    return matchingChoices[0];
  }

  throw new Error(
    `MemBench case ${location} includes choices but answer does not identify exactly one option.`,
  );
}

function normalizeChoice(value: unknown): MemBenchChoice | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  return /^[ABCD]$/.test(normalized) ? normalized as MemBenchChoice : undefined;
}

function normalizeComparable(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeComparableForChoiceText(value: string): string {
  return normalizeComparable(value)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function memBenchExactAnswerMatch(predicted: string, expected: string): number {
  return normalizeMemBenchExactAnswer(predicted) === normalizeMemBenchExactAnswer(expected)
    ? 1
    : 0;
}

function normalizeMemBenchExactAnswer(value: string): string {
  return trimTrailingSentencePunctuation(normalizeComparable(value));
}

function trimTrailingSentencePunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && isTerminalSentencePunctuation(value[end - 1]!)) {
    end -= 1;
  }
  return value.slice(0, end).trim();
}

function isTerminalSentencePunctuation(value: string): boolean {
  return (
    value === "."
    || value === "!"
    || value === "?"
    || value === ","
    || value === ";"
    || value === ":"
  );
}

function parseTargetStepRefs(
  value: unknown,
  coordinateIndex?: Map<string, number>,
  options: {
    treatSingleArrayAsCoordinate?: boolean;
    fallbackArrayTupleToIds?: boolean;
  } = {},
): {
  targetStepIds?: number[];
  targetStepCoordinates?: number[][];
} {
  if (options.treatSingleArrayAsCoordinate && value !== undefined && !Array.isArray(value)) {
    return {};
  }

  const rawValues = Array.isArray(value)
    ? options.treatSingleArrayAsCoordinate
      ? isCoordinateTuple(value) || !value.every(Array.isArray)
        ? [value]
        : value
      : value
    : value === undefined
      ? []
      : [value];
  const coordinates = rawValues
    .filter(Array.isArray)
    .map(parseCoordinateTuple)
    .filter((items): items is number[] => items !== undefined);
  const candidates = new Set<number>();
  for (const item of rawValues) {
    const scalar = normalizeTargetRefPart(item);
    if (scalar !== undefined) {
      candidates.add(scalar);
    } else if (Array.isArray(item)) {
      const numeric = options.treatSingleArrayAsCoordinate
        ? parseCoordinateTuple(item)
        : item
          .map(normalizeTargetRefPart)
          .filter((part): part is number => part !== undefined);
      if (!numeric) {
        continue;
      }
      if (numeric.length >= 2) {
        const mapped = coordinateIndex?.get(coordinateKey(numeric));
        if (mapped !== undefined) {
          candidates.add(mapped);
        } else if (options.fallbackArrayTupleToIds) {
          numeric.forEach((part) => candidates.add(part));
        }
      } else if (numeric.length === 1) {
        const mapped = coordinateIndex?.get(coordinateKey(numeric));
        if (mapped !== undefined) {
          candidates.add(mapped);
        } else if (!options.treatSingleArrayAsCoordinate || options.fallbackArrayTupleToIds) {
          candidates.add(numeric[0]!);
        }
      }
    }
  }

  const ids = [...candidates].sort((left, right) => left - right);
  return {
    targetStepIds: ids.length > 0 ? ids : undefined,
    targetStepCoordinates: coordinates.length > 0 ? coordinates : undefined,
  };
}

function normalizeTargetRefPart(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

function isCoordinateTuple(value: unknown[]): boolean {
  return parseCoordinateTuple(value) !== undefined;
}

function parseCoordinateTuple(value: unknown[]): number[] | undefined {
  const parsed = value.map(normalizeTargetRefPart);
  if (parsed.length === 0 || parsed.some((item) => item === undefined)) {
    return undefined;
  }
  return parsed as number[];
}

function coordinateKey(coordinate: number[]): string {
  return coordinate.join(":");
}

function buildFlatCoordinateIndex(turnCount: number): Map<string, number> {
  const index = new Map<string, number>();
  for (let turnIndex = 0; turnIndex < turnCount; turnIndex += 1) {
    index.set(coordinateKey([turnIndex]), turnIndex);
    index.set(coordinateKey([0, turnIndex]), turnIndex);
  }
  return index;
}

function pairedTurnCoordinate(coordinate: number[], sideIndex: 0 | 1): number[] {
  return [...coordinate, sideIndex];
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(
      `MemBench limit must be a non-negative integer when provided; received ${limit}.`,
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
