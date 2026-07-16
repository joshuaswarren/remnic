import type {
  BenchMemoryAdapter,
  BenchRecallTrace,
  BenchRecallTraceCoreCapture,
  BenchRecallTraceSelection,
} from "../../../adapters/types.js";
import { canonicalJsonStringify, hashCanonicalJson, hashString } from "../../../integrity/hash-verification.js";
import { benchmarkRecallBudgetForSessionCount } from "../../../recall-budget.js";
import { isSecretKey } from "../../../security/secret-keys.js";
import {
  type LoCoMoContentDigest,
  type LoCoMoRecallCompositionReceipt,
  buildLoCoMoPlan,
  loadLoCoMoDataset,
  prioritizeLoCoMoRecallTextWithTrace,
  sanitizeLoCoMoRecallText,
} from "./runner.js";
import {
  LOCOMO_TASK_SELECTION_VERSION,
  type LoCoMoTaskSelectionManifest,
  type LoCoMoTaskSelector,
  selectLoCoMoTasks,
} from "./task-selection.js";

export const LOCOMO_RETRIEVAL_TRACE_SCHEMA_VERSION = 1 as const;
export const LOCOMO_RETRIEVAL_TRACE_SELECTION_VERSION =
  LOCOMO_TASK_SELECTION_VERSION;
export const LOCOMO_RETRIEVAL_TRACE_BUDGET_VERSION = 1 as const;

export type LoCoMoRetrievalTraceProfile = "baseline" | "real";

export type LoCoMoRetrievalTraceSelector = LoCoMoTaskSelector;
export type LoCoMoRetrievalTraceSelectionManifest =
  LoCoMoTaskSelectionManifest;

export interface LoCoMoRetrievalTraceCoreCaptureReceipt {
  budget: BenchRecallTraceCoreCapture["budget"];
  filters: BenchRecallTraceCoreCapture["filters"];
  results: Array<
    Pick<
      BenchRecallTraceCoreCapture["results"][number],
      "memoryIdRef" | "servedBy" | "scoreDecomposition" | "admittedBy" | "rejectedBy" | "disclosure" | "estimatedTokens"
    >
  >;
}

export interface LoCoMoRetrievalTraceSelectionReceipt extends Omit<BenchRecallTraceSelection, "summary"> {
  summary?: Omit<NonNullable<BenchRecallTraceSelection["summary"]>, "id">;
}

export interface LoCoMoRetrievalStructuralTrace extends Omit<BenchRecallTrace, "coreCapture" | "selections"> {
  selections: LoCoMoRetrievalTraceSelectionReceipt[];
  coreCapture?: LoCoMoRetrievalTraceCoreCaptureReceipt;
}

export interface LoCoMoRetrievalSessionReceipt {
  session: LoCoMoContentDigest;
  trace: LoCoMoRetrievalStructuralTrace;
}

export interface LoCoMoRetrievalTaskReceipt {
  taskId: string;
  question: LoCoMoContentDigest;
  recallBudgetChars: number;
  sessions: LoCoMoRetrievalSessionReceipt[];
  composition: LoCoMoRecallCompositionReceipt;
}

export interface LoCoMoRetrievalTraceReceipt {
  schemaVersion: typeof LOCOMO_RETRIEVAL_TRACE_SCHEMA_VERSION;
  benchmarkId: "locomo";
  captureKind: "retrieval-only";
  artifactHash: string;
  sensitivity: {
    classification: "restricted";
    contentEncoding: "sha256+length";
    containsGold: false;
    containsRawContent: false;
  };
  provenance: {
    gitSha: string;
    remnicVersion: string;
    runtimeProfile: LoCoMoRetrievalTraceProfile;
    adapterMode: "direct";
    replayExtractionMode: "skip";
    providerFree: true;
    dataset: {
      id: "locomo-10";
      sha256: string;
    };
    retrievalConfigSha256: string;
    recallBudget: {
      algorithm: "benchmarkRecallBudgetForSessionCount";
      version: typeof LOCOMO_RETRIEVAL_TRACE_BUDGET_VERSION;
    };
  };
  selection: LoCoMoRetrievalTraceSelectionManifest;
  tasks: LoCoMoRetrievalTaskReceipt[];
}

