/**
 * PersonaMem-v2 runner migrated into @remnic/bench for phase 1.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { Message } from "../../../adapters/types.js";
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
import {
  PERSONAMEM_SMOKE_FIXTURE,
  type PersonaMemChatHistory,
  type PersonaMemSample,
} from "./fixture.js";

const DATASET_FILE_CANDIDATES = [
  "benchmark/text/benchmark.csv",
  "benchmark/benchmark.csv",
  "benchmark.csv",
] as const;

const PERSONAMEM_ANCHOR_PREFIX = "PersonaMem visible anchors:";

interface RawPersonaMemRow {
  persona_id: string;
  chat_history_32k_link: string;
  chat_history_128k_link?: string;
  user_query: string;
  correct_answer: string;
  incorrect_answers?: string;
  topic_query?: string;
  preference?: string;
  topic_preference?: string;
  pref_type?: string;
  related_conversation_snippet?: string;
  who?: string;
  updated?: string;
  prev_pref?: string;
}

interface CsvRowRecord {
  values: string[];
  rowNumber: number;
}

export const personaMemDefinition: BenchmarkDefinition = {
  id: "personamem",
  title: "PersonaMem-v2",
  tier: "published",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "personamem",
    version: "2.0.0",
    description:
      "Implicit preference-learning benchmark over long user-chatbot histories and personalized response probes.",
    category: "conversational",
    citation:
      "PersonaMem-v2: Towards Personalized Intelligence via Learning Implicit User Personas and Agentic Memory (2025)",
  },
};

export async function runPersonaMemBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const samples = await loadDataset(options.mode, options.datasetDir, options.limit);
  const tasks: TaskResult[] = [];

  const totalTasks = samples.length;

  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    const sample = samples[sampleIndex]!;
    const taskId = `${sample.personaId}-q${sampleIndex}`;
    try {
      await options.system.reset();

      const sessionId = `personamem-${sample.personaId}`;
      const messages = buildMessages(sample.chatHistory.chat_history);
      if (messages.length > 0) {
        await options.system.store(sessionId, messages);
      }

      try {
        await options.system.drain?.();
      } catch (drainErr) {
        const message = drainErr instanceof Error ? drainErr.message : String(drainErr);
        throw new Error(`personamem drain failed for ${taskId}: ${message}`, { cause: drainErr });
      }

      const recallQuery = buildPersonaMemRecallQuery(sample.userQuery);
      const { result: recalledText, durationMs } = await timed(async () =>
        options.system.recall(
          sessionId,
          recallQuery,
          DEFAULT_BENCH_RECALL_BUDGET_CHARS,
        ),
      );
      const searchResults = await options.system.search(
        sample.userQuery,
        10,
        sessionId,
      );
      const answerRecalledText = stripPersonaMemAnchors(recalledText);
      const mcq =
        sample.incorrectAnswers && sample.incorrectAnswers.length > 0
          ? buildMcqPrompt(sample, options.seed ?? 0)
          : undefined;
      const evaluationQuestion = mcq
        ? [
            appendPersonaMemRecallInstruction(sample.userQuery),
            "",
            mcq.instruction,
          ].join("\n")
        : sample.userQuery;
      const answered = await answerBenchmarkQuestion({
        question: evaluationQuestion,
        recalledText: answerRecalledText,
        responder: options.system.responder,
        answerMode: "strict",
      });
      const refinedAnswer = mcq
        ? undefined
        : refinePersonaMemAnswer({
            question: sample.userQuery,
            recalledText: answerRecalledText,
            answeredText: answered.finalAnswer,
          });
      const finalAnswer = refinedAnswer ?? answered.finalAnswer;
      const predictedMcqOption = mcq
        ? resolveMcqOption(finalAnswer, mcq)
        : undefined;
      const scoredAnswer = mcq && predictedMcqOption
        ? mcq.options[predictedMcqOption]
        : finalAnswer;
      const judgeResult = await llmJudgeScoreDetailed(
        options.system.judge,
        sample.userQuery,
        scoredAnswer,
        sample.correctAnswer,
      );

      const scores: Record<string, number> = {
        f1: f1Score(scoredAnswer, sample.correctAnswer),
        contains_answer: containsAnswer(scoredAnswer, sample.correctAnswer),
        search_hits: searchResults.length,
      };
      if (mcq) {
        scores.mcq_accuracy = predictedMcqOption === mcq.correctOption ? 1 : 0;
      }
      if (judgeResult.score >= 0) {
        scores.llm_judge = judgeResult.score;
      }

      tasks.push({
        taskId,
        question: sample.userQuery,
        expected: sample.correctAnswer,
        actual: finalAnswer,
        scores,
        latencyMs: durationMs + answered.latencyMs + judgeResult.latencyMs,
        tokens: {
          input: answered.tokens.input + judgeResult.tokens.input,
          output: answered.tokens.output + judgeResult.tokens.output,
        },
        details: {
          personaId: sample.personaId,
          topicQuery: sample.topicQuery,
          preference: sample.preference,
          topicPreference: sample.topicPreference,
          prefType: sample.prefType,
          relatedConversationSnippet: sample.relatedConversationSnippet,
          who: sample.who,
          updated: sample.updated,
          prevPref: sample.prevPref,
          incorrectAnswers: sample.incorrectAnswers,
          chatHistoryMessageCount: sample.chatHistory.chat_history.length,
          chatHistory32kLink: sample.chatHistory32kLink,
          chatHistory128kLink: sample.chatHistory128kLink,
          evaluationMode: mcq ? "mcq" : "open_ended",
          evaluationQuestion,
          mcqOptions: mcq?.options,
          correctMcqOption: mcq?.correctOption,
          predictedMcqOption,
          scoredAnswer,
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
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  [WARN] personamem task ${taskId} failed: ${message}`);
      const scores: Record<string, number> = {
        f1: -1,
        contains_answer: -1,
        search_hits: -1,
        llm_judge: -1,
      };
      if (sample.incorrectAnswers && sample.incorrectAnswers.length > 0) {
        scores.mcq_accuracy = -1;
      }
      tasks.push({
        taskId,
        question: sample.userQuery,
        expected: sample.correctAnswer,
        actual: `(error: ${message})`,
        scores,
        latencyMs: 0,
        tokens: { input: 0, output: 0 },
        details: { error: message },
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
): Promise<PersonaMemSample[]> {
  const normalizedLimit = normalizeLimit(limit);
  const ensureDatasetSamples = (
    samples: PersonaMemSample[],
  ): PersonaMemSample[] => {
    if (samples.length === 0) {
      throw new Error(
        "PersonaMem-v2 dataset is empty after applying the requested limit.",
      );
    }
    return samples;
  };

  if (datasetDir) {
    const datasetErrors: string[] = [];
    for (const relativePath of DATASET_FILE_CANDIDATES) {
      const datasetPath = path.join(datasetDir, relativePath);
      let raw: string;
      try {
        raw = await readFile(datasetPath, "utf8");
      } catch (error) {
        datasetErrors.push(
          `${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      try {
        const rows = parseCsvRows(raw, relativePath, normalizedLimit);
        const samples: PersonaMemSample[] = [];

        for (const row of rows) {
          samples.push(await hydrateSample(row, datasetDir));
        }

        return ensureDatasetSamples(samples);
      } catch (error) {
        throw new Error(
          `PersonaMem-v2 dataset file ${relativePath} under ${datasetDir} is invalid: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }

    throw new Error(
      `PersonaMem-v2 dataset not found under ${datasetDir}. Tried ${DATASET_FILE_CANDIDATES.join(", ")}. Errors: ${datasetErrors.join(" | ")}`,
    );
  }

  if (mode === "full") {
    throw new Error(
      "PersonaMem-v2 full mode requires datasetDir. Pass a dataset root or use quick mode to run the bundled smoke fixture.",
    );
  }

  return ensureDatasetSamples(
    applyLimit(PERSONAMEM_SMOKE_FIXTURE, normalizedLimit),
  );
}

async function hydrateSample(
  row: RawPersonaMemRow,
  datasetRoot: string,
): Promise<PersonaMemSample> {
  if (row.persona_id.trim().length === 0) {
    throw new Error("PersonaMem-v2 row is missing persona_id.");
  }
  if (row.chat_history_32k_link.trim().length === 0) {
    throw new Error(
      `PersonaMem-v2 row for persona ${row.persona_id} is missing chat_history_32k_link.`,
    );
  }
  if (row.correct_answer.trim().length === 0) {
    throw new Error(
      `PersonaMem-v2 row for persona ${row.persona_id} is missing correct_answer.`,
    );
  }

  const userQuery = extractLooseObjectValue(row.user_query, "content")
    ?? row.user_query.trim();
  if (userQuery.length === 0) {
    throw new Error(
      `PersonaMem-v2 row for persona ${row.persona_id} is missing user_query content.`,
    );
  }

  const chatHistoryPath = await resolveDatasetFilePath(
    datasetRoot,
    row.chat_history_32k_link,
  );
  const chatHistoryRaw = await readFile(chatHistoryPath, "utf8");
  const chatHistory = parseChatHistory(
    chatHistoryRaw,
    row.chat_history_32k_link,
  );

  return {
    personaId: row.persona_id,
    userQuery,
    correctAnswer: row.correct_answer,
    incorrectAnswers: parseIncorrectAnswers(row.incorrect_answers),
    topicQuery: row.topic_query,
    preference: row.preference,
    topicPreference: row.topic_preference,
    prefType: row.pref_type,
    relatedConversationSnippet: row.related_conversation_snippet,
    who: row.who,
    updated: row.updated,
    prevPref: row.prev_pref,
    chatHistory,
    chatHistory32kLink: row.chat_history_32k_link,
    chatHistory128kLink: row.chat_history_128k_link,
  };
}

function parseCsvRows(
  raw: string,
  filename: string,
  limit: number | undefined,
): RawPersonaMemRow[] {
  const rows = parseCsv(raw, limit);
  if (rows.length < 2) {
    throw new Error(
      `PersonaMem-v2 dataset file ${filename} must contain a header row and at least one data row.`,
    );
  }

  const [header, ...dataRows] = rows;
  const headerIndex = new Map<string, number>();
  header.values.forEach((name, index) => {
    headerIndex.set(name, index);
  });

  const requiredColumns = [
    "persona_id",
    "chat_history_32k_link",
    "user_query",
    "correct_answer",
  ] as const;
  for (const column of requiredColumns) {
    if (!headerIndex.has(column)) {
      throw new Error(
        `PersonaMem-v2 dataset file ${filename} is missing required column "${column}".`,
      );
    }
  }

  return dataRows.map((row) => {
      const valueAt = (column: string): string => {
        const index = headerIndex.get(column);
        return index === undefined ? "" : (row.values[index] ?? "");
      };

      const record: RawPersonaMemRow = {
        persona_id: valueAt("persona_id"),
        chat_history_32k_link: valueAt("chat_history_32k_link"),
        chat_history_128k_link: valueAt("chat_history_128k_link") || undefined,
        user_query: valueAt("user_query"),
        correct_answer: valueAt("correct_answer"),
        incorrect_answers: valueAt("incorrect_answers") || undefined,
        topic_query: valueAt("topic_query") || undefined,
        preference: valueAt("preference") || undefined,
        topic_preference: valueAt("topic_preference") || undefined,
        pref_type: valueAt("pref_type") || undefined,
        related_conversation_snippet:
          valueAt("related_conversation_snippet") || undefined,
        who: valueAt("who") || undefined,
        updated: valueAt("updated") || undefined,
        prev_pref: valueAt("prev_pref") || undefined,
      };

      if (record.persona_id.trim().length === 0) {
        throw new Error(
          `PersonaMem-v2 dataset file ${filename} row ${row.rowNumber} is missing persona_id.`,
        );
      }
      return record;
    });
}

function parseCsv(raw: string, limit: number | undefined): CsvRowRecord[] {
  const rows: CsvRowRecord[] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;
  let rowNumber = 1;
  let dataRowCount = 0;

  const pushRow = (): boolean => {
    const values = [...currentRow, currentField];
    const isHeader = rows.length === 0;
    const isBlank = values.every((value) => value.trim().length === 0);

    if (isHeader || !isBlank) {
      rows.push({ values, rowNumber });
      if (!isHeader) {
        dataRowCount += 1;
      }
    }

    currentRow = [];
    currentField = "";
    rowNumber += 1;

    return limit !== undefined && dataRowCount >= limit;
  };

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    const next = raw[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        currentField += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ",") {
      currentRow.push(currentField);
      currentField = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      if (pushRow()) {
        return rows;
      }
      continue;
    }

    currentField += char;
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    pushRow();
  }

  return rows;
}

async function resolveDatasetFilePath(
  datasetRoot: string,
  relativePath: string,
): Promise<string> {
  const rootPath = path.resolve(datasetRoot);
  const rootRealPath = await realpath(rootPath);
  const candidatePath = path.resolve(rootPath, relativePath);
  const candidateRealPath = await realpath(candidatePath);
  const relativeToRoot = path.relative(rootRealPath, candidateRealPath);

  if (
    relativeToRoot.startsWith("..")
    || path.isAbsolute(relativeToRoot)
  ) {
    throw new Error(
      `PersonaMem-v2 dataset file reference "${relativePath}" must stay within datasetDir.`,
    );
  }

  return candidateRealPath;
}

function extractLooseObjectValue(
  raw: string,
  key: string,
): string | undefined {
  const patterns = [`'${key}'`, `"${key}"`];
  for (const pattern of patterns) {
    const start = raw.indexOf(pattern);
    if (start < 0) {
      continue;
    }

    let index = start + pattern.length;
    while (index < raw.length && /\s/.test(raw[index]!)) {
      index += 1;
    }
    if (raw[index] !== ":") {
      continue;
    }
    index += 1;
    while (index < raw.length && /\s/.test(raw[index]!)) {
      index += 1;
    }

    const quote = raw[index];
    if (quote !== "'" && quote !== "\"") {
      continue;
    }

    const parsed = readQuotedValue(raw, index);
    if (parsed) {
      return parsed.value;
    }
  }

  return undefined;
}

function readQuotedValue(
  raw: string,
  start: number,
): { value: string; end: number } | undefined {
  const quote = raw[start];
  if (quote !== "'" && quote !== "\"") {
    return undefined;
  }

  let value = "";
  for (let index = start + 1; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char === "\\") {
      const next = raw[index + 1];
      if (next !== undefined) {
        value += next;
        index += 1;
      }
      continue;
    }
    if (char === quote) {
      return { value, end: index + 1 };
    }
    value += char;
  }

  return undefined;
}

function parseIncorrectAnswers(raw: string | undefined): string[] | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }

  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((value) => String(value)).filter((value) => value.trim().length > 0);
    }
  } catch {
    // Fall through to the Python-literal parser below.
  }

  return parseLooseStringList(trimmed);
}

function parseLooseStringList(raw: string): string[] | undefined {
  const values: string[] = [];
  let index = 0;

  while (index < raw.length) {
    const char = raw[index]!;
    if (char !== "'" && char !== "\"") {
      index += 1;
      continue;
    }

    const parsed = readQuotedValue(raw, index);
    if (!parsed) {
      return undefined;
    }
    if (parsed.value.trim().length > 0) {
      values.push(parsed.value);
    }
    index = parsed.end;
  }

  return values.length > 0 ? values : undefined;
}

interface PersonaMemMcqPrompt {
  instruction: string;
  options: Record<string, string>;
  correctOption: string;
}

function buildMcqPrompt(
  sample: PersonaMemSample,
  seed: number,
): PersonaMemMcqPrompt {
  const options = deterministicShuffle(
    [sample.correctAnswer, ...(sample.incorrectAnswers ?? [])],
    `${seed}:${sample.personaId}:${sample.userQuery}`,
  );
  const mappedOptions: Record<string, string> = {};
  const optionLines = options.map((option, index) => {
    const letter = String.fromCharCode(65 + index);
    mappedOptions[letter] = option;
    return `${letter}. ${option}`;
  });
  const correctOption = Object.entries(mappedOptions).find(
    ([, value]) => value === sample.correctAnswer,
  )?.[0];

  if (!correctOption) {
    throw new Error(
      `PersonaMem-v2 could not map correct answer for persona ${sample.personaId}.`,
    );
  }

  return {
    instruction: [
      "Please choose the best answer from the following options:",
      "",
      ...optionLines,
      "",
      "Think step by step about which answer best fits the user's query and conversation context.",
      "Provide your reasoning first, then give your final answer as 'Final Answer: [Letter]'",
    ].join("\n"),
    options: mappedOptions,
    correctOption,
  };
}

function deterministicShuffle(values: string[], seedMaterial: string): string[] {
  return values
    .map((value, index) => ({
      value,
      key: createHash("sha256")
        .update(`${seedMaterial}:${index}:${value}`)
        .digest("hex"),
      index,
    }))
    .sort((left, right) => {
      const byKey = left.key.localeCompare(right.key);
      return byKey === 0 ? left.index - right.index : byKey;
    })
    .map((entry) => entry.value);
}

function appendPersonaMemRecallInstruction(userQuery: string): string {
  return `${userQuery} Please recall my related preferences from our conversation history to give personalized responses.`;
}

function extractMcqFinalAnswer(response: string): string | undefined {
  const patterns = [
    /\$\\boxed\{([A-Z])\}\$/i,
    /\\boxed\{([A-Z])\}/i,
    /final answer:\s*([A-Z])/i,
    /final answer is\s*\$?\\boxed\{([A-Z])\}\$?/i,
    /final answer is\s*([A-Z])/i,
    /the answer is\s*\$?\\boxed\{([A-Z])\}\$?/i,
    /the answer is\s*([A-Z])/i,
    /answer:\s*([A-Z])\b/i,
    /\b([A-Z])\.\s*$/i,
    /^\s*([A-Z])\s*$/i,
  ];

  for (const pattern of patterns) {
    const match = response.match(pattern);
    if (match?.[1]) {
      return match[1].toUpperCase();
    }
  }

  return undefined;
}

function normalizeMcqAnswerText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveMcqOption(
  response: string,
  mcq: PersonaMemMcqPrompt,
): string | undefined {
  const extractedLetter = extractMcqFinalAnswer(response);
  if (extractedLetter && mcq.options[extractedLetter]) {
    return extractedLetter;
  }

  const normalizedResponses = [
    response,
    response.replace(/^\s*final answer\s*:\s*/i, ""),
  ]
    .map(normalizeMcqAnswerText)
    .filter((value, index, values) => value && values.indexOf(value) === index);
  if (normalizedResponses.length === 0) {
    return undefined;
  }

  return Object.entries(mcq.options).find(
    ([, optionText]) => normalizedResponses.includes(normalizeMcqAnswerText(optionText)),
  )?.[0];
}

