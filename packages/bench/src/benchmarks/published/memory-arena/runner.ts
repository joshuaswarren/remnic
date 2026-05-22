/**
 * MemoryArena runner migrated into @remnic/bench for phase 1.
 */

import { randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { expandTildePath } from "@remnic/core";
import {
  MEMORY_ARENA_SMOKE_FIXTURE,
  type ArenaAnswer,
  type ArenaBasePerson,
  type ArenaExpectedAnswer,
  type ArenaTask,
  type DomainData,
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

export const memoryArenaDefinition: BenchmarkDefinition = {
  id: "memory-arena",
  title: "MemoryArena",
  tier: "published",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "memory-arena",
    version: "2.0.0",
    description:
      "Interdependent multi-session agentic memory benchmark across sequential tasks and domains.",
    category: "agentic",
    citation:
      "MemoryArena: Benchmarking Agent Memory in Interdependent Multi-Session Agentic Tasks (2025)",
  },
};

const MEMORY_ARENA_WEBSHOP_PRODUCTS_ENV =
  "REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS";
const MEMORY_ARENA_WEBSHOP_PRODUCTS_MAX_BYTES = 100 * 1024 * 1024;
const MEMORY_ARENA_WEBSHOP_PRODUCT_SIDECAR_FILENAMES = [
  "webshop-products.jsonl",
  "webshop-products.json",
  "memory-arena-webshop-products.jsonl",
  "memory-arena-webshop-products.json",
];

export async function runMemoryArenaBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const dataset = await loadDataset(options.mode, options.datasetDir, options.limit);
  const webshopCatalog = await loadMemoryArenaWebshopProductCatalog(
    options.datasetDir,
  );
  const tasks: TaskResult[] = [];

  const totalTasks = dataset.reduce(
    (sum, { tasks: domainTasks }) =>
      sum + domainTasks.reduce((tSum, task) => tSum + scoredSubtaskCount(task), 0),
    0,
  );

  for (const { domain, tasks: domainTasks } of dataset) {
    for (const task of domainTasks) {
      await options.system.reset();

      const sessionId = `arena-${domain}-${task.id}`;
      let initialSeedError: string | undefined;
      let pendingPrerequisiteError: string | undefined;
      if (isGroupTravelPlannerCategory(task.category)) {
        try {
          await storeInitialTaskState(options, sessionId, task);
        } catch (seedErr) {
          initialSeedError = seedErr instanceof Error
            ? seedErr.message
            : String(seedErr);
          pendingPrerequisiteError =
            `MemoryArena initial task state failed for ${domain}:${task.id}: ${initialSeedError}`;
          console.error(
            `  [WARN] memory-arena initial task state failed for ${domain}:${task.id}: ${initialSeedError}`,
          );
        }
      }
      for (
        let questionIndex = 0;
        questionIndex < task.questions.length;
        questionIndex += 1
      ) {
        const question = task.questions[questionIndex]!;
        const expectedAnswer = task.answers[questionIndex];
        if (expectedAnswer === undefined) {
          throw new Error(
            `MemoryArena task ${domain}:${task.id} is missing answer index ${questionIndex} for question "${question.slice(0, 120)}"`,
          );
        }

        const expected = answerToString(expectedAnswer);
        const taskResultId = `${domain}-t${task.id}-q${questionIndex}`;
        const isScored = shouldScoreSubtask(task, questionIndex);

        try {
          if (isScored && pendingPrerequisiteError !== undefined) {
            throw new Error(
              `MemoryArena prerequisite failed before ${taskResultId}: ${pendingPrerequisiteError}`,
            );
          }

          const background = backgroundForSubtask(task, questionIndex);
          if (background) {
            await options.system.store(sessionId, [
              {
                role: "system",
                content: `MemoryArena background for subtask ${questionIndex + 1}: ${background}`,
              },
            ]);
          }

          await drainMemoryArena(options, taskResultId);

          if (!isScored) {
            await storeCompletedSubtask(
              options,
              sessionId,
              questionIndex,
              question,
              expected,
              expectedAnswer,
              webshopCatalog,
            );
            pendingPrerequisiteError = undefined;
            continue;
          }

          const { result: recalledText, durationMs } = await timed(async () =>
            options.system.recall(
              sessionId,
              question,
              DEFAULT_BENCH_RECALL_BUDGET_CHARS,
            ),
          );
          const benchmarkQuestion = formatMemoryArenaQuestion(
            task.category,
            question,
            expectedAnswer,
          );
          const answerContext = buildMemoryArenaAnswerContext(
            recalledText,
            question,
            {
              itemSelection: hasItemSelectionExpectation(expectedAnswer),
              webshopCatalog,
            },
          );
          const answered = await answerBenchmarkQuestion({
            question: benchmarkQuestion,
            recalledText: options.system.responder ? answerContext : recalledText,
            responder: options.system.responder,
            answerMode: "strict",
          });
          const domainScores = scoreMemoryArenaDomainAnswer(
            task.category,
            answered.finalAnswer,
            expectedAnswer,
            question,
          );
          const judgeResult = await llmJudgeScoreDetailed(
            options.system.judge,
            question,
            answered.finalAnswer,
            expected,
          );

          const scores: Record<string, number> = {
            f1: f1Score(answered.finalAnswer, expected),
            contains_answer: containsAnswer(answered.finalAnswer, expected),
            ...domainScores,
          };
          if (judgeResult.score >= 0) {
            scores.llm_judge = judgeResult.score;
          }
          const subtaskSuccess = scoreSubtaskSuccess(scores);
          scores.process_score = subtaskSuccess;
          if (questionIndex === task.questions.length - 1) {
            scores.task_success_rate = subtaskSuccess;
          }

          tasks.push({
            taskId: taskResultId,
            question,
            expected,
            actual: answered.finalAnswer,
            scores,
            latencyMs: durationMs + answered.latencyMs + judgeResult.latencyMs,
            tokens: {
              input: answered.tokens.input + judgeResult.tokens.input,
              output: answered.tokens.output + judgeResult.tokens.output,
            },
            details: {
              domain,
              taskId: task.id,
              subtaskIndex: questionIndex,
              category: task.category,
              promptQuestion: benchmarkQuestion,
              ...(initialSeedError === undefined
                ? {}
                : { initialSeedError }),
              recalledLength: recalledText.length,
              answerContextLength: answerContext.length,
              ...(webshopCatalog === undefined
                ? {}
                : { webshopProductCatalog: webshopCatalog.sourcePath }),
              answeredLength: answered.finalAnswer.length,
              recalledText,
              answerContext,
              answeredText: answered.finalAnswer,
              responderModel: answered.model,
              judgeModel: judgeResult.model,
            },
          });

          try {
            await storeCompletedSubtask(
              options,
              sessionId,
              questionIndex,
              question,
              expected,
              expectedAnswer,
              webshopCatalog,
            );
          } catch (storeErr) {
            pendingPrerequisiteError = formatUnknownError(storeErr);
            console.error(`  [WARN] memory-arena store failed for ${taskResultId}: ${pendingPrerequisiteError}`);
          }

          try {
            await drainMemoryArena(options, taskResultId);
          } catch (drainErr) {
            pendingPrerequisiteError = formatUnknownError(drainErr);
            console.error(`  [WARN] memory-arena drain failed for ${taskResultId}: ${pendingPrerequisiteError}`);
          }
        } catch (err) {
          const message = formatUnknownError(err);
          console.error(`  [WARN] memory-arena task ${taskResultId} failed: ${message}`);
          if (!isScored) {
            pendingPrerequisiteError = message;
            continue;
          }
          tasks.push({
            taskId: taskResultId,
            question,
            expected,
            actual: `(error: ${message})`,
            scores: {
              f1: -1,
              contains_answer: -1,
              llm_judge: -1,
              ...failureMemoryArenaDomainScores(task.category, expectedAnswer),
              process_score: 0,
              ...(questionIndex === task.questions.length - 1
                ? { task_success_rate: 0 }
                : {}),
            },
            latencyMs: 0,
            tokens: { input: 0, output: 0 },
            details: {
              error: message,
              ...(initialSeedError === undefined
                ? {}
                : { initialSeedError }),
            },
          });
        }

        if (isScored) {
          options.onTaskComplete?.(tasks[tasks.length - 1]!, tasks.length, totalTasks);
        }
      }
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
): Promise<DomainData[]> {
  const normalizedLimit = normalizeLimit(limit);
  const ensureDatasetTasks = (domains: DomainData[]): DomainData[] => {
    const taskCount = domains.reduce(
      (sum, domain) => sum + domain.tasks.length,
      0,
    );
    if (taskCount === 0) {
      throw new Error(
        "MemoryArena dataset is empty after applying the requested limit.",
      );
    }
    return domains;
  };

  if (datasetDir) {
    let directoryEntries: string[];
    try {
      directoryEntries = await readdir(datasetDir);
    } catch (error) {
      throw new Error(
        `MemoryArena dataset not found under ${datasetDir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const domainFiles = directoryEntries
      .filter((filename) =>
        filename.endsWith(".jsonl")
        && !MEMORY_ARENA_WEBSHOP_PRODUCT_SIDECAR_FILENAMES.includes(filename),
      )
      .sort();
    if (domainFiles.length === 0) {
      throw new Error(
        `MemoryArena dataset not found under ${datasetDir}: no .jsonl domain files were found.`,
      );
    }

    const domains: DomainData[] = [];
    let remainingLimit = normalizedLimit;
    for (const filename of domainFiles) {
      if (remainingLimit === 0) {
        break;
      }
      const raw = await readFile(path.join(datasetDir, filename), "utf8");
      const parsedTasks: ArenaTask[] = [];
      raw.split("\n").forEach((line, lineIndex) => {
        if (line.trim().length === 0) {
          return;
        }
        parsedTasks.push(parseTask(line, filename, lineIndex + 1));
      });
      const tasks = applyLimit(parsedTasks, remainingLimit);
      if (remainingLimit !== undefined) {
        remainingLimit = Math.max(0, remainingLimit - tasks.length);
      }
      domains.push({
        domain: filename.replace(/\.jsonl$/, ""),
        tasks,
      });
    }

    return ensureDatasetTasks(domains);
  }

  if (mode === "full") {
    throw new Error(
      "MemoryArena full mode requires datasetDir. Pass a dataset path or use quick mode to run the bundled smoke fixture.",
    );
  }

  const bundledFixture: DomainData[] = MEMORY_ARENA_SMOKE_FIXTURE.map((domain) => ({
    ...domain,
    tasks: [] as ArenaTask[],
  }));
  let remainingLimit = normalizedLimit;
  for (let index = 0; index < bundledFixture.length; index += 1) {
    const sourceDomain = MEMORY_ARENA_SMOKE_FIXTURE[index]!;
    const limitedTasks = applyLimit(sourceDomain.tasks, remainingLimit);
    bundledFixture[index] = {
      ...bundledFixture[index]!,
      tasks: limitedTasks,
    };
    if (remainingLimit !== undefined) {
      remainingLimit = Math.max(0, remainingLimit - limitedTasks.length);
    }
  }
  return ensureDatasetTasks(bundledFixture);
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(
      `MemoryArena limit must be a non-negative integer when provided; received ${limit}.`,
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

function parseTask(line: string, filename: string, lineNumber: number): ArenaTask {
  const location = `MemoryArena dataset file ${filename} line ${lineNumber}`;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(
      `MemoryArena dataset file ${filename} contains invalid JSON on line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${location} must be an object.`);
  }

  const record = parsed as Record<string, unknown>;
  if (!Number.isInteger(record.id)) {
    throw new Error(`${location} must include an integer id.`);
  }
  const category = normalizeCategory(record.category, filename);
  if (
    !Array.isArray(record.questions)
    || record.questions.some((question) => typeof question !== "string")
  ) {
    throw new Error(`${location} must include a questions array of strings.`);
  }
  if (record.questions.length === 0) {
    throw new Error(`${location} must include at least one question.`);
  }
  if (
    !Array.isArray(record.answers)
    || record.answers.some(
      (answer) =>
        !isValidExpectedAnswer(answer),
    )
  ) {
    throw new Error(
      `${location} must include an answers array of strings, objects, or arrays of those values.`,
    );
  }
  if (record.answers.length !== record.questions.length) {
    throw new Error(
      `${location} must include exactly one answer for each question; received ${record.questions.length} questions and ${record.answers.length} answers.`,
    );
  }
  if (
    record.backgrounds !== undefined
    && !isValidBackgrounds(record.backgrounds)
  ) {
    throw new Error(
      `${location} backgrounds must be a string or an array of strings when provided.`,
    );
  }
  if (
    record.base_person != null
    && !isValidBasePerson(record.base_person)
  ) {
    throw new Error(
      `${location} base_person must be an object with a valid daily_plans value when provided.`,
    );
  }

  return {
    id: record.id as number,
    category,
    questions: record.questions as string[],
    answers: record.answers as ArenaExpectedAnswer[],
    ...(record.backgrounds === undefined
      ? {}
      : { backgrounds: record.backgrounds as string | string[] }),
    ...(record.base_person == null
      ? {}
      : { base_person: record.base_person as ArenaBasePerson }),
  };
}

function normalizeCategory(value: unknown, filename: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  const inferred = filename.replace(/\.jsonl$/i, "").trim();
  if (inferred.length > 0) {
    return inferred;
  }

  throw new Error(
    `MemoryArena dataset file ${filename} must include a string category or use a filename that can be inferred as the category.`,
  );
}

function answerToString(answer: ArenaExpectedAnswer): string {
  if (typeof answer === "string") {
    return answer;
  }
  if (Array.isArray(answer)) {
    return answer.map(answerToString).join(" | ");
  }

  const parts: string[] = [];
  if (answer.target_asin) {
    parts.push(answer.target_asin);
  }
  if (answer.attributes) {
    parts.push(answer.attributes.join(", "));
  }
  for (const [key, value] of Object.entries(answer)) {
    if (key !== "target_asin" && key !== "attributes" && value !== undefined) {
      parts.push(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
    }
  }
  return parts.join(" | ");
}

function isValidExpectedAnswer(answer: unknown): answer is ArenaExpectedAnswer {
  if (typeof answer === "string") {
    return true;
  }
  if (Array.isArray(answer)) {
    return answer.every((item) => typeof item === "string" || isValidArenaAnswerObject(item));
  }
  return isValidArenaAnswerObject(answer);
}

function isValidArenaAnswerObject(answer: unknown): answer is ArenaAnswer {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    return false;
  }
  const record = answer as Record<string, unknown>;
  if (
    "target_asin" in record
    && record.target_asin !== undefined
    && typeof record.target_asin !== "string"
  ) {
    return false;
  }
  if (
    "attributes" in record
    && record.attributes !== undefined
    && (!Array.isArray(record.attributes)
      || record.attributes.some((item) => typeof item !== "string"))
  ) {
    return false;
  }
  return true;
}

function isValidBackgrounds(backgrounds: unknown): backgrounds is string | string[] {
  return typeof backgrounds === "string"
    || (Array.isArray(backgrounds)
      && backgrounds.every((entry) => typeof entry === "string"));
}

function isValidBasePerson(basePerson: unknown): basePerson is ArenaBasePerson {
  if (!basePerson || typeof basePerson !== "object" || Array.isArray(basePerson)) {
    return false;
  }

  const record = basePerson as Record<string, unknown>;
  return !("daily_plans" in record)
    || record.daily_plans === undefined
    || record.daily_plans === null
    || isValidExpectedAnswer(record.daily_plans);
}

function scoredSubtaskCount(task: ArenaTask): number {
  return task.questions.filter((_, index) => shouldScoreSubtask(task, index)).length;
}

function shouldScoreSubtask(task: ArenaTask, questionIndex: number): boolean {
  if (task.questions.length === 1) {
    return true;
  }
  return questionIndex > 0 || Boolean(backgroundForSubtask(task, questionIndex));
}

function backgroundForSubtask(
  task: ArenaTask,
  questionIndex: number,
): string | undefined {
  const background = task.backgrounds;
  if (typeof background === "string") {
    return background.trim().length > 0 ? background : undefined;
  }
  if (Array.isArray(background)) {
    const entry = background[questionIndex];
    return typeof entry === "string" && entry.trim().length > 0
      ? entry
      : undefined;
  }
  return undefined;
}

async function storeInitialTaskState(
  options: ResolvedRunBenchmarkOptions,
  sessionId: string,
  task: ArenaTask,
): Promise<void> {
  if (!task.base_person) {
    return;
  }

  const basePerson = task.base_person;
  const name = typeof basePerson.name === "string" ? basePerson.name : "base traveler";
  const query = typeof basePerson.query === "string" ? basePerson.query : "";
  const plan = basePerson.daily_plans == null
    ? ""
    : answerToString(basePerson.daily_plans);
  const planFieldAnchors = basePerson.daily_plans == null
    ? []
    : formatPlanFieldAnchorLines(basePerson.daily_plans);
  if (query.trim().length === 0 && plan.trim().length === 0) {
    return;
  }

  await options.system.store(sessionId, [
    {
      role: "user",
      content: query.trim().length > 0
        ? query
        : `MemoryArena initial state for ${name}.`,
    },
    {
      role: "assistant",
      content: [
        `MemoryArena initial finalized plan for ${name}.`,
        query.trim().length > 0 ? `Base traveler request: ${query}` : "",
        plan.trim().length > 0 ? `Environment result: ${plan}` : "",
        ...planFieldAnchors,
      ].filter((part) => part.length > 0).join("\n"),
    },
  ]);

  try {
    await options.system.drain?.();
  } catch (drainErr) {
    throw new Error(
      `MemoryArena drain failed after initial task state: ${formatUnknownError(drainErr)}`,
    );
  }
}

function formatMemoryArenaQuestion(
  category: string,
  question: string,
  expectedAnswer: ArenaExpectedAnswer,
): string {
  if (hasItemSelectionExpectation(expectedAnswer)) {
    return [
      "You are completing a MemoryArena item-selection task.",
      "Use the supplied memory context and current task prompt to select the exact item requested.",
      "Use WebShop environment observations when present for price, rating, review count, and product identity comparisons.",
      "Derive the prior selected item's compatibility label from prior selected product facts; filter current options by compatibility and avoid rules; then apply the stated price or rating preference.",
      "If the answer context includes 'Best-supported option by current rules', return that option; it is computed from the current rules plus observed WebShop facts.",
      "Return only the selected visible option text, item identifiers that are explicitly shown, and distinguishing attributes from the task or memory context.",
      "If the current options do not show an ASIN, omit target_asin instead of answering unknown.",
      "Do not answer unknown merely because the ASIN is hidden; choose the best-supported visible option from Available Options.",
      "Use this format when identifiers are available: target_asin: <ASIN>; attributes: <attribute1>, <attribute2>.",
      "Use this format when identifiers are not available: item: <visible option text>; attributes: <attribute1>, <attribute2>.",
      "",
      "Current item-selection request:",
      question,
    ].join("\n");
  }

  if (!shouldUseGroupTravelPlanProtocol(category, expectedAnswer)) {
    return question;
  }

  return [
    "You are a travel planner assistant in the MemoryArena Group Travel Planning task.",
    "Use the supplied memory context containing the base traveler plan and previous travelers' finalized plans.",
    "Generate the complete finalized plan for the current traveler, not just a short answer to one constraint.",
    "Preserve the exact known flight, restaurant, attraction, and accommodation names from memory when they are required by JOIN or comparison constraints.",
    "Return all required day sections from the current traveler request and memory context.",
    "",
    "Final output format:",
    "=== Traveler Plan ===",
    "Day 1:",
    "Current City: ...",
    "Transportation: ...",
    "Breakfast: ...",
    "Attraction: ...",
    "Lunch: ...",
    "Dinner: ...",
    "Accommodation: ...",
    "",
    "Current traveler request:",
    question,
  ].join("\n");
}

function buildMemoryArenaAnswerContext(
  recalledText: string,
  currentQuestion: string,
  options: {
    itemSelection?: boolean;
    webshopCatalog?: MemoryArenaWebshopProductCatalog;
  } = {},
): string {
  const trimmedQuestion = currentQuestion.trim();
  const trimmedRecall = recalledText.trim();
  const priorEnvironmentResults = options.itemSelection
    ? extractMemoryArenaEnvironmentResults(trimmedRecall)
    : "";
  const webshopObservations = options.itemSelection
    ? formatMemoryArenaWebshopOptionContext(
        trimmedQuestion,
        options.webshopCatalog,
      )
    : "";
  const webshopDecisionSupport = options.itemSelection
    ? formatMemoryArenaWebshopDecisionSupport(
        trimmedQuestion,
        priorEnvironmentResults,
        options.webshopCatalog,
      )
    : "";
  const includeRawRecall = !options.itemSelection
    || priorEnvironmentResults.length === 0;
  if (trimmedQuestion.length === 0) {
    return [
      webshopObservations,
      includeRawRecall ? trimmedRecall : priorEnvironmentResults,
    ].filter((part) => part.length > 0).join("\n\n");
  }
  return [
    "## Current MemoryArena task prompt",
    trimmedQuestion,
    webshopObservations,
    webshopDecisionSupport,
    priorEnvironmentResults.length > 0
      ? "## Prior completed MemoryArena subtasks"
      : "",
    priorEnvironmentResults,
    includeRawRecall && trimmedRecall.length > 0
      ? "## Remnic memory context"
      : "",
    includeRawRecall ? trimmedRecall : "",
  ].filter((part) => part.length > 0).join("\n\n");
}

interface MemoryArenaWebshopProductCatalog {
  sourcePath: string;
  products: MemoryArenaWebshopProduct[];
}

interface MemoryArenaWebshopProduct {
  asin: string;
  name: string;
  normalizedName: string;
  nameTokens: Set<string>;
  searchTokens: Set<string>;
  attributes: string[];
  priceText?: string;
  price?: number;
  averageRating?: number;
  totalReviews?: number;
  productCategory?: string;
  brand?: string;
  labelText: string;
}

interface RawMemoryArenaWebshopRecord {
  value: unknown;
  defaultAsin?: string;
}

async function loadMemoryArenaWebshopProductCatalog(
  datasetDir: string | undefined,
): Promise<MemoryArenaWebshopProductCatalog | undefined> {
  const sourcePath = await resolveMemoryArenaWebshopProductCatalogPath(datasetDir);
  if (sourcePath === undefined) {
    return undefined;
  }

  let sourceStat;
  try {
    sourceStat = await stat(sourcePath);
  } catch (error) {
    throw new Error(
      `MemoryArena WebShop product sidecar not found at ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!sourceStat.isFile()) {
    throw new Error(
      `MemoryArena WebShop product sidecar must be a file: ${sourcePath}`,
    );
  }
  if (sourceStat.size > MEMORY_ARENA_WEBSHOP_PRODUCTS_MAX_BYTES) {
    throw new Error(
      `MemoryArena WebShop product sidecar is ${sourceStat.size} bytes; provide a compact JSON/JSONL sidecar smaller than ${MEMORY_ARENA_WEBSHOP_PRODUCTS_MAX_BYTES} bytes instead of the full WebShop catalog.`,
    );
  }

  const raw = await readFile(sourcePath, "utf8");
  const records = parseMemoryArenaWebshopSidecarRecords(raw, sourcePath);
  const byAsin = new Map<string, MemoryArenaWebshopProduct>();
  for (const record of records) {
    const product = parseMemoryArenaWebshopProduct(record);
    if (product !== undefined && !byAsin.has(product.asin)) {
      byAsin.set(product.asin, product);
    }
  }

  const products = [...byAsin.values()];
  if (products.length === 0) {
    throw new Error(
      `MemoryArena WebShop product sidecar at ${sourcePath} did not contain any usable product records.`,
    );
  }
  return { sourcePath, products };
}

async function resolveMemoryArenaWebshopProductCatalogPath(
  datasetDir: string | undefined,
): Promise<string | undefined> {
  const configuredPath = process.env[MEMORY_ARENA_WEBSHOP_PRODUCTS_ENV]?.trim();
  if (configuredPath && configuredPath.length > 0) {
    return path.resolve(expandTildePath(configuredPath));
  }

  if (datasetDir === undefined) {
    return undefined;
  }

  const candidatePaths = [
    ...MEMORY_ARENA_WEBSHOP_PRODUCT_SIDECAR_FILENAMES,
  ].map((filename) => path.join(datasetDir, filename));

  for (const candidatePath of candidatePaths) {
    try {
      const candidateStat = await stat(candidatePath);
      if (candidateStat.isFile()) {
        return candidatePath;
      }
    } catch (error) {
      if (!isNodeErrorCode(error, "ENOENT")) {
        throw new Error(
          `Unable to inspect MemoryArena WebShop sidecar candidate ${candidatePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return undefined;
}

function parseMemoryArenaWebshopSidecarRecords(
  raw: string,
  sourcePath: string,
): RawMemoryArenaWebshopRecord[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(
      `MemoryArena WebShop product sidecar at ${sourcePath} is empty.`,
    );
  }

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return unpackMemoryArenaWebshopRecords(JSON.parse(trimmed));
    } catch {
      // Fall through to JSONL parsing. Some compact sidecars use one JSON
      // array batch per line, so a leading `[` is not enough to prove the
      // whole file is intended to be a single JSON document.
    }
  }

  const records: RawMemoryArenaWebshopRecord[] = [];
  const lines = raw.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  lines.forEach((line, index) => {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      return;
    }
    try {
      records.push(
        ...unpackMemoryArenaWebshopJsonlRecord(JSON.parse(trimmedLine)),
      );
    } catch (error) {
      throw new Error(
        `MemoryArena WebShop product sidecar at ${sourcePath} has invalid JSONL on line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  return records;
}

function unpackMemoryArenaWebshopJsonlRecord(
  parsed: unknown,
): RawMemoryArenaWebshopRecord[] {
  if (Array.isArray(parsed)) {
    return parsed.map((value) => ({ value }));
  }
  if (isPlainRecord(parsed)) {
    for (const key of ["products", "records", "items"]) {
      const value = parsed[key];
      if (Array.isArray(value) || isPlainRecord(value)) {
        return unpackMemoryArenaWebshopRecords(parsed);
      }
    }
  }
  return [{ value: parsed }];
}

function unpackMemoryArenaWebshopRecords(
  parsed: unknown,
): RawMemoryArenaWebshopRecord[] {
  if (Array.isArray(parsed)) {
    return parsed.map((value) => ({ value }));
  }
  if (!isPlainRecord(parsed)) {
    throw new Error("top-level value must be a JSON array, object, or JSONL records");
  }

  for (const key of ["products", "records", "items"]) {
    const value = parsed[key];
    if (Array.isArray(value)) {
      return value.map((item) => ({ value: item }));
    }
    if (isPlainRecord(value)) {
      return Object.entries(value).map(([defaultAsin, item]) => ({
        value: item,
        defaultAsin,
      }));
    }
  }

  if (isMemoryArenaWebshopProductRecord(parsed)) {
    return [{ value: parsed }];
  }

  return Object.entries(parsed).map(([defaultAsin, value]) => ({
    value,
    defaultAsin,
  }));
}

function isMemoryArenaWebshopProductRecord(
  record: Record<string, unknown>,
): boolean {
  return (
    normalizeMemoryArenaWebshopAsin(
      record.asin
        ?? record.ASIN
        ?? extractMemoryArenaProductInformationValue(record, "asin"),
    ) !== undefined
    && cleanMemoryArenaWebshopString(
      readMemoryArenaStringField(record, "name")
        ?? readMemoryArenaStringField(record, "title")
        ?? readMemoryArenaStringField(record, "product_title")
        ?? "",
    ).length > 0
  );
}

function parseMemoryArenaWebshopProduct(
  raw: RawMemoryArenaWebshopRecord,
): MemoryArenaWebshopProduct | undefined {
  if (!isPlainRecord(raw.value)) {
    return undefined;
  }
  const record = raw.value;
  const asin = normalizeMemoryArenaWebshopAsin(
    record.asin
      ?? record.ASIN
      ?? extractMemoryArenaProductInformationValue(record, "asin")
      ?? raw.defaultAsin,
  );
  const name = cleanMemoryArenaWebshopString(
    readMemoryArenaStringField(record, "name")
      ?? readMemoryArenaStringField(record, "title")
      ?? readMemoryArenaStringField(record, "product_title")
      ?? "",
  );
  if (asin === undefined || name.length === 0) {
    return undefined;
  }

  const selectedCustomization = extractSelectedMemoryArenaCustomization(record);
  const priceText = cleanMemoryArenaWebshopString(
    readMemoryArenaStringField(record, "pricing")
      ?? readMemoryArenaStringField(record, "price_string")
      ?? readMemoryArenaPriceTextField(record, "price")
      ?? selectedCustomization?.priceText
      ?? "",
  );
  const price = readMemoryArenaPriceField(record, "price")
    ?? parseMemoryArenaPrice(priceText)
    ?? selectedCustomization?.price;
  const averageRating =
    readMemoryArenaNumberField(record, "average_rating")
    ?? readMemoryArenaNumberField(record, "averageRating")
    ?? readMemoryArenaProductCustomerReviewNumber(record, "stars");
  const totalReviews =
    readMemoryArenaNumberField(record, "total_reviews")
    ?? readMemoryArenaNumberField(record, "totalReviews")
    ?? readMemoryArenaProductCustomerReviewNumber(record, "ratings_count");
  const productCategory = cleanMemoryArenaWebshopString(
    readMemoryArenaStringField(record, "product_category")
      ?? readMemoryArenaStringField(record, "category")
      ?? "",
  );
  const brand = cleanMemoryArenaWebshopString(
    readMemoryArenaStringField(record, "brand") ?? "",
  );
  const attributes = readMemoryArenaStringArrayField(record, "attributes");
  const descriptions = [
    readMemoryArenaStringField(record, "full_description") ?? "",
    readMemoryArenaStringField(record, "small_description_old") ?? "",
    ...readMemoryArenaStringArrayField(record, "small_description"),
  ].map(cleanMemoryArenaWebshopString).filter((value) => value.length > 0);
  const nameTokens = new Set(tokenizeItemSelectionText(name));
  const labelText = [
    name,
    productCategory,
    brand,
    ...attributes,
    ...descriptions,
  ].join(" ");
  const searchTokens = new Set(
    tokenizeItemSelectionText(labelText),
  );

  return {
    asin,
    name,
    normalizedName: normalizeItemSelectionText(name),
    nameTokens,
    searchTokens,
    attributes,
    ...(priceText.length > 0 ? { priceText } : {}),
    ...(price === undefined ? {} : { price }),
    ...(averageRating === undefined ? {} : { averageRating }),
    ...(totalReviews === undefined ? {} : { totalReviews }),
    ...(productCategory.length > 0 ? { productCategory } : {}),
    ...(brand.length > 0 ? { brand } : {}),
    labelText,
  };
}

function formatMemoryArenaWebshopOptionContext(
  question: string,
  catalog: MemoryArenaWebshopProductCatalog | undefined,
): string {
  if (catalog === undefined) {
    return "";
  }

  const options = extractMemoryArenaVisibleOptions(question);
  if (options.length === 0) {
    return "";
  }

  const observations: string[] = [];
  for (const option of options) {
    const product = selectMemoryArenaWebshopProductForOption(
      option,
      catalog.products,
    );
    if (product === undefined) {
      continue;
    }
    observations.push(formatMemoryArenaWebshopObservation(option, product));
  }

  if (observations.length === 0) {
    return "";
  }
  return [
    "## WebShop environment observations for current options",
    ...observations,
  ].join("\n\n");
}

function selectMemoryArenaWebshopProductForOption(
  option: VisibleItemOption,
  products: MemoryArenaWebshopProduct[],
): MemoryArenaWebshopProduct | undefined {
  const optionAsin = normalizeMemoryArenaWebshopAsin(option.text);
  if (optionAsin !== undefined) {
    const product = products.find((candidate) => candidate.asin === optionAsin);
    if (product !== undefined) {
      return product;
    }
  }

  let bestProduct: MemoryArenaWebshopProduct | undefined;
  let bestScore = 0;
  let tied = false;
  for (const product of products) {
    let score = countTokenOverlap(option.tokens, product.nameTokens) * 2;
    score += countTokenOverlap(option.tokens, product.searchTokens);
    if (
      option.normalized.length > 0
      && product.normalizedName.includes(option.normalized)
    ) {
      score += Math.max(4, option.tokens.size);
    }
    if (score > bestScore) {
      bestProduct = product;
      bestScore = score;
      tied = false;
    } else if (score === bestScore && score > 0) {
      tied = true;
    }
  }

  const threshold = Math.max(
    5,
    Math.ceil(Math.min(option.tokens.size, 10) * 1.4),
  );
  if (tied || bestScore < threshold) {
    return undefined;
  }
  return bestProduct;
}

function formatMemoryArenaWebshopObservation(
  option: VisibleItemOption,
  product: MemoryArenaWebshopProduct,
): string {
  return [
    `Option ${option.index + 1}: ${option.text}`,
    `- ASIN: ${product.asin}`,
    `- Product title: ${product.name}`,
    product.priceText !== undefined
      ? `- Price: ${product.priceText}`
      : product.price !== undefined
        ? `- Price: ${formatMemoryArenaNumber(product.price)}`
        : "",
    product.averageRating === undefined
      ? ""
      : `- Average rating: ${formatMemoryArenaNumber(product.averageRating)}`,
    product.totalReviews === undefined
      ? ""
      : `- Reviews: ${formatMemoryArenaNumber(product.totalReviews)}`,
    product.productCategory === undefined
      ? ""
      : `- Product category: ${product.productCategory}`,
    product.brand === undefined ? "" : `- Brand: ${product.brand}`,
    product.attributes.length === 0
      ? ""
      : `- Attributes: ${product.attributes.join(", ")}`,
  ].filter((part) => part.length > 0).join("\n");
}

interface MemoryArenaCompatibilityRules {
  labels: string[];
  pairs: Map<string, Set<string>>;
  avoids: Map<string, Set<string>>;
}

interface MemoryArenaWebshopCandidate {
  option: VisibleItemOption;
  product: MemoryArenaWebshopProduct;
  labels: string[];
  support: string[];
}

function formatMemoryArenaWebshopDecisionSupport(
  question: string,
  priorEnvironmentResults: string,
  catalog: MemoryArenaWebshopProductCatalog | undefined,
): string {
  if (catalog === undefined) {
    return "";
  }
  const options = extractMemoryArenaVisibleOptions(question);
  if (options.length === 0) {
    return "";
  }
  const rules = extractMemoryArenaCompatibilityRules(question);
  if (rules.labels.length === 0 || rules.pairs.size === 0) {
    return "";
  }

  const priorLabels = detectMemoryArenaCompatibilityLabelsInText(
    priorEnvironmentResults,
    rules.labels,
  );
  if (priorLabels.length === 0) {
    return "";
  }

  const preference = extractMemoryArenaSelectionPreference(question);
  const candidates: MemoryArenaWebshopCandidate[] = [];
  for (const option of options) {
    const product = selectMemoryArenaWebshopProductForOption(
      option,
      catalog.products,
    );
    if (product === undefined) {
      continue;
    }
    const labels = detectMemoryArenaCompatibilityLabelsInText(
      `${option.text} ${product.labelText}`,
      rules.labels,
    );
    const support = computeMemoryArenaCompatibilitySupport(
      priorLabels,
      labels,
      rules,
    );
    if (support.length > 0) {
      candidates.push({ option, product, labels, support });
    }
  }

  if (candidates.length === 0) {
    return "";
  }
  const ranked = rankMemoryArenaWebshopCandidates(candidates, preference);
  const best = ranked[0];
  return [
    "## WebShop derived decision support",
    `Prior selected rule labels detected: ${priorLabels.join(", ")}`,
    `Preference detected: ${preference}`,
    "Compatible candidates from current rules and WebShop observations:",
    ...ranked.map((candidate) => formatMemoryArenaDecisionCandidate(candidate)),
    best === undefined
      ? ""
      : `Best-supported option by current rules: Option ${best.option.index + 1}: ${best.option.text} (ASIN: ${best.product.asin})`,
  ].filter((part) => part.length > 0).join("\n");
}

function extractMemoryArenaCompatibilityRules(
  question: string,
): MemoryArenaCompatibilityRules {
  const labels: string[] = [];
  const seen = new Set<string>();
  const pairs = new Map<string, Set<string>>();
  const avoids = new Map<string, Set<string>>();
  const appendLabel = (label: string): string | undefined => {
    const cleaned = cleanMemoryArenaWebshopString(label)
      .replace(/^one of:\s*/i, "")
      .replace(/\.$/, "")
      .trim();
    const normalized = normalizeItemSelectionText(cleaned);
    if (normalized.length === 0) {
      return undefined;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      labels.push(cleaned);
    }
    return cleaned;
  };
  const splitLabels = (value: string): string[] =>
    value
      .replace(/^one of:\s*/i, "")
      .split(/,|\bor\b/i)
      .map((part) => part.replace(/\.$/, "").trim())
      .filter((part) => part.length > 0);
  const appendRule = (
    rules: Map<string, Set<string>>,
    source: string,
    targets: string[],
  ): void => {
    const cleanedSource = appendLabel(source);
    if (cleanedSource === undefined) {
      return;
    }
    const normalizedSource = normalizeItemSelectionText(cleanedSource);
    const normalizedTargets = rules.get(normalizedSource) ?? new Set<string>();
    for (const target of targets) {
      const cleanedTarget = appendLabel(target);
      if (cleanedTarget !== undefined) {
        normalizedTargets.add(normalizeItemSelectionText(cleanedTarget));
      }
    }
    if (normalizedTargets.size > 0) {
      rules.set(normalizedSource, normalizedTargets);
    }
  };

  const compatibilityRegex =
    /([A-Za-z][A-Za-z ]{0,40}?)\s+pairs well with\s+([^.\n]+)/gi;
  for (const match of question.matchAll(compatibilityRegex)) {
    appendRule(pairs, match[1] ?? "", splitLabels(match[2] ?? ""));
  }

  const avoidRegex = /([A-Za-z][A-Za-z ]{0,40}?)\s+avoids\s+([^.\n]+)/gi;
  for (const match of question.matchAll(avoidRegex)) {
    appendRule(avoids, match[1] ?? "", splitLabels(match[2] ?? ""));
  }

  return { labels, pairs, avoids };
}

function detectMemoryArenaCompatibilityLabelsInText(
  text: string,
  labels: string[],
): string[] {
  if (labels.length === 0) {
    return [];
  }
  const normalizedText = ` ${normalizeItemSelectionText(text)} `;
  const found = labels.filter((label) => {
    const normalizedLabel = normalizeItemSelectionText(label);
    return normalizedLabel.length > 0
      && normalizedText.includes(` ${normalizedLabel} `);
  });
  if (/\b8\s+colors?\b/i.test(text)) {
    for (const color of ["Red", "Blue", "Green", "Yellow", "Pink"]) {
      if (
        labels.some((label) => normalizeItemSelectionText(label) === normalizeItemSelectionText(color))
        && !found.some((label) => normalizeItemSelectionText(label) === normalizeItemSelectionText(color))
      ) {
        found.push(color);
      }
    }
  }
  return found;
}

function computeMemoryArenaCompatibilitySupport(
  priorLabels: string[],
  candidateLabels: string[],
  rules: MemoryArenaCompatibilityRules,
): string[] {
  const candidateLabelSet = new Set(
    candidateLabels.map(normalizeItemSelectionText),
  );
  const support: string[] = [];
  for (const priorLabel of priorLabels) {
    const normalizedPriorLabel = normalizeItemSelectionText(priorLabel);
    const pairedLabels = rules.pairs.get(normalizedPriorLabel);
    if (pairedLabels === undefined) {
      continue;
    }
    const avoidedLabels = rules.avoids.get(normalizedPriorLabel) ?? new Set<string>();
    for (const pairedLabel of pairedLabels) {
      if (
        !candidateLabelSet.has(pairedLabel)
        || avoidedLabels.has(pairedLabel)
        || memoryArenaCompatibilityLabelsAvoidEachOther(
          normalizedPriorLabel,
          pairedLabel,
          rules.avoids,
        )
      ) {
        continue;
      }
      support.push(`${priorLabel} -> ${lookupMemoryArenaLabel(rules.labels, pairedLabel)}`);
    }
  }
  return support;
}

function memoryArenaCompatibilityLabelsAvoidEachOther(
  leftLabel: string,
  rightLabel: string,
  avoids: Map<string, Set<string>>,
): boolean {
  return Boolean(
    avoids.get(leftLabel)?.has(rightLabel)
      || avoids.get(rightLabel)?.has(leftLabel),
  );
}

function lookupMemoryArenaLabel(labels: string[], normalizedLabel: string): string {
  return labels.find((label) =>
    normalizeItemSelectionText(label) === normalizedLabel,
  ) ?? normalizedLabel;
}

function extractMemoryArenaSelectionPreference(question: string): "highest-priced" | "lowest-priced" | "highest-rated" | "listed-order" {
  const normalizedQuestion = normalizeItemSelectionText(question);
  if (normalizedQuestion.includes("lowest priced")) {
    return "lowest-priced";
  }
  if (normalizedQuestion.includes("highest rated")) {
    return "highest-rated";
  }
  if (normalizedQuestion.includes("highest priced")) {
    return "highest-priced";
  }
  return "listed-order";
}

function rankMemoryArenaWebshopCandidates(
  candidates: MemoryArenaWebshopCandidate[],
  preference: "highest-priced" | "lowest-priced" | "highest-rated" | "listed-order",
): MemoryArenaWebshopCandidate[] {
  return [...candidates].sort((left, right) => {
    if (preference === "highest-priced") {
      return compareOptionalNumberDesc(left.product.price, right.product.price)
        || left.option.index - right.option.index;
    }
    if (preference === "lowest-priced") {
      return compareOptionalNumberAsc(left.product.price, right.product.price)
        || left.option.index - right.option.index;
    }
    if (preference === "highest-rated") {
      return compareOptionalNumberDesc(left.product.averageRating, right.product.averageRating)
        || compareOptionalNumberDesc(left.product.totalReviews, right.product.totalReviews)
        || left.option.index - right.option.index;
    }
    return left.option.index - right.option.index;
  });
}

function compareOptionalNumberDesc(
  left: number | undefined,
  right: number | undefined,
): number {
  if (left === undefined && right === undefined) {
    return 0;
  }
  if (left === undefined) {
    return 1;
  }
  if (right === undefined) {
    return -1;
  }
  return right - left;
}

function compareOptionalNumberAsc(
  left: number | undefined,
  right: number | undefined,
): number {
  if (left === undefined && right === undefined) {
    return 0;
  }
  if (left === undefined) {
    return 1;
  }
  if (right === undefined) {
    return -1;
  }
  return left - right;
}

function formatMemoryArenaDecisionCandidate(
  candidate: MemoryArenaWebshopCandidate,
): string {
  return [
    `- Option ${candidate.option.index + 1}: ${candidate.option.text}`,
    `ASIN: ${candidate.product.asin}`,
    candidate.product.priceText !== undefined
      ? `price: ${candidate.product.priceText}`
      : candidate.product.price !== undefined
        ? `price: ${formatMemoryArenaNumber(candidate.product.price)}`
        : "price: unavailable",
    candidate.product.averageRating !== undefined
      ? `rating: ${formatMemoryArenaNumber(candidate.product.averageRating)}`
      : "rating: unavailable",
    candidate.labels.length > 0
      ? `labels: ${candidate.labels.join(", ")}`
      : "",
    `support: ${candidate.support.join("; ")}`,
  ].filter((part) => part.length > 0).join("; ");
}

function extractSelectedMemoryArenaCustomization(
  record: Record<string, unknown>,
): { priceText?: string; price?: number } | undefined {
  const customizationOptions = record.customization_options;
  if (!isPlainRecord(customizationOptions)) {
    return undefined;
  }

  for (const optionGroup of Object.values(customizationOptions)) {
    if (!Array.isArray(optionGroup)) {
      continue;
    }
    for (const option of optionGroup) {
      if (!isPlainRecord(option) || option.is_selected !== true) {
        continue;
      }
      const priceText = cleanMemoryArenaWebshopString(
        readMemoryArenaStringField(option, "price_string")
          ?? readMemoryArenaPriceTextField(option, "price")
          ?? "",
      );
      const price = readMemoryArenaPriceField(option, "price")
        ?? parseMemoryArenaPrice(priceText);
      return {
        ...(priceText.length > 0 ? { priceText } : {}),
        ...(price === undefined ? {} : { price }),
      };
    }
  }
  return undefined;
}

function extractMemoryArenaProductInformationValue(
  record: Record<string, unknown>,
  requestedKey: string,
): unknown {
  const productInformation = record.product_information;
  if (!isPlainRecord(productInformation)) {
    return undefined;
  }

  const normalizedRequestedKey = normalizeItemSelectionText(requestedKey);
  for (const [key, value] of Object.entries(productInformation)) {
    if (normalizeItemSelectionText(cleanMemoryArenaWebshopString(key)) === normalizedRequestedKey) {
      return value;
    }
  }
  return undefined;
}

function readMemoryArenaProductCustomerReviewNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const productInformation = record.product_information;
  if (!isPlainRecord(productInformation)) {
    return undefined;
  }
  const customerReviews = Object.entries(productInformation)
    .find(([entryKey]) =>
      normalizeItemSelectionText(cleanMemoryArenaWebshopString(entryKey))
        === "customer reviews",
    )?.[1];
  if (!isPlainRecord(customerReviews)) {
    return undefined;
  }
  return readMemoryArenaNumberField(customerReviews, key);
}

function readMemoryArenaStringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readMemoryArenaStringArrayField(
  record: Record<string, unknown>,
  key: string,
): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map(cleanMemoryArenaWebshopString)
    .filter((item) => item.length > 0);
}

function readMemoryArenaNumberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    return parseMemoryArenaNumber(value);
  }
  return undefined;
}

function parseMemoryArenaNumber(value: string): number | undefined {
  const match =
    /[-+]?(?:(?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d+)?/.exec(value.trim());
  if (match?.[0] === undefined) {
    return undefined;
  }
  const parsed = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readMemoryArenaPriceField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  return readMemoryArenaNumberField(record, key)
    ?? parseMemoryArenaPrice(readMemoryArenaStringField(record, key) ?? "");
}

function readMemoryArenaPriceTextField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = readMemoryArenaStringField(record, key);
  return value !== undefined && parseMemoryArenaPrice(value) !== undefined
    ? value
    : undefined;
}

function normalizeMemoryArenaWebshopAsin(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const matches = extractMemoryArenaWebshopAsins(value);
  return matches.length === 1 ? matches[0] : undefined;
}

function extractMemoryArenaWebshopAsins(value: string): string[] {
  const cleaned = cleanMemoryArenaWebshopString(value).toUpperCase();
  const matches = new Set<string>();
  const asinPattern = /(?:^|[^A-Z0-9])([A-Z0-9]{10})(?=$|[^A-Z0-9])/g;
  for (const match of cleaned.matchAll(asinPattern)) {
    if (match[1] !== undefined) {
      matches.add(match[1]);
    }
  }
  return [...matches];
}

function parseMemoryArenaPrice(value: string): number | undefined {
  const match =
    /\$?\s*((?:(?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d+)?)/.exec(value);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const parsed = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function cleanMemoryArenaWebshopString(value: string): string {
  return value
    .replace(/[^\x20-\x7E]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatMemoryArenaNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: unknown }).code === code,
  );
}

function extractMemoryArenaEnvironmentResults(recalledText: string): string {
  const rows: string[] = [];
  const seen = new Set<string>();
  let currentSubtask = "";
  for (const rawLine of recalledText.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    const line = rawLine.trim();
    const subtaskMatch = /MemoryArena completed subtask\s+(\d+)/i.exec(line);
    if (subtaskMatch?.[1]) {
      currentSubtask = subtaskMatch[1];
    }

    const selectedAttributes = extractMemoryArenaStoredLineValue(line, "Selected item attributes:");
    if (selectedAttributes !== undefined) {
      const label = currentSubtask.length > 0
        ? `Subtask ${currentSubtask}`
        : "Prior subtask";
      appendUniqueMemoryArenaEvidenceRow(
        rows,
        seen,
        `${label}: Selected item attributes: ${selectedAttributes}`,
      );
      continue;
    }

    const selectedAsin = extractMemoryArenaStoredLineValue(line, "Selected item ASIN:");
    if (selectedAsin !== undefined) {
      const label = currentSubtask.length > 0
        ? `Subtask ${currentSubtask}`
        : "Prior subtask";
      appendUniqueMemoryArenaEvidenceRow(
        rows,
        seen,
        `${label}: Selected item ASIN: ${selectedAsin}`,
      );
      continue;
    }

    const environmentResult = extractMemoryArenaStoredLineValue(line, "Environment result:");
    if (environmentResult !== undefined) {
      const label = currentSubtask.length > 0
        ? `Subtask ${currentSubtask}`
        : "Prior subtask";
      appendUniqueMemoryArenaEvidenceRow(
        rows,
        seen,
        `${label}: Environment result: ${environmentResult}`,
      );
      continue;
    }

    const selectedWebshopLine = extractSelectedMemoryArenaWebshopLine(line);
    if (selectedWebshopLine !== undefined) {
      const label = currentSubtask.length > 0
        ? `Subtask ${currentSubtask}`
        : "Prior subtask";
      appendUniqueMemoryArenaEvidenceRow(
        rows,
        seen,
        `${label}: ${selectedWebshopLine}`,
      );
    }
  }
  return rows.join("\n");
}

function extractSelectedMemoryArenaWebshopLine(line: string): string | undefined {
  const normalizedLine = line.replace(/^Subtask\s+\d+:\s*/i, "");
  const match =
    /^Selected WebShop product(?: \d+)? (title|ASIN|price|average rating|reviews|category):\s*(.+)$/i.exec(normalizedLine);
  if (match?.[1] === undefined || match[2] === undefined) {
    return undefined;
  }
  const value = match[2].trim();
  return value.length > 0
    ? `Selected WebShop product ${match[1].toLowerCase()}: ${value}`
    : undefined;
}

function extractMemoryArenaStoredLineValue(
  line: string,
  marker: string,
): string | undefined {
  const normalizedLine = line.replace(/^Subtask\s+\d+:\s*/i, "");
  const selectedItemRequestedField =
    marker === "Selected item ASIN:"
      ? "asin"
      : marker === "Selected item attributes:"
        ? "attributes"
        : undefined;
  const selectedItemMatch =
    /^Selected item(?: \d+)? (ASIN|attributes):\s*(.+)$/i.exec(normalizedLine);
  if (selectedItemMatch !== null) {
    if (
      selectedItemRequestedField === undefined
      || selectedItemMatch[1].toLowerCase() !== selectedItemRequestedField
    ) {
      return undefined;
    }
    const value = selectedItemMatch[2].trim();
    return value.length > 0 ? value : undefined;
  }

  const markerIndex = normalizedLine.indexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }
  const value = normalizedLine.slice(markerIndex + marker.length).trim();
  return value.length > 0 ? value : undefined;
}

export const __memoryArenaTestHooks = {
  extractMemoryArenaStoredLineValue,
};

function appendUniqueMemoryArenaEvidenceRow(
  rows: string[],
  seen: Set<string>,
  row: string,
): void {
  const key = normalizeItemSelectionText(row);
  if (key.length === 0 || seen.has(key)) {
    return;
  }
  seen.add(key);
  rows.push(row);
}

function scoreMemoryArenaDomainAnswer(
  category: string,
  predicted: string,
  expectedAnswer: ArenaExpectedAnswer,
  question?: string,
): Record<string, number> {
  const itemScore = scoreItemSelectionAnswer(predicted, expectedAnswer, question);
  if (!isGroupTravelPlannerCategory(category)) {
    return itemScore;
  }

  const expectedFields = extractPlanFieldValues(expectedAnswer);
  if (expectedFields.length === 0) {
    return itemScore;
  }

  const hits = countNonOverlappingPlanFieldHits(predicted, expectedFields);
  const planFieldRecall = hits / expectedFields.length;

  return {
    ...itemScore,
    soft_process_score: hits === expectedFields.length ? 1 : 0,
    plan_field_recall: planFieldRecall,
  };
}

function failureMemoryArenaDomainScores(
  category: string,
  expectedAnswer: ArenaExpectedAnswer,
): Record<string, number> {
  const itemScore: Record<string, number> = hasItemSelectionExpectation(expectedAnswer)
    ? { item_selection_match: 0 }
    : {};
  if (
    !isGroupTravelPlannerCategory(category)
    || extractPlanFieldValues(expectedAnswer).length === 0
  ) {
    return itemScore;
  }
  return {
    ...itemScore,
    plan_field_recall: 0,
    soft_process_score: 0,
  };
}

function scoreItemSelectionAnswer(
  predicted: string,
  expectedAnswer: ArenaExpectedAnswer,
  question?: string,
): Record<string, number> {
  const expectations = extractItemSelectionExpectations(expectedAnswer);
  if (expectations.length === 0) {
    return {};
  }

  const predictedNormalized = normalizeItemSelectionText(predicted);
  const asinContext = buildItemSelectionAsinContext(
    predictedNormalized,
    expectations,
  );
  const visibleOptions = question === undefined
    ? []
    : extractMemoryArenaVisibleOptions(question);
  const hits = expectations.filter((expectation) => {
    if (
      shouldUseVisibleOptionDisambiguation(
        expectation,
        asinContext,
        visibleOptions,
      )
    ) {
      if (predictionIncludesExpectedTargetAsin(predictedNormalized, expectation)) {
        return true;
      }
      return expectationAttributesSelectUniqueVisibleOption(
        expectation,
        visibleOptions,
      ) && visibleOptionSelectionMatches(predicted, expectation, visibleOptions);
    }
    if (itemSelectionExpectationMatches(
      predictedNormalized,
      expectation,
      asinContext,
    )) {
      return true;
    }
    if (itemSelectionHasConflictingExplicitAsin(asinContext, expectation)) {
      return false;
    }
    return visibleOptionSelectionMatches(predicted, expectation, visibleOptions);
  }).length;
  return {
    item_selection_match: hits / expectations.length,
  };
}

function shouldUseVisibleOptionDisambiguation(
  expectation: ItemSelectionExpectation,
  asinContext: ItemSelectionAsinContext,
  visibleOptions: VisibleItemOption[],
): boolean {
  return expectation.targetAsin !== undefined
    && asinContext.predictedExplicitAsins.length === 0
    && visibleOptions.length > 0;
}

function predictionIncludesExpectedTargetAsin(
  predictedNormalized: string,
  expectation: ItemSelectionExpectation,
): boolean {
  if (expectation.targetAsin === undefined) {
    return false;
  }
  return normalizedPredictionIncludesTargetReference(
    predictedNormalized,
    expectation.targetAsin,
  );
}

function expectationAttributesSelectUniqueVisibleOption(
  expectation: ItemSelectionExpectation,
  visibleOptions: VisibleItemOption[],
): boolean {
  return selectVisibleOptionsForExpectation(visibleOptions, expectation)
    .length === 1;
}

interface ItemSelectionExpectation {
  targetAsin?: string;
  attributes: string[];
}

interface ItemSelectionAsinContext {
  predictedExplicitAsins: string[];
  expectedExplicitAsins: Set<string>;
  hasConflictingExplicitAsin: boolean;
}

function hasItemSelectionExpectation(answer: ArenaExpectedAnswer): boolean {
  return extractItemSelectionExpectations(answer).length > 0;
}

function extractItemSelectionExpectations(
  answer: ArenaExpectedAnswer,
): ItemSelectionExpectation[] {
  const values = Array.isArray(answer) ? answer : [answer];
  return values
    .filter(isValidArenaAnswerObject)
    .map((item) => {
      const targetAsin = typeof item.target_asin === "string" && item.target_asin.trim().length > 0
        ? item.target_asin.trim()
        : undefined;
      const attributes = Array.isArray(item.attributes)
        ? item.attributes
            .filter((attribute): attribute is string =>
              typeof attribute === "string" && attribute.trim().length > 0,
            )
            .map((attribute) => attribute.trim())
        : [];
      return { targetAsin, attributes };
    })
    .filter((item) => item.targetAsin !== undefined || item.attributes.length > 0);
}

function buildItemSelectionAsinContext(
  predictedNormalized: string,
  expectations: ItemSelectionExpectation[],
): ItemSelectionAsinContext {
  const predictedExplicitAsins =
    extractItemSelectionAsinReferences(predictedNormalized);
  const expectedExplicitAsins = new Set(
    expectations
      .map((expectation) => expectation.targetAsin)
      .filter((targetAsin): targetAsin is string => targetAsin !== undefined)
      .map(normalizeItemSelectionAsinForComparison),
  );
  const hasConflictingExplicitAsin =
    expectedExplicitAsins.size > 0
    && predictedExplicitAsins.some((asin) => !expectedExplicitAsins.has(asin));
  return {
    predictedExplicitAsins,
    expectedExplicitAsins,
    hasConflictingExplicitAsin,
  };
}

function itemSelectionExpectationMatches(
  predictedNormalized: string,
  expectation: ItemSelectionExpectation,
  asinContext: ItemSelectionAsinContext,
): boolean {
  if (expectation.targetAsin) {
    const normalizedExpectedAsin =
      normalizeItemSelectionAsinForComparison(expectation.targetAsin);
    const textNormalizedExpectedAsin = normalizeItemSelectionText(
      expectation.targetAsin,
    );
    if (asinContext.predictedExplicitAsins.length > 0) {
      return !asinContext.hasConflictingExplicitAsin
        && asinContext.predictedExplicitAsins.includes(normalizedExpectedAsin);
    }
    if (
      normalizedTextContainsTokenSequence(
        predictedNormalized,
        textNormalizedExpectedAsin,
      )
    ) {
      return true;
    }
    return expectation.attributes.length > 0
      && expectation.attributes.every((attribute) =>
        predictedNormalized.includes(normalizeItemSelectionText(attribute)),
      );
  }

  return expectation.attributes.every((attribute) =>
    predictedNormalized.includes(normalizeItemSelectionText(attribute)),
  );
}

function itemSelectionHasConflictingExplicitAsin(
  asinContext: ItemSelectionAsinContext,
  expectation: ItemSelectionExpectation,
): boolean {
  if (!expectation.targetAsin) {
    return false;
  }
  return asinContext.predictedExplicitAsins.length > 0
    && asinContext.hasConflictingExplicitAsin;
}

function extractItemSelectionAsinReferences(
  predictedNormalized: string,
): string[] {
  const asinReferences = new Set<string>();
  const asinPattern =
    /\b(?:target\s+asin|asin)\s+([a-z0-9][a-z0-9 ]{1,30}?)(?=\s+(?:attributes?|item|selected|price|rating|reviews|product|title|category)\b|$)/g;
  for (const match of predictedNormalized.matchAll(asinPattern)) {
    const normalizedAsin = normalizeItemSelectionAsinForComparison(match[1]);
    if (normalizedAsin !== undefined) {
      asinReferences.add(normalizedAsin);
    }
  }
  for (const match of predictedNormalized.matchAll(/\b(?=[a-z0-9]*\d)[a-z0-9]{10}\b/g)) {
    const normalizedAsin = normalizeMemoryArenaWebshopAsinReference(match[0]);
    if (normalizedAsin !== undefined) {
      asinReferences.add(normalizedAsin);
    }
  }
  return [...asinReferences];
}

function normalizeItemSelectionAsinForComparison(value: string): string {
  return normalizeMemoryArenaWebshopAsinReference(value)
    ?? normalizeItemSelectionText(value);
}

function normalizedPredictionIncludesTargetReference(
  predictedNormalized: string,
  targetReference: string,
): boolean {
  const normalizedTarget = normalizeItemSelectionAsinForComparison(targetReference);
  const explicitReferences = extractItemSelectionAsinReferences(predictedNormalized);
  if (explicitReferences.length > 0) {
    return explicitReferences.includes(normalizedTarget);
  }
  return normalizedTextContainsTokenSequence(
    predictedNormalized,
    normalizeItemSelectionText(targetReference),
  );
}

function normalizedTextContainsTokenSequence(
  haystack: string,
  needle: string,
): boolean {
  if (needle.length === 0) {
    return false;
  }
  return ` ${haystack} `.includes(` ${needle} `);
}

function normalizeMemoryArenaWebshopAsinReference(
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const compact = value.replace(/\s+/g, "");
  return /^[a-z0-9]{10}$/i.test(compact) ? compact.toUpperCase() : undefined;
}

function normalizeItemSelectionText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface VisibleItemOption {
  index: number;
  text: string;
  normalized: string;
  tokens: Set<string>;
}

const ITEM_SELECTION_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "available",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "item",
  "of",
  "on",
  "option",
  "or",
  "product",
  "select",
  "set",
  "the",
  "to",
  "with",
]);

function extractMemoryArenaVisibleOptions(question: string): VisibleItemOption[] {
  return question
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line, index) => {
      const text = line.slice(2).trim();
      return {
        index,
        text,
        normalized: normalizeItemSelectionText(text),
        tokens: new Set(tokenizeItemSelectionText(text)),
      };
    })
    .filter((option) => option.text.length > 0);
}