export interface CaptureLoCoMoRetrievalTraceOptions {
  datasetDir: string;
  runtimeProfile: LoCoMoRetrievalTraceProfile;
  system: BenchMemoryAdapter;
  retrievalConfig: Record<string, unknown>;
  selector: LoCoMoRetrievalTraceSelector;
  gitSha: string;
  remnicVersion: string;
  multiHopRecallComposition?: boolean;
  providerFreeConfirmed: true;
}

interface SelectableTask {
  taskId: string;
  question: string;
  recallSessionIds: string[];
  planIndex: number;
}

export async function preflightLoCoMoRetrievalTraceCapture(
  options: Omit<CaptureLoCoMoRetrievalTraceOptions, "system">
): Promise<void> {
  assertCaptureOptions(options);
  assertProviderFreeRetrievalConfig(options.retrievalConfig);
  const loaded = await loadLoCoMoDataset("full", options.datasetDir);
  const multiHopRecallComposition = options.multiHopRecallComposition ?? true;
  const plans = loaded.items.map((conversation) => buildLoCoMoPlan(conversation, multiHopRecallComposition));
  const selectable = plans.flatMap((plan, planIndex) =>
    plan.trials.map((trial) => ({ taskId: trial.taskId, planIndex }))
  );
  selectLoCoMoRetrievalTraceTasks(selectable, options.selector);
}

export function buildProviderFreeLoCoMoRetrievalConfig(
  retrievalConfig: Record<string, unknown>
): Record<string, unknown> {
  const sanitized = sanitizeProviderFreeRetrievalConfig(retrievalConfig) as Record<string, unknown>;
  return assertProviderFreeRetrievalConfig({
    ...sanitized,
    localLlmEnabled: false,
    localLlmFastEnabled: false,
    recallPlannerEnabled: false,
    embeddingFallbackEnabled: false,
    hostEmbeddingProviderEnabled: false,
    openaiApiKey: false,
    modelSource: "plugin",
  });
}

export async function captureLoCoMoRetrievalTrace(
  options: CaptureLoCoMoRetrievalTraceOptions
): Promise<LoCoMoRetrievalTraceReceipt> {
  assertCaptureOptions(options);
  const retrievalConfig = assertProviderFreeRetrievalConfig(options.retrievalConfig);
  const recallWithTrace = options.system.recallWithTrace?.bind(options.system);
  if (!recallWithTrace) {
    throw new Error("LoCoMo retrieval trace capture requires system.recallWithTrace().");
  }

  const loaded = await loadLoCoMoDataset("full", options.datasetDir);
  const multiHopRecallComposition = options.multiHopRecallComposition ?? true;
  const plans = loaded.items.map((conversation) => buildLoCoMoPlan(conversation, multiHopRecallComposition));
  const selectable = plans.flatMap((plan, planIndex) =>
    plan.trials.map(
      (trial): SelectableTask => ({
        taskId: trial.taskId,
        question: trial.question,
        recallSessionIds: [...trial.recallSessionIds],
        planIndex,
      })
    )
  );
  const selection = selectLoCoMoRetrievalTraceTasks(selectable, options.selector);
  const selectedIds = new Set(selection.selectedTaskIds);
  const tasks: LoCoMoRetrievalTaskReceipt[] = [];

  for (let planIndex = 0; planIndex < plans.length; planIndex += 1) {
    const selected = selectable.filter((task) => task.planIndex === planIndex && selectedIds.has(task.taskId));
    if (selected.length === 0) continue;
    const plan = plans[planIndex];
    if (!plan) throw new Error(`Missing LoCoMo plan at index ${planIndex}.`);
    await options.system.reset();
    for (const session of plan.ingestSessions) {
      if (session.messages.length > 0) {
        await options.system.store(session.sessionId, session.messages);
      }
    }
    await options.system.drain?.();

    for (const selectedTask of selected) {
      const recallBudgetChars = benchmarkRecallBudgetForSessionCount(selectedTask.recallSessionIds.length);
      const recalled = await Promise.all(
        selectedTask.recallSessionIds.map(async (sessionId) => {
          const result = await recallWithTrace(sessionId, selectedTask.question, recallBudgetChars);
          return {
            text: result.text,
            receipt: {
              session: digestContent(sessionId),
              trace: sanitizeStructuralTrace(result.trace),
            },
          };
        })
      );
      const rawRecalledText = recalled
        .map((entry) => entry.text)
        .filter(Boolean)
        .join("\n\n");
      const sanitized = sanitizeLoCoMoRecallText({
        question: selectedTask.question,
        recalledText: rawRecalledText,
      });
      const composition = prioritizeLoCoMoRecallTextWithTrace({
        question: selectedTask.question,
        recalledText: sanitized,
        multiHopRecallComposition,
      });
      tasks.push({
        taskId: selectedTask.taskId,
        question: digestContent(selectedTask.question),
        recallBudgetChars,
        sessions: recalled.map((entry) => entry.receipt),
        composition: composition.receipt,
      });
    }
  }

  const withoutHash = {
    schemaVersion: LOCOMO_RETRIEVAL_TRACE_SCHEMA_VERSION,
    benchmarkId: "locomo" as const,
    captureKind: "retrieval-only" as const,
    sensitivity: {
      classification: "restricted" as const,
      contentEncoding: "sha256+length" as const,
      containsGold: false as const,
      containsRawContent: false as const,
    },
    provenance: {
      gitSha: options.gitSha,
      remnicVersion: options.remnicVersion,
      runtimeProfile: options.runtimeProfile,
      adapterMode: "direct" as const,
      replayExtractionMode: "skip" as const,
      providerFree: true as const,
      dataset: { id: "locomo-10" as const, sha256: loaded.sha256 },
      retrievalConfigSha256: hashCanonicalJson(retrievalConfig),
      recallBudget: {
        algorithm: "benchmarkRecallBudgetForSessionCount" as const,
        version: LOCOMO_RETRIEVAL_TRACE_BUDGET_VERSION,
      },
    },
    selection,
    tasks,
  };
  return {
    ...withoutHash,
    artifactHash: hashCanonicalJson(withoutHash),
  };
}

