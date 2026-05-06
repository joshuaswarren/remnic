import type {
  BenchMemoryAdapter,
  BenchResponder,
  Message,
} from "../../../adapters/types.js";
import { isUnknownOnlyAnswer } from "../../../answering.js";
import type {
  BenchmarkMode,
  BenchmarkResult,
  TaskResult,
} from "../../../types.js";

export type AmaBenchDiagnosticRecallMode =
  | "remnic-full"
  | "explicit-evidence-only"
  | "oracle-trajectory";

export type AmaBenchDiagnosticAnswererMode = "normal" | "strong";

export interface AmaBenchDiagnosticVariant {
  id: string;
  label: string;
  recallMode: AmaBenchDiagnosticRecallMode;
  answererMode: AmaBenchDiagnosticAnswererMode;
  description: string;
}

export const AMA_BENCH_DIAGNOSTIC_VARIANTS: readonly AmaBenchDiagnosticVariant[] = Object.freeze([
  {
    id: "remnic-full-normal",
    label: "Remnic full recall + normal answerer",
    recallMode: "remnic-full",
    answererMode: "normal",
    description:
      "Current Remnic recall surface, including explicit cue evidence, full recall, search evidence, and fallback context.",
  },
  {
    id: "explicit-only-normal",
    label: "Explicit evidence only + normal answerer",
    recallMode: "explicit-evidence-only",
    answererMode: "normal",
    description:
      "Keeps only the Explicit Cue Evidence section from Remnic recall to isolate exact visible trajectory cues.",
  },
  {
    id: "oracle-trajectory-normal",
    label: "Oracle trajectory recall + normal answerer",
    recallMode: "oracle-trajectory",
    answererMode: "normal",
    description:
      "Diagnostic ceiling that recalls the full stored visible action/observation trajectory without using hidden answers.",
  },
  {
    id: "remnic-full-strong",
    label: "Remnic full recall + strong answerer",
    recallMode: "remnic-full",
    answererMode: "strong",
    description:
      "Current Remnic recall surface answered by the strong diagnostic responder.",
  },
  {
    id: "explicit-only-strong",
    label: "Explicit evidence only + strong answerer",
    recallMode: "explicit-evidence-only",
    answererMode: "strong",
    description:
      "Exact visible trajectory cues answered by the strong diagnostic responder.",
  },
  {
    id: "oracle-trajectory-strong",
    label: "Oracle trajectory recall + strong answerer",
    recallMode: "oracle-trajectory",
    answererMode: "strong",
    description:
      "Full visible trajectory recall answered by the strong diagnostic responder.",
  },
]);

const DEFAULT_NORMAL_VARIANT_IDS = new Set([
  "remnic-full-normal",
  "explicit-only-normal",
  "oracle-trajectory-normal",
]);

export function selectAmaBenchDiagnosticVariants(options: {
  ids?: string[];
  includeStrong?: boolean;
} = {}): AmaBenchDiagnosticVariant[] {
  const byId = new Map(
    AMA_BENCH_DIAGNOSTIC_VARIANTS.map((variant) => [variant.id, variant]),
  );
  const requested = options.ids?.map((id) => id.trim()).filter(Boolean);
  const variants = requested && requested.length > 0
    ? requested.map((id) => {
        const variant = byId.get(id);
        if (!variant) {
          throw new Error(
            `Unknown AMA-Bench diagnostic variant "${id}". Available variants: ${
              [...byId.keys()].join(", ")
            }.`,
          );
        }
        return variant;
      })
    : AMA_BENCH_DIAGNOSTIC_VARIANTS.filter((variant) =>
        DEFAULT_NORMAL_VARIANT_IDS.has(variant.id) ||
        (options.includeStrong === true && variant.answererMode === "strong"),
      );

  return variants.map((variant) => ({ ...variant }));
}

export interface AmaBenchDiagnosticAdapterOptions {
  strongResponder?: BenchResponder;
}