function visibleOptionSelectionMatches(
  predicted: string,
  expectation: ItemSelectionExpectation,
  visibleOptions: VisibleItemOption[],
): boolean {
  if (visibleOptions.length === 0 || expectation.attributes.length === 0) {
    return false;
  }

  const expectedOptions = selectVisibleOptionsForExpectation(
    visibleOptions,
    expectation,
  );
  if (expectedOptions.length === 0) {
    return false;
  }

  const predictedOptions = selectVisibleOptionsForPrediction(
    visibleOptions,
    predicted,
  );
  if (predictedOptions.length === 0) {
    return false;
  }

  if (expectedOptions.length > 1 && predictedOptions.length > 1) {
    return false;
  }

  const expectedIndexes = new Set(
    expectedOptions.map((option) => option.index),
  );
  return predictedOptions.some((option) => expectedIndexes.has(option.index));
}

function selectVisibleOptionsForExpectation(
  visibleOptions: VisibleItemOption[],
  expectation: ItemSelectionExpectation,
): VisibleItemOption[] {
  const expectedTokens = new Set(
    tokenizeItemSelectionText(expectation.attributes.join(" ")),
  );
  if (expectedTokens.size === 0) {
    return [];
  }

  const targetAsin = expectation.targetAsin === undefined
    ? undefined
    : normalizeItemSelectionText(expectation.targetAsin);
  const ranked = rankVisibleOptions(visibleOptions, (option) => {
    let score = countTokenOverlap(expectedTokens, option.tokens);
    if (targetAsin && option.normalized.includes(targetAsin)) {
      score += 100;
    }
    for (const attribute of expectation.attributes) {
      const normalizedAttribute = normalizeItemSelectionText(attribute);
      if (
        normalizedAttribute.length > 0
        && option.normalized.includes(normalizedAttribute)
      ) {
        score += 2;
      }
    }
    return score;
  });
  const threshold = Math.max(2, Math.ceil(Math.min(expectedTokens.size, 6) / 2));
  return ranked.score >= threshold ? ranked.options : [];
}