export function selectLoCoMoRetrievalTraceTasks(
  tasks: readonly Pick<SelectableTask, "taskId">[],
  selector: LoCoMoRetrievalTraceSelector
): LoCoMoRetrievalTraceSelectionManifest {
  return selectLoCoMoTasks(tasks, selector);
}

export function serializeLoCoMoRetrievalTraceReceipt(receipt: LoCoMoRetrievalTraceReceipt): string {
  return `${canonicalJsonStringify(receipt, 2)}\n`;
}

function sanitizeStructuralTrace(trace: BenchRecallTrace): LoCoMoRetrievalStructuralTrace {
  return {
    schemaVersion: trace.schemaVersion,
    sensitivity: { ...trace.sensitivity },
    sections: trace.sections.map((section) => ({ ...section })),
    selections: trace.selections.map(({ summary, ...selection }) => ({
      ...selection,
      ...(selection.archiveRowIds === undefined ? {} : { archiveRowIds: [...selection.archiveRowIds] }),
      ...(summary === undefined
        ? {}
        : { summary: { depth: summary.depth, msgStart: summary.msgStart, msgEnd: summary.msgEnd } }),
    })),
    lcmCandidates: trace.lcmCandidates.map((candidate) => ({ ...candidate })),
    ...(trace.coreCapture === undefined
      ? {}
      : {
          coreCapture: {
            budget: { ...trace.coreCapture.budget },
            filters: trace.coreCapture.filters.map((filter) => ({ ...filter })),
            results: trace.coreCapture.results.map((result) => {
              assertMemoryIdRef(result.memoryIdRef);
              const score = result.scoreDecomposition;
              return {
                memoryIdRef: {
                  sha256: result.memoryIdRef.sha256,
                  length: result.memoryIdRef.length,
                },
                servedBy: result.servedBy,
                scoreDecomposition: {
                  ...(score.vector === undefined ? {} : { vector: score.vector }),
                  ...(score.bm25 === undefined ? {} : { bm25: score.bm25 }),
                  ...(score.importance === undefined ? {} : { importance: score.importance }),
                  ...(score.mmrPenalty === undefined ? {} : { mmrPenalty: score.mmrPenalty }),
                  ...(score.tierPrior === undefined ? {} : { tierPrior: score.tierPrior }),
                  ...(score.reinforcementBoost === undefined ? {} : { reinforcementBoost: score.reinforcementBoost }),
                  final: score.final,
                },
                admittedBy: [...result.admittedBy],
                ...(result.rejectedBy === undefined ? {} : { rejectedBy: result.rejectedBy }),
                ...(result.disclosure === undefined ? {} : { disclosure: result.disclosure }),
                ...(result.estimatedTokens === undefined ? {} : { estimatedTokens: result.estimatedTokens }),
              };
            }),
          },
        }),
    budget: { ...trace.budget },
  };
}