export function createAmaBenchDiagnosticAdapter(
  base: BenchMemoryAdapter,
  variant: AmaBenchDiagnosticVariant,
  options: AmaBenchDiagnosticAdapterOptions = {},
): BenchMemoryAdapter {
  const sessions = new Map<string, Message[]>();

  const clearCapturedSession = (sessionId?: string): void => {
    if (sessionId) {
      sessions.delete(sessionId);
      return;
    }
    sessions.clear();
  };

  const diagnostic: BenchMemoryAdapter = {
    async store(sessionId, messages) {
      const existing = sessions.get(sessionId) ?? [];
      sessions.set(sessionId, [...existing, ...messages]);
      if (variant.recallMode !== "oracle-trajectory") {
        await base.store(sessionId, messages);
      }
    },
    async recall(sessionId, query, budgetChars) {
      if (variant.recallMode === "oracle-trajectory") {
        return buildOracleTrajectoryRecall(
          sessions.get(sessionId) ?? [],
          budgetChars,
        );
      }

      const recalled = await base.recall(sessionId, query, budgetChars);
      if (variant.recallMode === "explicit-evidence-only") {
        return extractMarkdownSectionsByTitle(recalled, [
          "Explicit Cue Evidence",
        ]);
      }

      return recalled;
    },
    async search(query, limit, sessionId) {
      return base.search(query, limit, sessionId);
    },
    async reset(sessionId) {
      clearCapturedSession(sessionId);
      await base.reset(sessionId);
    },
    async getStats(sessionId) {
      return base.getStats(sessionId);
    },
    async drain() {
      if (variant.recallMode !== "oracle-trajectory") {
        await base.drain?.();
      }
    },
    async destroy() {
      await base.destroy();
    },
  };

  Object.defineProperty(diagnostic, "responder", {
    enumerable: true,
    get() {
      return variant.answererMode === "strong"
        ? options.strongResponder ?? base.responder
        : base.responder;
    },
  });
  Object.defineProperty(diagnostic, "judge", {
    enumerable: true,
    get() {
      return base.judge;
    },
  });

  return diagnostic;
}

export function buildOracleTrajectoryRecall(
  messages: readonly Message[],
  budgetChars?: number,
): string {
  if (messages.length === 0) {
    return "";
  }

  const body = messages
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0)
    .join("\n");
  if (body.length === 0) {
    return "";
  }

  return truncateToBudget(`## Explicit Cue Evidence\n${body}`, budgetChars);
}

export function extractMarkdownSectionsByTitle(
  markdown: string,
  allowedTitles: readonly string[],
): string {
  const allowed = new Set(allowedTitles);
  const sections: string[] = [];
  let currentTitle: string | undefined;
  let currentLines: string[] = [];

  const flush = (): void => {
    if (currentTitle && allowed.has(currentTitle)) {
      const section = [`## ${currentTitle}`, ...currentLines].join("\n").trim();
      if (section.length > 0) {
        sections.push(section);
      }
    }
    currentTitle = undefined;
    currentLines = [];
  };

  for (const line of splitMarkdownLines(markdown)) {
    const headingTitle = secondLevelMarkdownHeadingTitle(line);
    if (headingTitle) {
      flush();
      currentTitle = headingTitle;
      currentLines = [];
      continue;
    }
    if (currentTitle) {
      currentLines.push(line);
    }
  }
  flush();

  return sections.join("\n\n");
}

function splitMarkdownLines(markdown: string): string[] {
  return markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
}

