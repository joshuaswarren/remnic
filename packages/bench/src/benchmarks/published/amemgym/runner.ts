/**
 * AMemGym runner migrated into @remnic/bench for phase 1.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Message } from "../../../adapters/types.js";
import { answerBenchmarkQuestion } from "../../../answering.js";
import { DEFAULT_BENCH_RECALL_BUDGET_CHARS } from "../../../recall-budget.js";
import {
  AMEMGYM_SMOKE_FIXTURE,
  type AMemGymProfile,
  type AMemGymQA,
  type AMemGymSession,
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
  timed,
} from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";

const DATASET_FILENAMES = [
  "amemgym-v1-base.json",
  "amemgym-tasks.json",
  "data.json",
] as const;
const AMEMGYM_STORE_CHUNK_SIZE = 20;

/**
 * For each QA, find the correct answer based on the final state.
 * The QA has answer_choices, each tied to specific state values.
 * We pick the one matching the user's final state.
 */
function findExpectedAnswerChoice(
  qa: AMemGymQA,
  finalState: Record<string, string>,
): { index: number; choice: AMemGymQA["answer_choices"][number] } | undefined {
  for (let index = 0; index < qa.answer_choices.length; index += 1) {
    const choice = qa.answer_choices[index]!;
    const requiredStates = choice.state;
    const matchValues = qa.required_info.map((key) => finalState[key]);
    if (requiredStates.length === matchValues.length &&
      requiredStates.every((s, i) => s === matchValues[i])) {
      return { index, choice };
    }
  }
  return undefined;
}

export const amemGymDefinition: BenchmarkDefinition = {
  id: "amemgym",
  title: "AMemGym",
  tier: "published",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "amemgym",
    version: "2.0.0",
    description:
      "Interactive personalization benchmark across evolving user profiles and memory probes.",
    category: "agentic",
    citation:
      "AMemGym: Interactive Memory Benchmarking for Assistants in Long-Horizon Conversations (2025)",
  },
};