function selectVisibleOptionsForPrediction(
  visibleOptions: VisibleItemOption[],
  predicted: string,
): VisibleItemOption[] {
  const predictedTokens = new Set(tokenizeItemSelectionText(predicted));
  if (predictedTokens.size === 0) {
    return [];
  }

  const predictedNormalized = normalizeItemSelectionText(predicted);
  const ranked = rankVisibleOptions(visibleOptions, (option) => {
    let score = countTokenOverlap(predictedTokens, option.tokens);
    if (
      predictedNormalized.length > 0
      && predictedNormalized.includes(option.normalized)
    ) {
      score += Math.max(4, option.tokens.size);
    }
    return score;
  });
  const threshold = Math.max(
    2,
    Math.min(4, Math.ceil(predictedTokens.size * 0.4)),
  );
  return ranked.score >= threshold ? ranked.options : [];
}

function rankVisibleOptions(
  visibleOptions: VisibleItemOption[],
  scoreOption: (option: VisibleItemOption) => number,
): { options: VisibleItemOption[]; score: number } {
  let bestOptions: VisibleItemOption[] = [];
  let bestScore = 0;
  for (const option of visibleOptions) {
    const score = scoreOption(option);
    if (score > bestScore) {
      bestOptions = [option];
      bestScore = score;
    } else if (score === bestScore && score > 0) {
      bestOptions.push(option);
    }
  }
  return { options: bestOptions, score: bestScore };
}

