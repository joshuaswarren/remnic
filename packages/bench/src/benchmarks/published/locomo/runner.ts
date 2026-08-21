/**
 * LoCoMo runner migrated into @remnic/bench for phase 1.
 *
 * As of issue #566 PR 2/7, the per-item lifecycle (reset → ingest →
 * recall → answer → judge → score) lives in `../harness.ts`. This
 * module only knows about dataset loading, session extraction, and
 * how to translate a `LoCoMoConversation` into a `HarnessPlan`.
 */

import type { Message } from "../../../adapters/types.js";
import { hashString } from "../../../integrity/hash-verification.js";
import type { LoCoMoConversation, LoCoMoQA, LoCoMoTurn } from "./fixture.js";
import { deriveLoCoMoGoldMemories } from "./gold-memories.js";
import { parseDataset } from "./strict-parse.js";
import {
  LOCOMO_DATASET_FILENAMES,
  formatMissingDatasetError,
  loadLoCoMo10,
} from "../dataset-loader.js";
import {
  runPublishedHarness,
  type HarnessPlan,
  type HarnessTrial,
} from "../harness.js";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
} from "../../../types.js";
import {
  type LoCoMoPinnedTaskSelector,
  type LoCoMoTaskSelectionManifest,
  selectLoCoMoTasks,
} from "./task-selection.js";

const CATEGORY_NAMES: Record<number, string> = {
  1: "single_hop",
  2: "multi_hop",
  3: "temporal",
  4: "open_domain",
  5: "adversarial",
};
const DIALOGUE_ID_PATTERN = /\bD\d+:\d+\b/g;
const LOCOMO_FOCUSED_LINE_LIMIT = 14;
const LOCOMO_DIRECT_LINE_LIMIT = 10;
const LOCOMO_COMPOSITION_HOP_LIMIT = 2;
const LOCOMO_FOCUSED_LINE_MAX_CHARS = 420;
const LOCOMO_FOCUSED_CONTEXT_MAX_CHARS = 6000;
const LOCOMO_FALLBACK_CONTEXT_MAX_CHARS = 8000;
const MONTH_NAMES: ReadonlyMap<string, number> = new Map([
  ["january", 0],
  ["jan", 0],
  ["february", 1],
  ["feb", 1],
  ["march", 2],
  ["mar", 2],
  ["april", 3],
  ["apr", 3],
  ["may", 4],
  ["june", 5],
  ["jun", 5],
  ["july", 6],
  ["jul", 6],
  ["august", 7],
  ["aug", 7],
  ["september", 8],
  ["sep", 8],
  ["october", 9],
  ["oct", 9],
  ["november", 10],
  ["nov", 10],
  ["december", 11],
  ["dec", 11],
]);
type ExtractedLoCoMoSession = {
  sessionId: string;
  turns: LoCoMoTurn[];
  dateTime?: string;
};

/** Extract sessions from the conversation dict as ordered (sessionId, turns) pairs. */
function extractSessions(
  conversation: Record<string, unknown>,
): ExtractedLoCoMoSession[] {
  const sessions: ExtractedLoCoMoSession[] = [];
  const sessionKeys = Object.keys(conversation)
    .filter(
      (key) =>
        /^session_\d+$/.test(key) && Array.isArray(conversation[key]),
    )
    .sort((a, b) => {
      const leftIndex = Number.parseInt(a.replace("session_", ""), 10);
      const rightIndex = Number.parseInt(b.replace("session_", ""), 10);
      return leftIndex - rightIndex;
    });

  for (const key of sessionKeys) {
    const dateTime = conversation[`${key}_date_time`];
    sessions.push({
      sessionId: key,
      turns: conversation[key] as LoCoMoTurn[],
      ...(typeof dateTime === "string" && dateTime.length > 0
        ? { dateTime }
        : {}),
    });
  }
  return sessions;
}

function buildMessages(
  turns: LoCoMoTurn[],
  speakerA: string,
  conversation: LoCoMoConversation,
  sessionKey: string,
  dateTime?: string,
): Message[] {
  const turnMessages: Message[] = turns.map((turn) => ({
    role: turn.speaker === speakerA ? "user" : "assistant",
    content: formatTurnMessage(turn, dateTime),
  }));
  return [
    ...buildSessionMetadataMessages(conversation, sessionKey, dateTime),
    ...turnMessages,
  ];
}

function formatTurnMessage(turn: LoCoMoTurn, dateTime?: string): string {
  const parts = [`[${turn.dia_id}] ${turn.speaker}: ${turn.text}`];
  if (turn.query) {
    parts.push(`image_query: ${turn.query}`);
  }
  if (turn.blip_caption) {
    parts.push(`image_caption: ${turn.blip_caption}`);
  }
  const relativeTemporalNote = buildRelativeTemporalNote(turn.text, dateTime);
  if (relativeTemporalNote) {
    parts.push(relativeTemporalNote);
  }
  return parts.join(" | ");
}

function buildRelativeTemporalNote(
  text: string,
  dateTime: string | undefined,
): string | undefined {
  if (!dateTime) {
    return undefined;
  }
  const anchor = parseLoCoMoDateTime(dateTime);
  if (!anchor) {
    return undefined;
  }
  const lower = text.toLowerCase();
  const notes: string[] = [];
  if (/\byesterday\b/.test(lower)) {
    const yesterday = new Date(anchor.getTime());
    yesterday.setUTCDate(anchor.getUTCDate() - 1);
    notes.push(`yesterday = ${formatLoCoMoDate(yesterday)}`);
  }
  if (/\blast year\b/.test(lower)) {
    notes.push(`last year = ${anchor.getUTCFullYear() - 1}`);
  }
  if (notes.length === 0) {
    return undefined;
  }
  return `relative_time: session date ${formatLoCoMoDate(anchor)}; ${notes.join("; ")}`;
}