export async function runAMemGymBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const profiles = await loadDataset(options.mode, options.datasetDir, options.limit);
  const tasks: TaskResult[] = [];

  const totalTasks = profiles.reduce((sum, profile) => sum + profile.qas.length, 0);

  for (let profileIndex = 0; profileIndex < profiles.length; profileIndex += 1) {
    const profile = profiles[profileIndex]!;
    await options.system.reset();

    const sessionId = `amemgym-${profile.id}`;
    const finalState: Record<string, string> = {};
    const profileMessages: Message[] = [];
    const currentExposedState: Record<string, string> = {};

    for (const period of profile.periods) {
      Object.assign(finalState, period.state);

      for (const session of period.sessions) {
        Object.assign(currentExposedState, session.exposed_states);
        profileMessages.push(...buildSessionMessages(session));
      }
    }

    profileMessages.push(...buildCurrentStateMessages(currentExposedState));

    await storeMessagesInChunks(options, sessionId, profileMessages);

    try {
      await options.system.drain?.();
    } catch (drainErr) {
      throw new Error(
        `AMemGym drain failed for profile ${profile.id}: ${drainErr instanceof Error ? drainErr.message : String(drainErr)}`,
      );
    }

    for (
      let questionIndex = 0;
      questionIndex < profile.qas.length;
      questionIndex += 1
    ) {
      const qa = profile.qas[questionIndex]!;
      const taskResultId = `${profile.id}-q${questionIndex}`;
      const expectedChoice = findExpectedAnswerChoice(qa, finalState);
      if (!expectedChoice) {
        throw new Error(
          `AMemGym profile ${profile.id} question ${questionIndex} final state does not match any answer_choices state`,
        );
      }
      const expectedAnswer = expectedChoice.choice.answer;
      const benchmarkQuestion = formatAMemGymQuestion(qa);

      try {
        const { result: recallText, durationMs } = await timed(async () => {
          return options.system.recall(
            sessionId,
            qa.query,
            DEFAULT_BENCH_RECALL_BUDGET_CHARS,
          );
        });
        const answered = await answerBenchmarkQuestion({
          question: benchmarkQuestion,
          recalledText: recallText,
          responder: options.system.responder,
          answerMode: "strict",
        });
        const selectedChoice = parseAMemGymChoice(answered.finalAnswer, qa);
        const answerForScoring = selectedChoice?.choice.answer ?? answered.finalAnswer;

        const scores: Record<string, number> = {
          f1: f1Score(answerForScoring, expectedAnswer),
          contains_answer: containsAnswer(answerForScoring, expectedAnswer),
          qa_accuracy:
            selectedChoice && expectedChoice && selectedChoice.index === expectedChoice.index
              ? 1
              : 0,
        };
        const judgeResult = await llmJudgeScoreDetailed(
          options.system.judge,
          qa.query,
          answerForScoring,
          expectedAnswer,
        );
        if (judgeResult.score >= 0) {
          scores.llm_judge = judgeResult.score;
        }

        tasks.push({
          taskId: taskResultId,
          question: benchmarkQuestion,
          expected: expectedAnswer,
          actual: answered.finalAnswer,
          scores,
          latencyMs: durationMs + answered.latencyMs + judgeResult.latencyMs,
          tokens: {
            input: answered.tokens.input + judgeResult.tokens.input,
            output: answered.tokens.output + judgeResult.tokens.output,
          },
          details: {
            profileId: profile.id,
            profileName: profile.user_profile.name,
            questionIndex,
            originalQuery: qa.query,
            periodCount: profile.periods.length,
            requiredInfo: qa.required_info,
            expectedChoiceIndex:
              expectedChoice === undefined ? null : expectedChoice.index + 1,
            selectedChoiceIndex:
              selectedChoice === undefined ? null : selectedChoice.index + 1,
            selectedAnswer:
              selectedChoice === undefined ? null : selectedChoice.choice.answer,
            scoredAnswer: answerForScoring,
            recalledLength: recallText.length,
            answeredLength: answered.finalAnswer.length,
            recalledText: recallText,
            answeredText: answered.finalAnswer,
            responderModel: answered.model,
            judgeModel: judgeResult.model,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  [WARN] amemgym task ${taskResultId} failed: ${message}`);
        tasks.push({
          taskId: taskResultId,
          question: benchmarkQuestion,
          expected: expectedAnswer,
          actual: `(error: ${message})`,
          scores: { f1: -1, contains_answer: -1, qa_accuracy: -1, llm_judge: -1 },
          latencyMs: 0,
          tokens: { input: 0, output: 0 },
          details: { error: message },
        });
      }

      options.onTaskComplete?.(tasks[tasks.length - 1]!, tasks.length, totalTasks);
    }
  }

  const remnicVersion = await getRemnicVersion();
  const totalLatencyMs = tasks.reduce((sum, task) => sum + task.latencyMs, 0);
  const totalInputTokens = tasks.reduce(
    (sum, task) => sum + task.tokens.input,
    0,
  );
  const totalOutputTokens = tasks.reduce(
    (sum, task) => sum + task.tokens.output,
    0,
  );

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

function formatAMemGymQuestion(qa: AMemGymQA): string {
  const choices = qa.answer_choices
    .map((choice, index) => `${index + 1}. ${choice.answer}`)
    .join("\n");

  return [
    qa.query,
    "",
    "Choose the single best answer using the user's current remembered state.",
    "Return only the option number and no explanation.",
    "",
    "Answer choices:",
    choices,
  ].join("\n");
}

function parseAMemGymChoice(
  rawAnswer: string,
  qa: AMemGymQA,
): { index: number; choice: AMemGymQA["answer_choices"][number] } | undefined {
  const trimmed = rawAnswer.trim();
  const optionCount = qa.answer_choices.length;
  const selectedNumber = parseAMemGymOptionNumber(trimmed, optionCount);
  if (selectedNumber !== undefined) {
    const index = selectedNumber - 1;
    const choice = qa.answer_choices[index];
    if (choice) {
      return { index, choice };
    }
    return undefined;
  }
  let fallbackAnswer = rawAnswer;
  let forceTextFallback = false;
  let blockTextFallbackSelection = false;
  const normalizedTrimmedAnswer = normalizeForChoiceMatch(trimmed);
  const exactTrimmedMatches = qa.answer_choices
    .map((choice, index) => ({
      index,
      choice,
      normalized: normalizeForChoiceMatch(choice.answer),
    }))
    .filter(
      (candidate) =>
        candidate.normalized.length > 0
        && normalizedTrimmedAnswer === candidate.normalized,
    );
  if (exactTrimmedMatches.length === 1) {
    const exactMatch = exactTrimmedMatches[0]!;
    return { index: exactMatch.index, choice: exactMatch.choice };
  }
  const plainTextOption = parseAMemGymPlainTextOptionNumber(trimmed);
  if (plainTextOption !== undefined) {
    const index = plainTextOption.selectedNumber - 1;
    const choice = qa.answer_choices[index];
    if (!choice) {
      return undefined;
    }
    if (
      plainOptionTextExactlyMatchesChoice(
        plainTextOption.choiceText,
        choice.answer,
      )
    ) {
      return { index, choice };
    }
    const hasConflictingOptionNumber = mentionsConflictingOptionNumber(
      removeFirstChoiceAnswerText(plainTextOption.choiceText, choice.answer),
      plainTextOption.selectedNumber,
      optionCount,
    );
    if (
      !hasConflictingOptionNumber
      &&
      plainOptionTextMatchesChoice(plainTextOption.choiceText, choice.answer)
    ) {
      return { index, choice };
    }
    if (hasConflictingOptionNumber) {
      fallbackAnswer = plainTextOption.choiceText;
      forceTextFallback = true;
      blockTextFallbackSelection = true;
    }
  }
  const normalizedAnswer = normalizeForChoiceMatch(fallbackAnswer);
  const normalizedChoices = qa.answer_choices.map((choice, index) => ({
    index,
    choice,
    normalized: normalizeForChoiceMatch(choice.answer),
  }));
  const numericChoiceNumberAttempt = !forceTextFallback
    && looksLikeChoiceNumberAttempt(trimmed);
  const numericAttemptPrefix = leadingNumericToken(normalizedAnswer);

  const exactMatches = normalizedChoices.filter(
    (candidate) =>
      candidate.normalized.length > 0
      && normalizedAnswer === candidate.normalized,
  );
  if (exactMatches.length === 1) {
    const exactMatch = exactMatches[0]!;
    if (
      !blockTextFallbackSelection
      && (
        !numericChoiceNumberAttempt
        || numericPrefixesAgree(numericAttemptPrefix, exactMatch.normalized)
      )
    ) {
      return { index: exactMatch.index, choice: exactMatch.choice };
    }
  }

  let bestSubstringLength = -1;
  let bestSubstringMatches: Array<{
    index: number;
    choice: AMemGymQA["answer_choices"][number];
    normalized: string;
  }> = [];
  for (let index = 0; index < qa.answer_choices.length; index += 1) {
    const candidate = normalizedChoices[index]!;
    if (
      candidate.normalized.length > 0
      && (!numericChoiceNumberAttempt
        || numericPrefixesAgree(numericAttemptPrefix, candidate.normalized))
      && containsNormalizedPhrase(normalizedAnswer, candidate.normalized)
    ) {
      if (candidate.normalized.length > bestSubstringLength) {
        bestSubstringLength = candidate.normalized.length;
        bestSubstringMatches = [candidate];
      } else if (candidate.normalized.length === bestSubstringLength) {
        bestSubstringMatches.push(candidate);
      }
    }
  }

  const uniqueMatch = bestSubstringMatches.length === 1
    ? bestSubstringMatches[0]
    : undefined;
  return uniqueMatch && !blockTextFallbackSelection
    ? { index: uniqueMatch.index, choice: uniqueMatch.choice }
    : undefined;
}

function parseAMemGymPlainTextOptionNumber(
  trimmedAnswer: string,
): { selectedNumber: number; choiceText: string } | undefined {
  const bareNumber = trimmedAnswer.match(
    /^\(?#?\s*(\d+)\s+(?!weeks?\b|days?\b|months?\b|years?\b|hours?\b|minutes?\b)(?<choiceText>\S.*)$/i,
  );
  if (bareNumber) {
    return {
      selectedNumber: Number.parseInt(bareNumber[1]!, 10),
      choiceText: bareNumber.groups!.choiceText!,
    };
  }

  const labeledNumber = trimmedAnswer.match(
    /^(?:the\s+)?(?:(?:correct|final|right)\s+)?(?:option|choice|answer)\s*(?:is\s*)?(?::|#)?\s*(?:(?:the\s+)?(?:(?:correct|final|right)\s+)?(?:option|choice|answer)\s*(?:is\s*)?(?::|#)?\s*)?\(?#?\s*(\d+)\s+(?<choiceText>\S.*)$/i,
  );
  if (labeledNumber) {
    return {
      selectedNumber: Number.parseInt(labeledNumber[1]!, 10),
      choiceText: labeledNumber.groups!.choiceText!,
    };
  }

  return undefined;
}

function plainOptionTextMatchesChoice(
  choiceText: string,
  choiceAnswer: string,
): boolean {
  const normalizedChoiceText = normalizeForChoiceMatch(choiceText);
  const normalizedChoiceAnswer = normalizeForChoiceMatch(choiceAnswer);
  return normalizedChoiceText.length > 0
    && normalizedChoiceAnswer.length > 0
    && (
      normalizedChoiceText === normalizedChoiceAnswer
      || containsNormalizedPhrase(normalizedChoiceText, normalizedChoiceAnswer)
    );
}

function plainOptionTextExactlyMatchesChoice(
  choiceText: string,
  choiceAnswer: string,
): boolean {
  const normalizedChoiceText = normalizeForChoiceMatch(choiceText);
  const normalizedChoiceAnswer = normalizeForChoiceMatch(choiceAnswer);
  return normalizedChoiceText.length > 0
    && normalizedChoiceAnswer.length > 0
    && normalizedChoiceText === normalizedChoiceAnswer;
}

function removeFirstChoiceAnswerText(
  choiceText: string,
  choiceAnswer: string,
): string {
  const choiceTextTokens = choiceMatchTokenSpans(choiceText);
  const choiceAnswerTokens = choiceMatchTokenSpans(choiceAnswer);
  if (
    choiceTextTokens.length === 0
    || choiceAnswerTokens.length === 0
    || choiceAnswerTokens.length > choiceTextTokens.length
  ) {
    return choiceText;
  }

  for (let index = 0; index <= choiceTextTokens.length - choiceAnswerTokens.length; index += 1) {
    const matches = choiceAnswerTokens.every(
      (token, offset) => choiceTextTokens[index + offset]!.token === token.token,
    );
    if (!matches) {
      continue;
    }

    const start = choiceTextTokens[index]!.start;
    const end = choiceTextTokens[index + choiceAnswerTokens.length - 1]!.end;
    return [
      choiceText.slice(0, start),
      choiceText.slice(end),
    ].join(" ");
  }

  return choiceText;
}

function choiceMatchTokenSpans(
  value: string,
): Array<{ token: string; start: number; end: number }> {
  return [...value.matchAll(/\w+/g)].map((match) => ({
    token: match[0].toLowerCase(),
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

function containsNormalizedPhrase(haystack: string, needle: string): boolean {
  const haystackTokens = haystack.split(" ").filter((token) => token.length > 0);
  const needleTokens = needle.split(" ").filter((token) => token.length > 0);
  if (needleTokens.length === 0 || needleTokens.length > haystackTokens.length) {
    return false;
  }

  for (let index = 0; index <= haystackTokens.length - needleTokens.length; index += 1) {
    if (needleTokens.every((token, offset) => haystackTokens[index + offset] === token)) {
      return true;
    }
  }
  return false;
}

function numericPrefixesAgree(
  answerPrefix: string | undefined,
  choiceText: string,
): boolean {
  const choicePrefix = leadingNumericToken(choiceText);
  return answerPrefix !== undefined
    && choicePrefix !== undefined
    && answerPrefix === choicePrefix;
}

function leadingNumericToken(value: string): string | undefined {
  return value.match(/^(\d+)\b/)?.[1];
}

function parseAMemGymOptionNumber(
  trimmedAnswer: string,
  optionCount: number,
): number | undefined {
  const bareNumber = trimmedAnswer.match(
    /^\(?#?\s*(\d+)\s*(?:\)(?!\s+\S))?(?<tail>\s*(?:\)\s+\S.*|\([^)]*\).*|because.*|[,.;:\-](?!\s*#?\d).*)?)$/i,
  );
  if (bareNumber) {
    const selectedNumber = Number.parseInt(bareNumber[1]!, 10);
    if (mentionsConflictingOptionNumber(bareNumber.groups?.tail ?? "", selectedNumber, optionCount)) {
      return undefined;
    }
    return selectedNumber;
  }

  const labeledNumber = trimmedAnswer.match(
    /^(?:the\s+)?(?:(?:correct|final|right)\s+)?(?:option|choice|answer)\s*(?:is\s*)?(?::|#)?\s*(?:(?:the\s+)?(?:(?:correct|final|right)\s+)?(?:option|choice|answer)\s*(?:is\s*)?(?::|#)?\s*)?\(?#?\s*(\d+)\s*(?:\)(?!\s+\S))?(?<tail>\s*(?:\)\s+\S.*|\([^)]*\).*|because.*|[,.;:\-](?!\s*#?\d).*)?)$/i,
  );
  if (labeledNumber) {
    const selectedNumber = Number.parseInt(labeledNumber[1]!, 10);
    if (mentionsConflictingOptionNumber(labeledNumber.groups?.tail ?? "", selectedNumber, optionCount)) {
      return undefined;
    }
    return selectedNumber;
  }
  return undefined;
}

function looksLikeChoiceNumberAttempt(trimmedAnswer: string): boolean {
  if (/^(?:the\s+)?(?:(?:correct|final|right)\s+)?(?:option|choice|answer)\s*(?:is\s*)?(?::|#)?\s*(?:(?:the\s+)?(?:(?:correct|final|right)\s+)?(?:option|choice|answer)\s*(?:is\s*)?(?::|#)?\s*)?\(?#?\s*\d+/i.test(trimmedAnswer)) {
    return true;
  }
  return /^\(?#?\s*\d+\s*\)?\s+(?!weeks?\b|days?\b|months?\b|years?\b|hours?\b|minutes?\b)/i.test(trimmedAnswer);
}

function mentionsConflictingOptionNumber(
  value: string,
  selectedNumber: number,
  optionCount: number,
): boolean {
  const trimmed = value.trim();
  for (const match of trimmed.matchAll(/\b(?:option|choice|answer)\s*#?\s*(\d+)\b/gi)) {
    if (isConflictingOptionRef(match[1]!, selectedNumber, optionCount)) {
      return true;
    }
  }
  for (const match of trimmed.matchAll(/#\s*(\d+)\b/gi)) {
    if (isConflictingOptionRef(match[1]!, selectedNumber, optionCount)) {
      return true;
    }
  }
  for (const match of trimmed.matchAll(
    /\b(\d+)\s+(?:(?:might|may|could|would|should)\s+be\s+|is\s+(?:also\s+)?|also\s+)?(?:right|correct|valid|the\s+(?:answer|option|choice))\b/gi,
  )) {
    if (isConflictingOptionRef(match[1]!, selectedNumber, optionCount)) {
      return true;
    }
  }
  for (const match of trimmed.matchAll(
    /\b(?:or|maybe|possibly|probably|perhaps|alternatively)\s+#?\s*(\d+)\b/gi,
  )) {
    if (isConflictingOptionRef(match[1]!, selectedNumber, optionCount)) {
      return true;
    }
  }

  const punctuationNumber = trimmed.match(
    /^[,.;:\-]\s*(?:#?(\d+)\b|(?:or|maybe|possibly|probably|perhaps|alternatively)\s+#?(\d+)\b)/i,
  );
  const ambiguousNumber = punctuationNumber?.[1] ?? punctuationNumber?.[2];
  return ambiguousNumber !== undefined
    && isConflictingOptionRef(ambiguousNumber, selectedNumber, optionCount);
}

function isConflictingOptionRef(
  rawNumber: string,
  selectedNumber: number,
  optionCount: number,
): boolean {
  const optionNumber = Number.parseInt(rawNumber, 10);
  return optionNumber >= 1
    && optionNumber <= optionCount
    && optionNumber !== selectedNumber;
}

function normalizeForChoiceMatch(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function loadDataset(
  mode: "full" | "quick",
  datasetDir: string | undefined,
  limit?: number,
): Promise<AMemGymProfile[]> {
  const normalizedLimit = normalizeLimit(limit);
  const ensureDatasetProfiles = (
    profiles: AMemGymProfile[],
  ): AMemGymProfile[] => {
    if (profiles.length === 0) {
      throw new Error(
        "AMemGym dataset is empty after applying the requested limit.",
      );
    }
    return profiles;
  };

  if (datasetDir) {
    const datasetErrors: string[] = [];
    for (const filename of DATASET_FILENAMES) {
      try {
        const raw = await readFile(path.join(datasetDir, filename), "utf8");
        const parsed = parseDataset(raw, filename, normalizedLimit);
        return ensureDatasetProfiles(parsed);
      } catch (error) {
        if (!isFileNotFoundError(error)) {
          throw new Error(
            `AMemGym dataset file ${filename} is invalid: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        datasetErrors.push(
          `${filename}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    throw new Error(
      `AMemGym dataset not found under ${datasetDir}. Tried ${DATASET_FILENAMES.join(", ")}. Errors: ${datasetErrors.join(" | ")}`,
    );
  }

  if (mode === "full") {
    throw new Error(
      "AMemGym full mode requires datasetDir. Pass a dataset path or use quick mode to run the bundled smoke fixture.",
    );
  }

  return ensureDatasetProfiles(applyLimit(AMEMGYM_SMOKE_FIXTURE, normalizedLimit));
}

function parseDataset(
  raw: string,
  filename: string,
  limit: number | undefined,
): AMemGymProfile[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(
      `AMemGym dataset file ${filename} must contain an array of user profiles.`,
    );
  }
  return validateDatasetProfiles(applyLimit(parsed, limit), filename);
}

function validateDatasetProfiles(
  profiles: unknown[],
  filename: string,
): AMemGymProfile[] {
  return profiles.map((rawProfile, profileIndex) => {
    if (!rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) {
      throw new Error(`AMemGym dataset file ${filename} profile ${profileIndex} must be an object.`);
    }
    const profile = rawProfile as AMemGymProfile;
    const profileId = typeof profile.id === "string" && profile.id.length > 0
      ? profile.id
      : `#${profileIndex}`;
    if (!Array.isArray(profile.periods)) {
      throw new Error(`AMemGym profile ${profileId} periods must be an array.`);
    }
    if (!Array.isArray(profile.qas)) {
      throw new Error(`AMemGym profile ${profileId} qas must be an array.`);
    }

    const finalState: Record<string, string> = {};
    for (const [periodIndex, period] of profile.periods.entries()) {
      if (!period || typeof period !== "object" || Array.isArray(period)) {
        throw new Error(`AMemGym profile ${profileId} period ${periodIndex} must be an object.`);
      }
      if (!period.state || typeof period.state !== "object" || Array.isArray(period.state)) {
        throw new Error(`AMemGym profile ${profileId} period ${periodIndex} state must be an object.`);
      }
      for (const [key, value] of Object.entries(period.state)) {
        if (typeof value !== "string") {
          throw new Error(`AMemGym profile ${profileId} final state ${key} must be a string.`);
        }
        finalState[key] = value;
      }
    }

    for (const [questionIndex, qa] of profile.qas.entries()) {
      if (!qa || typeof qa !== "object" || Array.isArray(qa)) {
        throw new Error(`AMemGym profile ${profileId} question ${questionIndex} must be an object.`);
      }
      if (
        !Array.isArray(qa.required_info) ||
        qa.required_info.length === 0 ||
        qa.required_info.some((value) => typeof value !== "string" || value.length === 0)
      ) {
        throw new Error(`AMemGym profile ${profileId} question ${questionIndex} required_info must be a non-empty string array.`);
      }
      if (!Array.isArray(qa.answer_choices) || qa.answer_choices.length === 0) {
        throw new Error(`AMemGym profile ${profileId} question ${questionIndex} answer_choices must be a non-empty array.`);
      }
      for (const [choiceIndex, choice] of qa.answer_choices.entries()) {
        if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
          throw new Error(`AMemGym profile ${profileId} question ${questionIndex} answer choice ${choiceIndex} must be an object.`);
        }
        if (
          !Array.isArray(choice.state) ||
          choice.state.length !== qa.required_info.length ||
          choice.state.some((value) => typeof value !== "string")
        ) {
          throw new Error(`AMemGym profile ${profileId} question ${questionIndex} answer choice ${choiceIndex} state must match required_info length.`);
        }
        if (typeof choice.answer !== "string" || choice.answer.length === 0) {
          throw new Error(`AMemGym profile ${profileId} question ${questionIndex} answer choice ${choiceIndex} answer must be a non-empty string.`);
        }
      }
      if (!findExpectedAnswerChoice(qa, finalState)) {
        throw new Error(
          `AMemGym profile ${profileId} question ${questionIndex} final state does not match any answer_choices state.`,
        );
      }
    }

    return profile;
  });
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(
      "AMemGym limit must be a non-negative integer when provided.",
    );
  }
  return limit;
}

function applyLimit<T>(items: T[], limit: number | undefined): T[] {
  if (limit === undefined) {
    return items;
  }
  return items.slice(0, limit);
}

async function storeMessagesInChunks(
  options: ResolvedRunBenchmarkOptions,
  sessionId: string,
  messages: Message[],
): Promise<void> {
  for (let index = 0; index < messages.length; index += AMEMGYM_STORE_CHUNK_SIZE) {
    await options.system.store(
      sessionId,
      messages.slice(index, index + AMEMGYM_STORE_CHUNK_SIZE),
    );
  }
}

function buildSessionMessages(session: AMemGymSession): Message[] {
  const messages: Message[] = [];

  if (session.event) {
    messages.push({
      role: "assistant",
      content: `[Context update]: ${session.event}`,
    });
  }

  const stateDescription = formatExposedStateUpdate(session.exposed_states);
  if (stateDescription) {
    messages.push({
      role: "user",
      content: `[User state update]: ${stateDescription}`,
    });
  }

  if (session.query) {
    messages.push({
      role: "user",
      content: session.query,
    });
  }

  for (const message of session.messages) {
    messages.push({
      role: normalizeRole(message.role),
      content: message.content,
    });
  }

  return messages;
}

function formatExposedStateUpdate(
  exposedStates: Record<string, string>,
): string | undefined {
  const entries = Object.entries(exposedStates).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) {
    return undefined;
  }
  return entries.map(([key, value]) => `${key}: ${value}`).join(", ");
}

function buildCurrentStateMessages(
  currentState: Record<string, string>,
): Message[] {
  const entries = Object.entries(currentState).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return entries.map(([key, value]) => ({
    role: "user",
    content:
      `[Current user state]: ${key}: ${value} (${humanizeStateToken(key)}: ${humanizeStateToken(value)})`,
  }));
}

function humanizeStateToken(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRole(role: string): Message["role"] {
  if (role === "assistant" || role === "system") {
    return role;
  }
  return "user";
}