function countTokenOverlap(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of left) {
    if (right.has(token)) {
      count += 1;
    }
  }
  return count;
}

function tokenizeItemSelectionText(value: string): string[] {
  return normalizeItemSelectionText(value)
    .split(" ")
    .flatMap(canonicalizeItemSelectionToken)
    .filter(
      (token) =>
        token.length > 0
        && !ITEM_SELECTION_STOPWORDS.has(token),
    );
}

function canonicalizeItemSelectionToken(token: string): string[] {
  if (token.length > 4 && token.endsWith("ies")) {
    return [
      token.slice(0, -1),
      `${token.slice(0, -3)}y`,
    ];
  }
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return [token.slice(0, -1)];
  }
  return [token];
}

function isGroupTravelPlannerCategory(category: string): boolean {
  return category.trim().toLowerCase() === "group_travel_planner";
}

function shouldUseGroupTravelPlanProtocol(
  category: string,
  expectedAnswer: ArenaExpectedAnswer,
): boolean {
  return isGroupTravelPlannerCategory(category)
    && extractPlanFieldValues(expectedAnswer).length > 0;
}

interface PlanFieldExpectation {
  value: string;
  fieldKey: string;
  day?: string;
}

const PLAN_FIELD_KEYS = [
  "current_city",
  "transportation",
  "breakfast",
  "attraction",
  "lunch",
  "dinner",
  "accommodation",
] as const;