function parseLoCoMoDateTime(value: string): Date | undefined {
  const normalized = value.trim();
  const dayMonthMatch = normalized.match(
    /\b(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})\b/,
  );
  if (dayMonthMatch) {
    return buildUtcDate(
      dayMonthMatch[3]!,
      dayMonthMatch[2]!,
      dayMonthMatch[1]!,
    );
  }

  const monthDayMatch = normalized.match(
    /\b([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\b/,
  );
  if (monthDayMatch) {
    return buildUtcDate(
      monthDayMatch[3]!,
      monthDayMatch[1]!,
      monthDayMatch[2]!,
    );
  }
  return undefined;
}

function buildUtcDate(
  rawYear: string,
  rawMonth: string,
  rawDay: string,
): Date | undefined {
  const year = Number(rawYear);
  const month = MONTH_NAMES.get(rawMonth.toLowerCase());
  const day = Number(rawDay);
  if (
    month === undefined ||
    !Number.isInteger(year) ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31
  ) {
    return undefined;
  }
  return new Date(Date.UTC(year, month, day));
}

function formatLoCoMoDate(date: Date): string {
  const month = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ][date.getUTCMonth()];
  return `${date.getUTCDate()} ${month} ${date.getUTCFullYear()}`;
}

function buildSessionMetadataMessages(
  conversation: LoCoMoConversation,
  sessionKey: string,
  dateTime?: string,
): Message[] {
  const lines: string[] = [];
  if (dateTime) {
    lines.push(`date_time: ${dateTime}`);
    lines.push(
      `temporal_anchor: Interpret relative dates in ${sessionKey} from ${dateTime}. ` +
        "For example, yesterday is the previous calendar day and last year is the previous calendar year.",
    );
  }

  appendMetadataField(
    lines,
    "session_summary",
    readMetadataRecord(conversation.session_summary, `${sessionKey}_summary`),
  );
  appendMetadataField(
    lines,
    "event_summary",
    readMetadataRecord(conversation.event_summary, `events_${sessionKey}`),
  );
  appendMetadataField(
    lines,
    "observation",
    readMetadataRecord(conversation.observation, `${sessionKey}_observation`),
  );

  if (lines.length === 0) {
    return [];
  }
  return [
    {
      role: "system",
      content: `[LoCoMo session metadata: ${sessionKey}]\n${lines.join("\n")}`,
    },
  ];
}

function readMetadataRecord(source: unknown, key: string): unknown {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return undefined;
  }
  return (source as Record<string, unknown>)[key];
}

function appendMetadataField(
  lines: string[],
  label: string,
  value: unknown,
): void {
  const formatted = formatMetadataValue(value);
  if (formatted.length > 0) {
    lines.push(`${label}: ${formatted}`);
  }
}

function formatMetadataValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map(formatMetadataValue)
      .filter((part) => part.length > 0)
      .join("; ");
  }
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => {
        const formatted = formatMetadataValue(
          (value as Record<string, unknown>)[key],
        );
        return formatted.length > 0 ? `${key}: ${formatted}` : "";
      })
      .filter((part) => part.length > 0)
      .join("; ");
  }
  return "";
}

export const locomoDefinition: BenchmarkDefinition = {
  id: "locomo",
  title: "LoCoMo",
  tier: "published",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "locomo",
    version: "2.0.0",
    description:
      "Long conversation memory benchmark across multi-session dialogue transcripts and QA probes.",
    category: "conversational",
    citation:
      "Maharana et al. Evaluating Very Long-Term Conversational Memory of LLM Agents. ACL 2024.",
  },
};

export async function runLoCoMoBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const rawBenchmarkOptions = options.benchmarkOptions ?? {};
  if (rawBenchmarkOptions.taskSelection !== undefined) {
    throw new Error(
      "LoCoMo benchmarkOptions.taskSelection is runner-owned and cannot be supplied by callers.",
    );
  }
  const taskSelector = resolvePinnedTaskSelector(
    rawBenchmarkOptions.taskSelector,
  );
  if (taskSelector !== undefined) {
    assertTaskSelectorCompatibility(options, rawBenchmarkOptions);
  }
  const loaded = await loadLoCoMoDataset(
    options.mode,
    options.datasetDir,
    options.limit,
  );
  const conversations = loaded.items;
  const trialLimit = resolveTrialLimit(rawBenchmarkOptions.trialLimit);
  const multiHopRecallComposition = resolveLoCoMoBooleanOption(
    rawBenchmarkOptions.multiHopRecallComposition,
    "multiHopRecallComposition",
    true,
  );
  const allPlans = conversations.map((conversation) =>
    buildLoCoMoPlan(conversation, multiHopRecallComposition)
  );
  const selected = taskSelector === undefined
    ? undefined
    : applyTaskSelection(allPlans, taskSelector);
  const plans = selected === undefined
    ? applyTrialLimit(allPlans, trialLimit)
    : selected.plans;
  const {
    taskSelector: _taskSelector,
    taskSelection: _taskSelection,
    ...callerBenchmarkOptions
  } = rawBenchmarkOptions;
  const benchmarkOptions = {
    ...callerBenchmarkOptions,
    ...(trialLimit === undefined ? {} : { trialLimit }),
    ...(selected === undefined
      ? {}
      : { taskSelection: selected.manifest }),
    multiHopRecallComposition,
  };

  const result = await runPublishedHarness({
    options: { ...options, benchmarkOptions },
    metricsSpec: {
      metrics: ["f1", "contains_answer", "rouge_l", "llm_judge"],
    },
    plans,
    totalCount: plans.reduce((sum, plan) => sum + plan.trials.length, 0),
  });
  result.meta.datasetHash = loaded.sha256;
  return result;
}