function secondLevelMarkdownHeadingTitle(line: string): string | undefined {
  if (!line.startsWith("##") || line.startsWith("###")) {
    return undefined;
  }

  const title = line.slice(2);
  if (!title.startsWith(" ") && !title.startsWith("\t")) {
    return undefined;
  }

  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export interface AmaBenchDiagnosticTaskRow {
  variantId: string;
  taskId: string;
  episodeId?: string | number;
  domain: string;
  qaType: string;
  taskType: string;
  scores: Record<string, number>;
  unknownLike: boolean;
  recalledLength: number;
  answeredLength: number;
  recallSections: string[];
  responderModel?: string;
  judgeModel?: string;
  crossJudgeModel?: string;
  crossJudgeScore?: number;
}

export interface AmaBenchDiagnosticBreakdown {
  key: string;
  taskCount: number;
  unknownLikeRate: number;
  scoreMeans: Record<string, number>;
  scoreCounts: Record<string, number>;
}

export interface AmaBenchDiagnosticVariantSummary {
  variant: AmaBenchDiagnosticVariant;
  usesFullRemnicRecallProcess: boolean;
  isPrimaryFullSystemScore: boolean;
  taskCount: number;
  unknownLikeRate: number;
  scoreMeans: Record<string, number>;
  scoreCounts: Record<string, number>;
  byDomain: AmaBenchDiagnosticBreakdown[];
  byQaType: AmaBenchDiagnosticBreakdown[];
  byDomainAndQaType: AmaBenchDiagnosticBreakdown[];
  tasks: AmaBenchDiagnosticTaskRow[];
}

export interface SanitizedDiagnosticProvider {
  provider: string;
  model: string;
  baseUrl?: string;
  reasoningEffort?: string;
}

export interface AmaBenchDiagnosticMatrixArtifact {
  schemaVersion: 1;
  benchmark: "ama-bench";
  generatedAt: string;
  mode: BenchmarkMode;
  config: {
    runtimeProfile?: string;
    adapterMode?: string;
    datasetDir?: string;
    limit?: number;
    seed?: number;
    systemProvider?: SanitizedDiagnosticProvider | null;
    judgeProvider?: SanitizedDiagnosticProvider | null;
    internalProvider?: SanitizedDiagnosticProvider | null;
    amaBenchCrossJudgeProvider?: SanitizedDiagnosticProvider | null;
    strongSystemProvider?: SanitizedDiagnosticProvider | null;
    variantIds?: string[];
  };
  variants: AmaBenchDiagnosticVariantSummary[];
}

export interface AmaBenchDiagnosticRunContext {
  runtimeProfile?: string;
  hasResponder?: boolean;
}

export function buildAmaBenchDiagnosticVariantSummary(
  variant: AmaBenchDiagnosticVariant,
  result: BenchmarkResult,
  context: AmaBenchDiagnosticRunContext = {},
): AmaBenchDiagnosticVariantSummary {
  const tasks = result.results.tasks.map((task) =>
    taskToDiagnosticRow(variant.id, task),
  );
  const usesFullRemnicRecallProcess =
    context.runtimeProfile === "real" &&
    variant.recallMode === "remnic-full";
  const isPrimaryFullSystemScore =
    usesFullRemnicRecallProcess &&
    result.meta.mode === "full" &&
    context.hasResponder === true &&
    variant.answererMode === "normal";

  return {
    variant: { ...variant },
    usesFullRemnicRecallProcess,
    isPrimaryFullSystemScore,
    taskCount: tasks.length,
    unknownLikeRate: unknownLikeRate(tasks),
    ...summarizeScores(tasks),
    byDomain: groupBreakdowns(tasks, (task) => task.domain),
    byQaType: groupBreakdowns(tasks, (task) => task.qaType),
    byDomainAndQaType: groupBreakdowns(
      tasks,
      (task) => `${task.domain} / ${task.qaType}`,
    ),
    tasks,
  };
}

export function buildAmaBenchDiagnosticMatrixArtifact(args: {
  mode: BenchmarkMode;
  config?: AmaBenchDiagnosticMatrixArtifact["config"];
  variants: AmaBenchDiagnosticVariantSummary[];
  generatedAt?: string;
}): AmaBenchDiagnosticMatrixArtifact {
  return {
    schemaVersion: 1,
    benchmark: "ama-bench",
    generatedAt: args.generatedAt ?? new Date().toISOString(),
    mode: args.mode,
    config: args.config ?? {},
    variants: args.variants,
  };
}

export function isAmaBenchUnknownLikeAnswer(answer: string): boolean {
  if (isUnknownOnlyAnswer(answer)) {
    return true;
  }

  const normalized = answer.trim().toLowerCase();
  return (
    /\b(?:not enough|insufficient)\s+(?:information|context|evidence)\b/.test(normalized) ||
    /\b(?:not specified|not provided|not mentioned|cannot determine|can't determine)\b/.test(normalized) ||
    /\bno relevant evidence\b/.test(normalized)
  );
}

function taskToDiagnosticRow(
  variantId: string,
  task: TaskResult,
): AmaBenchDiagnosticTaskRow {
  const details = task.details ?? {};
  return {
    variantId,
    taskId: task.taskId,
    episodeId: asStringOrNumber(details.episodeId),
    domain: asString(details.domain, "unknown-domain"),
    qaType: asString(details.qaType, "unknown-qa-type"),
    taskType: asString(details.taskType, "unknown-task-type"),
    scores: { ...task.scores },
    unknownLike: isAmaBenchUnknownLikeAnswer(task.actual),
    recalledLength: asNumber(details.recalledLength, 0),
    answeredLength: asNumber(details.answeredLength, task.actual.length),
    recallSections: asStringArray(details.recallSections),
    responderModel: asOptionalString(details.responderModel),
    judgeModel: asOptionalString(details.judgeModel),
    crossJudgeModel: asOptionalString(details.amaBenchCrossJudgeModel),
    crossJudgeScore: asOptionalNumber(details.amaBenchCrossJudgeScore),
  };
}

function truncateToBudget(text: string, budgetChars?: number): string {
  if (budgetChars === undefined) {
    return text;
  }
  if (!Number.isFinite(budgetChars) || budgetChars <= 0) {
    return "";
  }
  return text.length > budgetChars ? text.slice(0, budgetChars) : text;
}

function groupBreakdowns(
  tasks: AmaBenchDiagnosticTaskRow[],
  keyForTask: (task: AmaBenchDiagnosticTaskRow) => string,
): AmaBenchDiagnosticBreakdown[] {
  const groups = new Map<string, AmaBenchDiagnosticTaskRow[]>();
  for (const task of tasks) {
    const key = keyForTask(task);
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }

  return [...groups.entries()]
    .map(([key, groupTasks]) => ({
      key,
      taskCount: groupTasks.length,
      unknownLikeRate: unknownLikeRate(groupTasks),
      ...summarizeScores(groupTasks),
    }))
    .sort((left, right) => {
      if (left.taskCount !== right.taskCount) {
        return right.taskCount - left.taskCount;
      }
      return left.key.localeCompare(right.key);
    });
}

function unknownLikeRate(tasks: readonly AmaBenchDiagnosticTaskRow[]): number {
  if (tasks.length === 0) {
    return 0;
  }
  const unknownCount = tasks.filter((task) => task.unknownLike).length;
  return unknownCount / tasks.length;
}

function summarizeScores(tasks: readonly AmaBenchDiagnosticTaskRow[]): {
  scoreMeans: Record<string, number>;
  scoreCounts: Record<string, number>;
} {
  const values = new Map<string, number[]>();
  for (const task of tasks) {
    for (const [metric, value] of Object.entries(task.scores)) {
      if (Number.isFinite(value) && value >= 0) {
        values.set(metric, [...(values.get(metric) ?? []), value]);
      }
    }
  }

  const scoreMeans: Record<string, number> = {};
  const scoreCounts: Record<string, number> = {};
  for (const [metric, metricValues] of [...values.entries()].sort()) {
    scoreCounts[metric] = metricValues.length;
    scoreMeans[metric] =
      metricValues.reduce((sum, value) => sum + value, 0) /
      metricValues.length;
  }
  return { scoreMeans, scoreCounts };
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function asStringOrNumber(value: unknown): string | number | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0,
  );
}