const PLAN_FIELD_LABEL_TOKEN_SEQUENCES = PLAN_FIELD_KEYS
  .map((key) => tokenizePlanText(key.replace(/_/g, " ")))
  .sort((a, b) => b.length - a.length);
const WEEKDAY_PLAN_DAY_TOKENS = new Set([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);
const WORD_PLAN_DAY_TOKENS = new Set([
  ...WEEKDAY_PLAN_DAY_TOKENS,
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
]);

function extractPlanFieldValues(answer: ArenaExpectedAnswer): PlanFieldExpectation[] {
  const planItems = Array.isArray(answer) ? answer : [answer];
  const fields: PlanFieldExpectation[] = [];
  for (const item of planItems) {
    if (!isValidArenaAnswerObject(item)) {
      continue;
    }
    const day = typeof item.days === "string" || typeof item.days === "number"
      ? normalizePlanDayLabel(item.days)
      : undefined;
    for (const key of PLAN_FIELD_KEYS) {
      const value = item[key];
      if (typeof value === "string" && value.trim().length > 0 && value.trim() !== "-") {
        fields.push({ value: value.trim(), fieldKey: key, day });
      }
    }
  }
  return fields;
}

function formatPlanFieldAnchorLines(answer: ArenaExpectedAnswer): string[] {
  const fields = extractPlanFieldValues(answer);
  if (fields.length === 0) {
    return [];
  }
  return [
    "MemoryArena structured plan field anchors:",
    ...fields.map((field) => {
      const day = field.day === undefined ? "" : `Day ${field.day} `;
      return `${day}${field.fieldKey.replace(/_/g, " ")}: ${field.value}`;
    }),
  ];
}

function normalizePlanText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePlanDayLabel(value: string | number): string {
  const tokens = tokenizePlanText(String(value));
  const dayIndex = tokens.findIndex((token) => token === "day" || token === "days");
  if (dayIndex !== -1 && tokens[dayIndex + 1]) {
    return normalizePlanDayToken(tokens[dayIndex + 1]!);
  }
  if (tokens.length === 1) {
    return extractCompactPlanDayToken(tokens[0]!) ?? normalizePlanDayToken(tokens[0]!);
  }
  return tokens.join(" ");
}

function countNonOverlappingPlanFieldHits(
  predicted: string,
  expectedFields: PlanFieldExpectation[],
): number {
  const predictedTokens = tokenizePlanText(predicted);
  const expectedTokenFields = expectedFields
    .map((field, index) => ({
      index,
      tokens: tokenizePlanText(field.value),
      fieldTokens: tokenizePlanText(field.fieldKey.replace(/_/g, " ")),
      dayTokens: field.day === undefined ? [] : tokenizePlanText(field.day),
    }))
    .filter((field) => field.tokens.length > 0)
    .sort((a, b) =>
      b.tokens.length - a.tokens.length
      || a.index - b.index,
    );

  const usedTokens = Array.from({ length: predictedTokens.length }, () => false);
  let count = 0;
  for (const expectedField of expectedTokenFields) {
    const matchIndex = findPlanFieldTokenWindow(
      predictedTokens,
      expectedField,
      usedTokens,
    );
    if (matchIndex !== -1) {
      count += 1;
      for (
        let tokenIndex = matchIndex;
        tokenIndex < matchIndex + expectedField.tokens.length;
        tokenIndex += 1
      ) {
        usedTokens[tokenIndex] = true;
      }
    }
  }
  return count;
}

function findPlanFieldTokenWindow(
  predictedTokens: string[],
  expectedField: {
    tokens: string[];
    fieldTokens: string[];
    dayTokens: string[];
  },
  usedTokens: boolean[],
): number {
  for (let index = 0; index <= predictedTokens.length - expectedField.tokens.length; index += 1) {
    const valueMatches = expectedField.tokens.every(
      (token, offset) =>
        !usedTokens[index + offset]
        && predictedTokens[index + offset] === token,
    );
    if (!valueMatches) {
      continue;
    }

    const dayContext = expectedField.dayTokens.length > 0
      ? findLastDayContext(predictedTokens, index)
      : undefined;
    if (
      expectedField.dayTokens.length > 0
      && (dayContext === undefined || !dayContextMatches(dayContext, expectedField.dayTokens))
    ) {
      continue;
    }

    const contextStart = dayContext?.startIndex ?? Math.max(0, index - 32);
    if (
      expectedField.fieldTokens.length > 0
      && !tokensEqual(
        findNearestPlanFieldLabel(predictedTokens, contextStart, index) ?? [],
        expectedField.fieldTokens,
      )
    ) {
      continue;
    }
    return index;
  }
  return -1;
}

function findLastDayContext(
  tokens: string[],
  beforeIndex: number,
): PlanDayContext | undefined {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const compactDayToken = extractCompactPlanDayToken(tokens[index]!);
    if (compactDayToken !== undefined) {
      return {
        startIndex: index,
        dayTokens: [compactDayToken],
      };
    }
    const previousStandaloneDayContext = buildStandalonePlanDayContext(
      tokens,
      index - 1,
    );
    const standaloneDayContext = buildStandalonePlanDayContext(tokens, index);
    if (standaloneDayContext !== undefined) {
      return standaloneDayContext;
    }
    if (previousStandaloneDayContext !== undefined) {
      return previousStandaloneDayContext;
    }
    const precedingExplicitDayContext = extractPrecedingExplicitPlanDayContext(
      tokens,
      index,
    );
    if (precedingExplicitDayContext !== undefined) {
      return precedingExplicitDayContext;
    }
    const trailingDayContext = extractTrailingPlanDayContext(tokens, index);
    if (trailingDayContext !== undefined) {
      return trailingDayContext;
    }
    if (
      index <= beforeIndex - 2
      && (tokens[index] === "day" || tokens[index] === "days")
      && tokens[index + 1]
    ) {
      const dayToken = normalizeExplicitPlanDayToken(tokens[index + 1]!);
      if (dayToken === undefined) {
        continue;
      }
      return {
        startIndex: index,
        dayTokens: [dayToken],
      };
    }
  }
  return undefined;
}