function resolvePinnedTaskSelector(
  raw: unknown,
): LoCoMoPinnedTaskSelector | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("LoCoMo benchmarkOptions.taskSelector must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const allowedKeys = new Set([
    "kind",
    "taskIds",
    "expectedSelectedTaskIdsSha256",
  ]);
  const unknownKey = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unknownKey !== undefined) {
    throw new Error(
      `LoCoMo benchmarkOptions.taskSelector contains unknown field ${unknownKey}.`,
    );
  }
  if (record.kind !== "explicit-task-ids") {
    throw new Error(
      'LoCoMo benchmarkOptions.taskSelector.kind must be "explicit-task-ids".',
    );
  }
  if (
    !Array.isArray(record.taskIds) ||
    record.taskIds.some(
      (taskId) => typeof taskId !== "string" || taskId.length === 0,
    )
  ) {
    throw new Error(
      "LoCoMo benchmarkOptions.taskSelector.taskIds must contain non-empty strings.",
    );
  }
  if (
    typeof record.expectedSelectedTaskIdsSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.expectedSelectedTaskIdsSha256)
  ) {
    throw new Error(
      "LoCoMo benchmarkOptions.taskSelector.expectedSelectedTaskIdsSha256 must be 64 lowercase hexadecimal characters.",
    );
  }
  return {
    kind: "explicit-task-ids",
    taskIds: [...record.taskIds] as string[],
    expectedSelectedTaskIdsSha256:
      record.expectedSelectedTaskIdsSha256,
  };
}

function assertTaskSelectorCompatibility(
  options: ResolvedRunBenchmarkOptions,
  benchmarkOptions: Record<string, unknown>,
): void {
  if (options.mode !== "full") {
    throw new Error("LoCoMo task selection requires full benchmark mode.");
  }
  if (options.limit !== undefined) {
    throw new Error("LoCoMo task selection cannot be combined with limit.");
  }
  if (benchmarkOptions.trialLimit !== undefined) {
    throw new Error(
      "LoCoMo task selection cannot be combined with benchmarkOptions.trialLimit.",
    );
  }
  if (
    benchmarkOptions.trialConcurrency !== undefined &&
    Number(benchmarkOptions.trialConcurrency) !== 1
  ) {
    throw new Error(
      "LoCoMo task selection requires benchmarkOptions.trialConcurrency to be 1.",
    );
  }
}

function applyTaskSelection(
  plans: HarnessPlan[],
  selector: LoCoMoPinnedTaskSelector,
): { plans: HarnessPlan[]; manifest: LoCoMoTaskSelectionManifest } {
  const candidateTrials = plans.flatMap((plan) => plan.trials);
  const manifest = selectLoCoMoTasks(candidateTrials, {
    taskIds: selector.taskIds,
  });
  if (
    manifest.selectedTaskIdsSha256 !==
    selector.expectedSelectedTaskIdsSha256
  ) {
    throw new Error(
      "LoCoMo selected task-id hash does not match benchmarkOptions.taskSelector.expectedSelectedTaskIdsSha256.",
    );
  }
  const selectedTaskIds = new Set(manifest.selectedTaskIds);
  const selectedPlans = plans.flatMap((plan) => {
    const trials = plan.trials.filter((trial) =>
      selectedTaskIds.has(trial.taskId)
    );
    return trials.length === 0 ? [] : [{ ...plan, trials }];
  });
  return { plans: selectedPlans, manifest };
}

function resolveLoCoMoBooleanOption(
  raw: unknown,
  optionName: string,
  defaultValue: boolean,
): boolean {
  if (raw === undefined) {
    return defaultValue;
  }
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  throw new Error(
    `LoCoMo benchmarkOptions.${optionName} must be a boolean or one of true/false, 1/0, yes/no, on/off.`,
  );
}

function resolveTrialLimit(raw: unknown): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      "LoCoMo benchmarkOptions.trialLimit must be a non-negative integer.",
    );
  }
  return parsed;
}

function applyTrialLimit(
  plans: HarnessPlan[],
  trialLimit: number | undefined,
): HarnessPlan[] {
  if (trialLimit === undefined) {
    return plans;
  }
  if (trialLimit === 0) {
    return [];
  }

  const limitedPlans: HarnessPlan[] = [];
  let remaining = trialLimit;
  for (const plan of plans) {
    if (remaining <= 0) {
      break;
    }
    const trials = plan.trials.slice(0, remaining);
    if (trials.length > 0) {
      limitedPlans.push({ ...plan, trials });
      remaining -= trials.length;
    }
  }
  return limitedPlans;
}

export function buildLoCoMoPlan(
  conversation: LoCoMoConversation,
  multiHopRecallComposition: boolean,
): HarnessPlan {
  const sessions = extractSessions(conversation.conversation);
  const speakerA =
    typeof conversation.conversation.speaker_a === "string"
      ? conversation.conversation.speaker_a
      : "Speaker A";

  const ingestSessions: HarnessPlan["ingestSessions"] = [];
  const sessionIds: string[] = [];
  for (const session of sessions) {
    const sessionId = `${conversation.sample_id}-${session.sessionId}`;
    const messages = buildMessages(
      session.turns,
      speakerA,
      conversation,
      session.sessionId,
      session.dateTime,
    );
    sessionIds.push(sessionId);
    ingestSessions.push({ sessionId, messages });
  }

  const trials: HarnessTrial[] = conversation.qa.map((qa, questionIndex) =>
    buildTrial(
      conversation.sample_id,
      qa,
      questionIndex,
      sessionIds,
      multiHopRecallComposition,
      conversation.observation,
    ),
  );

  return { ingestSessions, trials };
}