function digestContent(value: string): LoCoMoContentDigest {
  return {
    sha256: hashString(value),
    charCount: value.length,
    lineCount: value.length === 0 ? 0 : value.split("\n").length,
  };
}

function assertCaptureOptions(options: Omit<CaptureLoCoMoRetrievalTraceOptions, "system">): void {
  if (!options.datasetDir.trim()) {
    throw new Error("LoCoMo retrieval trace capture requires datasetDir.");
  }
  if (options.runtimeProfile !== "baseline" && options.runtimeProfile !== "real") {
    throw new Error('LoCoMo retrieval trace runtimeProfile must be "baseline" or "real".');
  }
  if (
    !options.gitSha.trim() ||
    !options.remnicVersion.trim() ||
    options.gitSha === "unknown" ||
    options.remnicVersion === "unknown"
  ) {
    throw new Error("LoCoMo retrieval trace provenance requires gitSha and remnicVersion.");
  }
  if (options.providerFreeConfirmed !== true) {
    throw new Error("LoCoMo retrieval trace capture requires explicit provider-free confirmation.");
  }
}

function assertProviderFreeRetrievalConfig(value: Record<string, unknown>): Record<string, unknown> {
  const config = assertJsonConfig(value) as Record<string, unknown>;
  for (const key of [
    "localLlmEnabled",
    "localLlmFastEnabled",
    "recallPlannerEnabled",
    "embeddingFallbackEnabled",
    "hostEmbeddingProviderEnabled",
    "openaiApiKey",
  ] as const) {
    if (config[key] !== false) {
      throw new Error(`retrievalConfig.${key} must be false for provider-free capture.`);
    }
  }
  if (config.modelSource !== "plugin") {
    throw new Error('retrievalConfig.modelSource must be "plugin" for provider-free capture.');
  }
  return config;
}

function assertMemoryIdRef(value: unknown): asserts value is { sha256: string; length: number } {
  if (
    !value ||
    typeof value !== "object" ||
    !/^[0-9a-f]{64}$/u.test((value as { sha256?: unknown }).sha256 as string) ||
    !Number.isSafeInteger((value as { length?: unknown }).length) ||
    (value as { length: number }).length <= 0
  ) {
    throw new Error("LoCoMo retrieval trace requires a valid content-free memoryIdRef.");
  }
}

function assertJsonConfig(value: unknown, path = "retrievalConfig"): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite JSON numbers.`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => assertJsonConfig(entry, `${path}[${index}]`));
  }
  if (!value || typeof value !== "object") {
    throw new Error(`${path} must be JSON-serializable and provider-free.`);
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (key === "openaiApiKey") {
      if (child !== false) {
        throw new Error(`${path}.${key} must be exactly false for provider-free capture.`);
      }
      output[key] = false;
      continue;
    }
    if (isSecretKey(key)) {
      throw new Error(`${path}.${key} contains secret-bearing configuration.`);
    }
    if (child === undefined) continue;
    if (
      /^(?:gatewayConfig|gatewayAgentId|fastGatewayAgentId|internalProvider|llmProvider|llmModel)$/iu.test(key) ||
      (key === "modelSource" && child !== "plugin")
    ) {
      throw new Error(`${path}.${key} is provider-capable configuration.`);
    }
    output[key] = assertJsonConfig(child, `${path}.${key}`);
  }
  return output;
}

function sanitizeProviderFreeRetrievalConfig(value: unknown, path = "retrievalConfig"): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite JSON numbers.`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => sanitizeProviderFreeRetrievalConfig(entry, `${path}[${index}]`));
  }
  if (!value || typeof value !== "object") {
    throw new Error(`${path} must be JSON-serializable.`);
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child === undefined) continue;
    if (
      isSecretKey(key) ||
      /^(?:gatewayConfig|gatewayAgentId|fastGatewayAgentId|internalProvider|llmProvider|llmModel)$/iu.test(key) ||
      key === "modelSource"
    ) {
      continue;
    }
    output[key] = sanitizeProviderFreeRetrievalConfig(child, `${path}.${key}`);
  }
  return output;
}