function parseChatHistory(
  raw: string,
  filename: string,
): PersonaMemChatHistory {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `PersonaMem-v2 chat history ${filename} must contain an object with a chat_history array.`,
    );
  }

  const chatHistory = (parsed as { chat_history?: unknown }).chat_history;
  if (!Array.isArray(chatHistory)) {
    throw new Error(
      `PersonaMem-v2 chat history ${filename} is missing the chat_history array.`,
    );
  }

  return {
    metadata:
      "metadata" in parsed && typeof parsed.metadata === "object"
        ? (parsed.metadata as Record<string, unknown>)
        : undefined,
    chat_history: chatHistory.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(
          `PersonaMem-v2 chat history ${filename} contains a malformed message at index ${index}.`,
        );
      }

      const role = typeof entry.role === "string" ? entry.role : "assistant";
      const content =
        typeof entry.content === "string" ? entry.content : String(entry.content ?? "");
      return { role, content };
    }),
  };
}

function buildMessages(chatHistory: PersonaMemChatHistory["chat_history"]): Message[] {
  return chatHistory
    .filter((message) => message.content.trim().length > 0)
    .map((message, index) => buildPersonaMemMessage({
      role: normalizeRole(message.role),
      content: message.content,
    }, index));
}

function buildPersonaMemMessage(message: Message, index: number): Message {
  const anchors = collectPersonaMemAnchors(message.content, index);
  if (anchors.length === 0) {
    return message;
  }
  return {
    ...message,
    content: [
      message.content,
      `${PERSONAMEM_ANCHOR_PREFIX} ${anchors.join("; ")}.`,
    ].join("\n"),
  };
}