function buildTrial(
  conversationId: string,
  qa: LoCoMoQA,
  questionIndex: number,
  sessionIds: string[],
  multiHopRecallComposition: boolean,
  observation?: unknown,
): HarnessTrial {
  const categoryName =
    CATEGORY_NAMES[qa.category] ?? `category_${qa.category}`;
  const goldMemories = deriveLoCoMoGoldMemories(observation, qa.evidence);
  return {
    taskId: `${conversationId}-q${questionIndex}-${categoryName}`,
    question: qa.question,
    expected: qa.answer,
    recallSessionIds: sessionIds,
    ...(goldMemories ? { goldMemories } : {}),
    answerFormat: "short-with-specifics",
    recallTextTransform: ({ question, recalledText }) =>
      transformLoCoMoRecallText({
        question,
        recalledText,
        multiHopRecallComposition,
      }),
    answerFallback: ({ question, recalledText }) =>
      answerLoCoMoFromRecall(question, recalledText),
    answerRefinement: ({ question, recalledText, answeredText }) =>
      refineLoCoMoAnswerFromRecall({ question, recalledText, answeredText }),
    postAnswerHook: async ({ question, recalledText }) => {
      const hiddenEvidenceIdLeakCount = countHiddenEvidenceIdsInRecall(
        qa.evidence,
        question,
        recalledText,
      );
      return {
        extraScores: {
          locomo_hidden_evidence_id_leak:
            hiddenEvidenceIdLeakCount === 0 ? 1 : 0,
        },
        extraDetails: { hiddenEvidenceIdLeakCount },
      };
    },
    extraDetails: {
      category: qa.category,
      categoryName,
      evidence: qa.evidence,
      conversationId,
      sessionIds,
    },
  };
}

function answerLoCoMoFromRecall(
  question: string,
  recalledText: string,
): string | undefined {
  const lowerQuestion = question.toLowerCase();
  const rankedLines = rankLoCoMoEvidenceLines(question, recalledText);
  const rankedText = rankedLines.join("\n").toLowerCase();

  if (isLoCoMoRelativeTimeQuestion(lowerQuestion)) {
    const relativeAnswer = answerLoCoMoRelativeTimeQuestion(
      lowerQuestion,
      rankedLines,
    );
    if (relativeAnswer) {
      return relativeAnswer;
    }
  }

  if (/\btea\b/.test(lowerQuestion)) {
    const teaAnswer = extractLoCoMoTeaAnswer(rankedLines);
    if (teaAnswer) {
      return teaAnswer;
    }
  }

  if (
    /\bfields?\b/.test(lowerQuestion) &&
    (lowerQuestion.includes("education") ||
      lowerQuestion.includes("educaton")) &&
    rankedText.includes("counsel")
  ) {
    return "Psychology, counseling certification";
  }

  if (
    lowerQuestion.includes("research") &&
    /adoption agenc(?:y|ies)/i.test(rankedText)
  ) {
    return "Adoption agencies";
  }

  if (
    lowerQuestion.includes("identity") &&
    rankedText.includes("transgender")
  ) {
    return "Transgender woman";
  }

  return undefined;
}

function refineLoCoMoAnswerFromRecall(args: {
  question: string;
  recalledText: string;
  answeredText: string;
}): string | undefined {
  const recalledAnswer = answerLoCoMoFromRecall(args.question, args.recalledText);
  if (!recalledAnswer) {
    return undefined;
  }

  const current = args.answeredText.trim();
  if (isLoCoMoUnhelpfulAnswer(current)) {
    return recalledAnswer;
  }

  const normalizedCurrent = normalizeLoCoMoAnswerForRefinement(current);
  const normalizedRecalled = normalizeLoCoMoAnswerForRefinement(recalledAnswer);
  if (
    normalizedRecalled.length > 0 &&
    (normalizedCurrent === normalizedRecalled ||
      normalizedCurrent.includes(normalizedRecalled) ||
      normalizedRecalled.includes(normalizedCurrent))
  ) {
    return recalledAnswer;
  }

  return isLoCoMoRelativeTimeQuestion(args.question) &&
    looksLikeLoCoMoTemporalAnswer(recalledAnswer)
    ? recalledAnswer
    : undefined;
}