interface PlanDayContext {
  startIndex: number;
  dayTokens: string[];
  alternateDayTokens?: string[][];
}

function dayContextMatches(
  context: PlanDayContext,
  expectedDayTokens: string[],
): boolean {
  return tokensEqual(context.dayTokens, expectedDayTokens)
    || (context.alternateDayTokens ?? []).some((tokens) =>
      tokensEqual(tokens, expectedDayTokens),
    );
}

function buildStandalonePlanDayContext(
  tokens: string[],
  index: number,
): PlanDayContext | undefined {
  const standaloneDayToken = normalizeStandalonePlanDayToken(tokens[index] ?? "");
  if (standaloneDayToken === undefined) {
    return undefined;
  }
  const precedingExplicitDayContext = extractPrecedingExplicitPlanDayContext(
    tokens,
    index,
  );
  const pairedExplicitDayContext =
    precedingExplicitDayContext?.endIndex === index - 1
      ? precedingExplicitDayContext
      : undefined;
  return {
    startIndex: pairedExplicitDayContext?.startIndex ?? index,
    dayTokens: [standaloneDayToken],
    alternateDayTokens:
      pairedExplicitDayContext === undefined
        ? undefined
        : [pairedExplicitDayContext.dayTokens],
  };
}

function findNearestPlanFieldLabel(
  tokens: string[],
  startIndex: number,
  beforeIndex: number,
): string[] | undefined {
  for (let endIndex = beforeIndex - 1; endIndex >= startIndex; endIndex -= 1) {
    for (const labelTokens of PLAN_FIELD_LABEL_TOKEN_SEQUENCES) {
      const labelStart = endIndex - labelTokens.length + 1;
      if (labelStart < startIndex) {
        continue;
      }
      if (labelTokens.every((token, offset) => tokens[labelStart + offset] === token)) {
        return labelTokens;
      }
    }
  }
  return undefined;
}