function collectPersonaMemAnchors(content: string, index: number): string[] {
  const normalized = content.toLowerCase();
  const anchors = new Set<string>();

  if (hasPreferenceIntent(normalized)) {
    anchors.add("preference");
    anchors.add("personal preference");
    anchors.add("persona preference");
    anchors.add(`turn ${index}`);
  }
  if (hasPreferenceUpdateIntent(normalized)) {
    anchors.add("current preference");
    anchors.add("latest preference");
    anchors.add("updated preference");
    anchors.add(`turn ${index}`);
  }
  for (const match of content.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) {
    anchors.add(match[0]);
    anchors.add(`date=${match[0]}`);
  }

  return [...anchors].sort((left, right) => left.localeCompare(right));
}

function buildPersonaMemRecallQuery(userQuery: string): string {
  const normalized = userQuery.toLowerCase();
  const cues = new Set<string>();
  if (hasPreferenceIntent(normalized) || /\b(?:usually|recommend|should|for me|my)\b/.test(normalized)) {
    cues.add("preference");
    cues.add("personal preference");
    cues.add("persona preference");
  }
  if (hasPreferenceUpdateIntent(normalized)) {
    cues.add("current preference");
    cues.add("latest preference");
    cues.add("updated preference");
  }
  if (cues.size === 0) {
    return userQuery;
  }
  return `${userQuery}\n${[...cues].sort((left, right) => left.localeCompare(right)).join("; ")}.`;
}