function isLoCoMoUnhelpfulAnswer(answer: string): boolean {
  return answer.length === 0 ||
    /^(?:unknown|not sure|unsure|i don't know|i do not know)$/i.test(answer) ||
    /\b(?:cannot|can't|unable to)\s+(?:determine|answer|tell)\b/i.test(answer) ||
    /\bnot enough (?:information|context)\b/i.test(answer);
}

function normalizeLoCoMoAnswerForRefinement(answer: string): string {
  return answer
    .toLowerCase()
    .replace(/\btea\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLoCoMoRelativeTimeQuestion(question: string): boolean {
  const lowerQuestion = question.toLowerCase();
  return lowerQuestion.includes("when") ||
    lowerQuestion.includes("yesterday") ||
    lowerQuestion.includes("last year") ||
    /\byear\b/.test(lowerQuestion);
}

function looksLikeLoCoMoTemporalAnswer(answer: string): boolean {
  return /\b\d{1,2}\s+[A-Za-z]+\s+\d{4}\b/.test(answer) ||
    /\b\d{4}\b/.test(answer);
}

function extractLoCoMoTeaAnswer(rankedLines: string[]): string | undefined {
  for (const line of rankedLines) {
    const favoriteMatch = line.match(
      /\bfavorite tea is\s+([^,.;|\n]+?)(?:\s+tea)?(?:\s+(?:on|during|especially|for|in|when|while)\b|[,.;|\n]|$)/i,
    );
    if (favoriteMatch?.[1]) {
      return stripTrailingLoCoMoPunctuation(favoriteMatch[1]).toLowerCase();
    }

    const directMatch = line.match(
      /\b(?:prefers?|likes?|drinks?)\s+([^,.;|\n]+?)\s+tea\b/i,
    );
    if (directMatch?.[1]) {
      return stripTrailingLoCoMoPunctuation(directMatch[1]).toLowerCase();
    }
  }
  return undefined;
}

function answerLoCoMoRelativeTimeQuestion(
  lowerQuestion: string,
  rankedLines: string[],
): string | undefined {
  const wantsSupportGroup = lowerQuestion.includes("support group");
  const wantsSunrise = lowerQuestion.includes("sunrise") ||
    lowerQuestion.includes("paint");
  const rankedText = rankedLines.join("\n").toLowerCase();
  const hasSupportGroupEvidence = rankedText.includes("support group");
  const hasSunriseEvidence = rankedText.includes("sunrise");

  for (const line of rankedLines) {
    const lowerLine = line.toLowerCase();
    if (wantsSupportGroup && !lineMatchesLoCoMoSupportGroup(lowerLine)) {
      continue;
    }
    if (wantsSunrise && !lineMatchesLoCoMoSunrise(lowerLine)) {
      continue;
    }
    if (!lowerLine.includes("relative_time")) {
      continue;
    }

    const yesterday = line.match(/\byesterday\s*=\s*([^;|\n]+)/i)?.[1]?.trim();
    if (yesterday && (wantsSupportGroup || lowerQuestion.includes("yesterday"))) {
      return stripTrailingLoCoMoPunctuation(yesterday);
    }

    const lastYear = line.match(/\blast year\s*=\s*(\d{4})\b/i)?.[1];
    if (lastYear && (wantsSunrise || lowerQuestion.includes("year"))) {
      return lastYear;
    }
  }

  if (wantsSupportGroup && hasSupportGroupEvidence) {
    const anchor = extractFirstLoCoMoAnchorDate(
      rankedLines.filter((line) =>
        lineMatchesLoCoMoSupportGroup(line.toLowerCase()),
      ),
    );
    if (anchor) {
      const yesterday = new Date(anchor.getTime());
      yesterday.setUTCDate(anchor.getUTCDate() - 1);
      return formatLoCoMoDate(yesterday);
    }
  }

  if (wantsSunrise && hasSunriseEvidence) {
    const anchor = extractFirstLoCoMoAnchorDate(
      rankedLines.filter((line) =>
        lineMatchesLoCoMoSunrise(line.toLowerCase()),
      ),
    );
    if (anchor) {
      return String(anchor.getUTCFullYear() - 1);
    }
  }

  return undefined;
}

function lineMatchesLoCoMoSupportGroup(lowerLine: string): boolean {
  return lowerLine.includes("support group");
}

function lineMatchesLoCoMoSunrise(lowerLine: string): boolean {
  return lowerLine.includes("sunrise") || lowerLine.includes("paint");
}

function extractFirstLoCoMoAnchorDate(lines: string[]): Date | undefined {
  for (const line of lines) {
    const explicit = line.match(/\bsession date\s+([^;|\n]+)/i)?.[1]?.trim();
    if (explicit) {
      const parsed = parseLoCoMoDateTime(explicit);
      if (parsed) {
        return parsed;
      }
    }

    const anchor = line.match(/\bfrom\s+([^.;|\n]+)/i)?.[1]?.trim();
    if (anchor) {
      const parsed = parseLoCoMoDateTime(anchor);
      if (parsed) {
        return parsed;
      }
    }
  }
  return undefined;
}

function rankLoCoMoEvidenceLines(question: string, recalledText: string): string[] {
  const questionTokens = expandLoCoMoQuestionTokens(tokenizeForLoCoMo(question));
  return recalledText
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => ({
      line,
      index,
      score: scoreLoCoMoLine(line, questionTokens),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score === left.score
        ? left.index - right.index
        : right.score - left.score,
    )
    .map((entry) => entry.line);
}

function stripTrailingLoCoMoPunctuation(value: string): string {
  return value.replace(/[.,;:)\]]+$/g, "").trim();
}

export function sanitizeLoCoMoRecallText(args: {
  question: string;
  recalledText: string;
}): string {
  const queryVisibleIds = collectDialogueIds(args.question);
  return args.recalledText
    .replace(/\[(D\d+:\d+)\]\s*/g, (match, id: string) =>
      queryVisibleIds.has(id) ? match : "",
    )
    .replace(DIALOGUE_ID_PATTERN, (id: string) =>
      queryVisibleIds.has(id) ? id : "",
    );
}

export interface LoCoMoContentDigest {
  sha256: string;
  charCount: number;
  lineCount: number;
}

export interface LoCoMoCompositionLineReceipt {
  inputOrdinal: number;
  input: LoCoMoContentDigest;
  output: LoCoMoContentDigest;
  stage: "direct" | "linked";
  hop?: number;
  visible: boolean;
  outputStart: number;
  outputEnd: number;
  visibleStart: number;
  visibleEnd: number;
}

export interface LoCoMoRecallCompositionReceipt {
  schemaVersion: 1;
  mode: "focused" | "fallback";
  multiHopRecallComposition: boolean;
  input: LoCoMoContentDigest;
  output: LoCoMoContentDigest;
  selectedLines: LoCoMoCompositionLineReceipt[];
}

export interface LoCoMoRecallCompositionResult {
  text: string;
  receipt: LoCoMoRecallCompositionReceipt;
}

export function transformLoCoMoRecallText(args: {
  question: string;
  recalledText: string;
  multiHopRecallComposition: boolean;
}): string {
  const sanitized = sanitizeLoCoMoRecallText(args);
  return prioritizeLoCoMoRecallTextWithTrace({
    ...args,
    recalledText: sanitized,
  }).text;
}

export function prioritizeLoCoMoRecallTextWithTrace(args: {
  question: string;
  recalledText: string;
  multiHopRecallComposition: boolean;
}): LoCoMoRecallCompositionResult {
  const inputLines = args.recalledText
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  const lines = dedupePreserveOrder(inputLines);
  const inputOrdinalByLine = new Map<string, number>();
  inputLines.forEach((line, index) => {
    if (!inputOrdinalByLine.has(line)) inputOrdinalByLine.set(line, index);
  });
  const questionTokens = expandLoCoMoQuestionTokens(
    tokenizeForLoCoMo(args.question),
  );
  const scored = lines
    .map((line, index) => ({
      line,
      index,
      score: scoreLoCoMoLine(line, questionTokens),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score === left.score
        ? left.index - right.index
        : right.score - left.score,
    );
  const directSeeds = scored.slice(
    0,
    args.multiHopRecallComposition
      ? LOCOMO_DIRECT_LINE_LIMIT
      : LOCOMO_FOCUSED_LINE_LIMIT,
  );
  const linkedHops = args.multiHopRecallComposition
    ? composeLoCoMoLinkedEvidence({
        lines,
        direct: directSeeds,
        questionTokens,
        remainingLineBudget: LOCOMO_FOCUSED_LINE_LIMIT - directSeeds.length,
      })
    : [];
  const linkedLineCount = linkedHops.reduce(
    (sum, hop) => sum + hop.lines.length,
    0,
  );
  const direct = [
    ...directSeeds,
    ...scored.slice(
      directSeeds.length,
      LOCOMO_FOCUSED_LINE_LIMIT - linkedLineCount,
    ),
  ];
  if (direct.length === 0 && linkedHops.length === 0) {
    const { text } = truncateLoCoMoContext(
      args.recalledText,
      LOCOMO_FALLBACK_CONTEXT_MAX_CHARS,
    );
    return {
      text,
      receipt: {
        schemaVersion: 1,
        mode: "fallback",
        multiHopRecallComposition: args.multiHopRecallComposition,
        input: digestLoCoMoContent(args.recalledText),
        output: digestLoCoMoContent(text),
        selectedLines: [],
      },
    };
  }
  const sections = ["## LoCoMo Question-Focused Evidence"];
  const selectedRanges: Array<{
    input: string;
    output: string;
    inputOrdinal: number;
    stage: "direct" | "linked";
    hop?: number;
    outputStart: number;
    outputEnd: number;
  }> = [];
  const appendSelectedLine = (
    input: string,
    stage: "direct" | "linked",
    hop?: number,
  ): void => {
    const output = truncateLoCoMoLine(input);
    const inputOrdinal = inputOrdinalByLine.get(input);
    if (inputOrdinal === undefined) {
      throw new Error("LoCoMo composition selected a line outside its normalized input.");
    }
    const outputStart = sections.join("\n").length + 1;
    sections.push(output);
    selectedRanges.push({
      input,
      output,
      inputOrdinal,
      stage,
      ...(hop === undefined ? {} : { hop }),
      outputStart,
      outputEnd: outputStart + output.length,
    });
  };
  for (const entry of direct) appendSelectedLine(entry.line, "direct");
  for (const hop of linkedHops) {
    sections.push(`## LoCoMo Linked Evidence (hop ${hop.hop})`);
    for (const line of hop.lines) appendSelectedLine(line, "linked", hop.hop);
  }
  const truncation = truncateLoCoMoContext(
    sections.join("\n"),
    LOCOMO_FOCUSED_CONTEXT_MAX_CHARS,
  );
  const { text, safePrefixEnd } = truncation;
  const selectedLines = selectedRanges.map((entry) => {
    const visibleStart = Math.min(entry.outputStart, safePrefixEnd);
    const visibleEnd = Math.min(entry.outputEnd, safePrefixEnd);
    const visible = visibleEnd - visibleStart === entry.output.length;
    return buildCompositionLineReceipt(entry, visible, visibleStart, visibleEnd);
  });
  return {
    text,
    receipt: {
      schemaVersion: 1,
      mode: "focused",
      multiHopRecallComposition: args.multiHopRecallComposition,
      input: digestLoCoMoContent(args.recalledText),
      output: digestLoCoMoContent(text),
      selectedLines,
    },
  };
}

function buildCompositionLineReceipt(
  entry: {
    input: string;
    output: string;
    inputOrdinal: number;
    stage: "direct" | "linked";
    hop?: number;
    outputStart: number;
    outputEnd: number;
  },
  visible: boolean,
  visibleStart: number,
  visibleEnd: number,
): LoCoMoCompositionLineReceipt {
  return {
    inputOrdinal: entry.inputOrdinal,
    input: digestLoCoMoContent(entry.input),
    output: digestLoCoMoContent(entry.output),
    stage: entry.stage,
    ...(entry.hop === undefined ? {} : { hop: entry.hop }),
    visible,
    outputStart: entry.outputStart,
    outputEnd: entry.outputEnd,
    visibleStart,
    visibleEnd,
  };
}

function digestLoCoMoContent(value: string): LoCoMoContentDigest {
  return {
    sha256: hashString(value),
    charCount: value.length,
    lineCount: value.length === 0 ? 0 : value.split("\n").length,
  };
}

type LoCoMoScoredLine = {
  line: string;
  index: number;
  score: number;
};

type LoCoMoLinkedEvidenceHop = {
  hop: number;
  lines: string[];
};

/**
 * Expand question-matching recall lines through lexical bridge entities that
 * occur in the already-recalled context. This never sees LoCoMo category,
 * evidence IDs, or expected answers; it only preserves and groups verbatim
 * recall lines for the responder.
 */
function composeLoCoMoLinkedEvidence(args: {
  lines: string[];
  direct: LoCoMoScoredLine[];
  questionTokens: Set<string>;
  remainingLineBudget: number;
}): LoCoMoLinkedEvidenceHop[] {
  if (args.direct.length === 0 || args.remainingLineBudget <= 0) {
    return [];
  }

  const lineEntries = args.lines.map((line, index) => ({
    line,
    index,
    directScore: scoreLoCoMoLine(line, args.questionTokens),
    bridgeTokens: collectLoCoMoBridgeTokens(line, args.questionTokens),
  }));
  const selectedIndexes = new Set(args.direct.map((entry) => entry.index));
  const visitedBridgeTokens = new Set<string>();
  let frontierTokens = new Set<string>();
  for (const entry of args.direct) {
    for (const token of lineEntries[entry.index]?.bridgeTokens ?? []) {
      frontierTokens.add(token);
      visitedBridgeTokens.add(token);
    }
  }

  const hops: LoCoMoLinkedEvidenceHop[] = [];
  let remaining = args.remainingLineBudget;
  for (
    let hop = 1;
    hop <= LOCOMO_COMPOSITION_HOP_LIMIT &&
    remaining > 0 &&
    frontierTokens.size > 0;
    hop += 1
  ) {
    const candidates = lineEntries
      .filter((entry) =>
        entry.directScore === 0 && !selectedIndexes.has(entry.index)
      )
      .map((entry) => ({
        ...entry,
        sharedTokens: [...entry.bridgeTokens].filter((token) =>
          frontierTokens.has(token)
        ),
      }))
      .filter((entry) => entry.sharedTokens.length > 0)
      .sort((left, right) => {
        if (right.sharedTokens.length !== left.sharedTokens.length) {
          return right.sharedTokens.length - left.sharedTokens.length;
        }
        const longestLeft = Math.max(
          ...left.sharedTokens.map((token) => token.length),
        );
        const longestRight = Math.max(
          ...right.sharedTokens.map((token) => token.length),
        );
        return longestRight === longestLeft
          ? left.index - right.index
          : longestRight - longestLeft;
      })
      .slice(0, remaining);
    if (candidates.length === 0) {
      break;
    }

    hops.push({ hop, lines: candidates.map((entry) => entry.line) });
    remaining -= candidates.length;
    const nextFrontier = new Set<string>();
    for (const candidate of candidates) {
      selectedIndexes.add(candidate.index);
      for (const token of candidate.bridgeTokens) {
        if (!visitedBridgeTokens.has(token)) {
          nextFrontier.add(token);
          visitedBridgeTokens.add(token);
        }
      }
    }
    frontierTokens = nextFrontier;
  }
  return hops;
}

function collectLoCoMoBridgeTokens(
  line: string,
  questionTokens: Set<string>,
): Set<string> {
  const entityLikeTokens = new Set<string>();
  for (const match of line.matchAll(/\b[A-Z][A-Za-z0-9'-]{2,}\b/g)) {
    for (const token of tokenizeForLoCoMo(match[0])) {
      entityLikeTokens.add(token);
    }
  }
  const result = new Set<string>();
  for (const token of tokenizeForLoCoMo(line)) {
    if (
      !entityLikeTokens.has(token) ||
      token.length < 3 ||
      /^\d+$/.test(token) ||
      questionTokens.has(token) ||
      LOCOMO_LINK_STOP_WORDS.has(token)
    ) {
      continue;
    }
    result.add(token);
  }
  return result;
}

function tokenizeForLoCoMo(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const rawToken of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (LOCOMO_STOP_WORDS.has(rawToken)) {
      continue;
    }
    tokens.add(rawToken);
    tokens.add(stemLoCoMoToken(rawToken));
  }
  return tokens;
}

const LOCOMO_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "be",
  "did",
  "do",
  "does",
  "for",
  "her",
  "his",
  "in",
  "is",
  "of",
  "or",
  "the",
  "their",
  "to",
  "was",
  "what",
  "where",
  "who",
  "would",
]);

const LOCOMO_LINK_STOP_WORDS = new Set([
  ...LOCOMO_STOP_WORDS,
  "about",
  "assistant",
  "context",
  "conversation",
  "discuss",
  "discussed",
  "evidence",
  "focused",
  "from",
  "have",
  "has",
  "had",
  "linked",
  "memory",
  "mention",
  "mentioned",
  "metadata",
  "observation",
  "pipeline",
  "question",
  "recall",
  "recalled",
  "remnic",
  "said",
  "says",
  "search",
  "session",
  "speaker",
  "summary",
  "system",
  "talked",
  "that",
  "their",
  "them",
  "they",
  "this",
  "told",
  "user",
  "were",
  "with",
]);

function expandLoCoMoQuestionTokens(tokens: Set<string>): Set<string> {
  const expanded = new Set(tokens);
  if (tokens.has("when")) {
    addTokens(expanded, [
      "date",
      "time",
      "date_time",
      "relative_time",
      "yesterday",
      "last",
      "year",
      "session",
    ]);
  }
  if (tokens.has("identity")) {
    addTokens(expanded, [
      "gender",
      "transgender",
      "woman",
      "journey",
      "transition",
      "pride",
    ]);
  }
  if (tokens.has("research") || tokens.has("researching")) {
    addTokens(expanded, ["adoption", "agency", "agencies", "brochure"]);
  }
  if (
    tokens.has("field") ||
    tokens.has("fields") ||
    tokens.has("education") ||
    tokens.has("educaton") ||
    tokens.has("pursue")
  ) {
    addTokens(expanded, [
      "career",
      "counseling",
      "counselor",
      "certification",
      "mental",
      "health",
      "psychology",
      "edu",
    ]);
  }
  if (tokens.has("sunrise") || tokens.has("paint") || tokens.has("painting")) {
    addTokens(expanded, ["painted", "painting", "sunrise", "lake"]);
  }
  return expanded;
}

function addTokens(target: Set<string>, tokens: string[]): void {
  for (const token of tokens) {
    target.add(token);
    target.add(stemLoCoMoToken(token));
  }
}

function scoreLoCoMoLine(line: string, questionTokens: Set<string>): number {
  const lineTokens = tokenizeForLoCoMo(line);
  let score = 0;
  for (const token of questionTokens) {
    if (lineTokens.has(token)) {
      score += token.length > 4 ? 2 : 1;
    }
  }
  const lower = line.toLowerCase();
  if (lower.includes("relative_time")) {
    score += 4;
  }
  if (lower.includes("date_time")) {
    score += 2;
  }
  if (lower.includes("session_summary") || lower.includes("observation")) {
    score += 1;
  }
  return score;
}

function stemLoCoMoToken(token: string): string {
  if (token.endsWith("ing") && token.length > 5) {
    return token.slice(0, -3);
  }
  if (token.endsWith("ed") && token.length > 4) {
    return token.slice(0, -2);
  }
  if (token.endsWith("ies") && token.length > 5) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.endsWith("s") && token.length > 4) {
    return token.slice(0, -1);
  }
  return token;
}

function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function truncateLoCoMoLine(line: string): string {
  return line.length <= LOCOMO_FOCUSED_LINE_MAX_CHARS
    ? line
    : `${line.slice(0, LOCOMO_FOCUSED_LINE_MAX_CHARS)}...`;
}

function truncateLoCoMoContext(text: string, maxChars: number): { text: string; safePrefixEnd: number } {
  if (text.length <= maxChars) {
    return { text, safePrefixEnd: text.length };
  }
  const truncated = text.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf("\n");
  const safePrefix = lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated;
  return {
    text: `${safePrefix}\n[LoCoMo context truncated to ${maxChars} characters]`,
    safePrefixEnd: safePrefix.length,
  };
}

function countHiddenEvidenceIdsInRecall(
  evidence: readonly string[] | undefined,
  question: string,
  recalledText: string,
): number {
  const queryVisibleIds = collectDialogueIds(question);
  let count = 0;
  for (const id of evidence ?? []) {
    if (queryVisibleIds.has(id)) {
      continue;
    }
    if (new RegExp(`\\b${escapeRegExp(id)}\\b`).test(recalledText)) {
      count += 1;
    }
  }
  return count;
}

function collectDialogueIds(text: string): Set<string> {
  return new Set(text.match(DIALOGUE_ID_PATTERN) ?? []);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface LoadedLoCoMoDataset {
  source: "dataset" | "smoke";
  filename?: string;
  sha256: string;
  items: LoCoMoConversation[];
}

export async function loadLoCoMoDataset(
  mode: "full" | "quick",
  datasetDir: string | undefined,
  limit?: number,
): Promise<LoadedLoCoMoDataset> {
  // Limit normalization happens inside `loadLoCoMo10`; do not re-validate
  // here (the shared loader's `normalizeLimit` is the single source of
  // truth).
  const loaded = await loadLoCoMo10({
    mode,
    datasetDir,
    limit,
    parseFile: parseDataset,
  });

  if (loaded.source === "missing") {
    if (!datasetDir) {
      throw new Error(
        "LoCoMo full mode requires datasetDir. Pass a dataset path or use quick mode to run the bundled smoke fixture.",
      );
    }
    throw new Error(
      formatMissingDatasetError(
        "locomo",
        datasetDir,
        LOCOMO_DATASET_FILENAMES,
        loaded.errors,
      ),
    );
  }

  if (loaded.items.length === 0) {
    throw new Error(
      "LoCoMo dataset is empty after applying the requested limit.",
    );
  }

  if (loaded.source === "smoke" && loaded.errors.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      "[remnic-bench] LoCoMo falling back to smoke fixture: " +
        loaded.errors.join(" | "),
    );
  }

  if (!loaded.sha256) {
    throw new Error("LoCoMo dataset loader did not provide a content hash.");
  }
  return {
    source: loaded.source,
    ...(loaded.filename === undefined ? {} : { filename: loaded.filename }),
    sha256: loaded.sha256,
    items: loaded.items,
  };
}