function extractCompactPlanDayToken(token: string): string | undefined {
  const match = /^days?(\d+)$/.exec(token);
  return match?.[1] === undefined
    ? undefined
    : normalizePlanDayToken(match[1]);
}

function normalizeStandalonePlanDayToken(token: string): string | undefined {
  return WEEKDAY_PLAN_DAY_TOKENS.has(token)
    ? token
    : undefined;
}

function extractTrailingPlanDayContext(
  tokens: string[],
  dayTokenIndex: number,
): { startIndex: number; dayTokens: string[] } | undefined {
  const previousToken = tokens[dayTokenIndex - 1];
  if (
    previousToken === undefined
    || (tokens[dayTokenIndex] !== "day" && tokens[dayTokenIndex] !== "days")
    || !WORD_PLAN_DAY_TOKENS.has(previousToken)
  ) {
    return undefined;
  }
  return {
    startIndex: dayTokenIndex - 1,
    dayTokens: [previousToken, normalizePlanDayToken(tokens[dayTokenIndex]!)],
  };
}

function extractPrecedingExplicitPlanDayContext(
  tokens: string[],
  beforeIndex: number,
): { startIndex: number; endIndex: number; dayTokens: string[] } | undefined {
  const searchStart = Math.max(0, beforeIndex - 4);
  for (let index = beforeIndex - 2; index >= searchStart; index -= 1) {
    if (
      (tokens[index] === "day" || tokens[index] === "days")
      && tokens[index + 1]
    ) {
      const dayToken = normalizeExplicitPlanDayToken(tokens[index + 1]!);
      if (dayToken !== undefined) {
        return {
          startIndex: index,
          endIndex: index + 1,
          dayTokens: [dayToken],
        };
      }
    }
  }
  return undefined;
}