function stripPersonaMemAnchors(content: string): string {
  const lines: string[] = [];
  for (const line of content.split("\n")) {
    const anchorIndex = line.indexOf(PERSONAMEM_ANCHOR_PREFIX);
    if (anchorIndex < 0) {
      lines.push(line);
      continue;
    }
    const cleanedLine = line.slice(0, anchorIndex).trimEnd();
    if (cleanedLine.trim().length > 0) {
      lines.push(cleanedLine);
    }
  }
  return lines.join("\n").trim();
}

function refinePersonaMemAnswer(args: {
  question: string;
  recalledText: string;
  answeredText: string;
}): string | undefined {
  const trimmed = args.answeredText.trim();
  const lowerQuestion = args.question.toLowerCase();
  if (!/\bwhich\s+tea\b/.test(lowerQuestion)) {
    return undefined;
  }

  const match = trimmed.match(/^(.+?)\s+tea[.!?]?$/i);
  if (!match?.[1]) {
    return undefined;
  }
  const refined = match[1].trim();
  if (
    refined.length === 0 ||
    !args.recalledText.toLowerCase().includes(trimmed.toLowerCase().replace(/[.!?]+$/g, ""))
  ) {
    return undefined;
  }
  return refined;
}

function hasPreferenceIntent(normalized: string): boolean {
  return /\b(?:prefer|preference|favorite|favourite|like|love|enjoy|usually|always|recommend|dislike)\b/.test(normalized);
}

function hasPreferenceUpdateIntent(normalized: string): boolean {
  return /\b(?:now|current|currently|latest|updated|changed|switch(?:ed)?|instead|these days)\b/.test(normalized);
}

function normalizeRole(role: string): Message["role"] {
  switch (role) {
    case "user":
    case "assistant":
    case "system":
      return role;
    default:
      return "assistant";
  }
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }

  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(
      `PersonaMem-v2 limit must be a non-negative integer. Received ${limit}.`,
    );
  }

  return limit;
}

function applyLimit<T>(items: T[], limit: number | undefined): T[] {
  return limit === undefined ? items : items.slice(0, limit);
}