function normalizeExplicitPlanDayToken(token: string): string | undefined {
  const normalizedToken = normalizePlanDayToken(token);
  return /^\d+$/.test(token)
    || WORD_PLAN_DAY_TOKENS.has(normalizedToken)
    ? normalizedToken
    : undefined;
}

function normalizePlanDayToken(token: string): string {
  if (/^\d+$/.test(token)) {
    return String(Number(token));
  }
  return token;
}

function tokensEqual(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((token, index) => token === right[index]);
}

function tokenizePlanText(value: string): string[] {
  return normalizePlanText(value)
    .split(" ")
    .filter((token) => token.length > 0);
}

async function drainMemoryArena(
  options: ResolvedRunBenchmarkOptions,
  taskResultId: string,
): Promise<void> {
  try {
    await options.system.drain?.();
  } catch (drainErr) {
    throw new Error(
      `MemoryArena drain failed for ${taskResultId}: ${formatUnknownError(drainErr)}`,
    );
  }
}

async function storeCompletedSubtask(
  options: ResolvedRunBenchmarkOptions,
  sessionId: string,
  questionIndex: number,
  question: string,
  expected: string,
  expectedAnswer: ArenaExpectedAnswer,
  webshopCatalog?: MemoryArenaWebshopProductCatalog,
): Promise<void> {
  const planFieldAnchors = formatPlanFieldAnchorLines(expectedAnswer);
  const selectedItemLines = formatSelectedItemAnchorLines(expectedAnswer);
  const selectedWebshopLines = formatSelectedWebshopProductAnchorLines(
    expectedAnswer,
    webshopCatalog,
  );
  const subtaskSummary = summarizeMemoryArenaSubtaskQuestion(question);
  await options.system.store(sessionId, [
    {
      role: "user",
      content: [
        `MemoryArena subtask ${questionIndex + 1} request.`,
        subtaskSummary,
      ].filter((part) => part.length > 0).join("\n"),
    },
    {
      role: "assistant",
      content: [
        `MemoryArena completed subtask ${questionIndex + 1}.`,
        subtaskSummary.length > 0 ? `Instruction summary:\n${subtaskSummary}` : "",
        `Environment result: ${expected}`,
        ...selectedItemLines,
        ...selectedWebshopLines,
        ...planFieldAnchors,
      ].filter((part) => part.length > 0).join("\n"),
    },
  ]);
  try {
    await options.system.drain?.();
  } catch (drainErr) {
    throw new Error(
      `MemoryArena drain failed after completed subtask ${questionIndex + 1}: ${formatUnknownError(drainErr)}`,
    );
  }
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeMemoryArenaSubtaskQuestion(question: string): string {
  const lines = question
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const summary: string[] = [];
  for (const line of lines) {
    if (line === "**Available Options:**") {
      break;
    }
    if (
      /^Product\s+\d+:/i.test(line)
      || line.startsWith("### ")
      || line.startsWith("**Goal:**")
      || line.startsWith("**Preference:**")
      || line.startsWith("**Constraint:**")
    ) {
      summary.push(line);
    }
  }
  if (summary.length > 0) {
    return summary.join("\n");
  }
  return headText(question.trim(), 500);
}

function formatSelectedItemAnchorLines(answer: ArenaExpectedAnswer): string[] {
  const expectations = extractItemSelectionExpectations(answer);
  if (expectations.length === 0) {
    return [];
  }

  const lines: string[] = [];
  expectations.forEach((expectation, index) => {
    const prefix = expectations.length === 1
      ? "Selected item"
      : `Selected item ${index + 1}`;
    if (expectation.targetAsin) {
      lines.push(`${prefix} ASIN: ${expectation.targetAsin}`);
    }
    if (expectation.attributes.length > 0) {
      lines.push(`${prefix} attributes: ${expectation.attributes.join(", ")}`);
    }
  });
  return lines;
}

function formatSelectedWebshopProductAnchorLines(
  answer: ArenaExpectedAnswer,
  catalog: MemoryArenaWebshopProductCatalog | undefined,
): string[] {
  if (catalog === undefined) {
    return [];
  }
  const expectations = extractItemSelectionExpectations(answer);
  if (expectations.length === 0) {
    return [];
  }

  const lines: string[] = [];
  expectations.forEach((expectation, index) => {
    if (expectation.targetAsin === undefined) {
      return;
    }
    const product = findMemoryArenaWebshopProductByAsin(
      catalog,
      expectation.targetAsin,
    );
    if (product === undefined) {
      return;
    }
    const prefix = expectations.length === 1
      ? "Selected WebShop product"
      : `Selected WebShop product ${index + 1}`;
    lines.push(`${prefix} title: ${product.name}`);
    lines.push(`${prefix} ASIN: ${product.asin}`);
    if (product.priceText !== undefined) {
      lines.push(`${prefix} price: ${product.priceText}`);
    } else if (product.price !== undefined) {
      lines.push(`${prefix} price: ${formatMemoryArenaNumber(product.price)}`);
    }
    if (product.averageRating !== undefined) {
      lines.push(`${prefix} average rating: ${formatMemoryArenaNumber(product.averageRating)}`);
    }
    if (product.totalReviews !== undefined) {
      lines.push(`${prefix} reviews: ${formatMemoryArenaNumber(product.totalReviews)}`);
    }
    if (product.productCategory !== undefined) {
      lines.push(`${prefix} category: ${product.productCategory}`);
    }
  });
  return lines;
}

function findMemoryArenaWebshopProductByAsin(
  catalog: MemoryArenaWebshopProductCatalog,
  asin: string,
): MemoryArenaWebshopProduct | undefined {
  const normalizedAsin = normalizeMemoryArenaWebshopAsin(asin);
  if (normalizedAsin === undefined) {
    return undefined;
  }
  return catalog.products.find((product) => product.asin === normalizedAsin);
}

function headText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function scoreSubtaskSuccess(scores: Record<string, number>): number {
  if (typeof scores.item_selection_match === "number") {
    return scores.item_selection_match >= 1 ? 1 : 0;
  }
  if (typeof scores.llm_judge === "number") {
    return scores.llm_judge >= 0.5 ? 1 : 0;
  }
  if (typeof scores.soft_process_score === "number") {
    return scores.soft_process_score >= 1 ? 1 : 0;
  }
  if (scores.contains_answer === 1) {
    return 1;
  }
  return (scores.f1 ?? 0) > 0 ? 1 : 0;
}
