import type {
  LoCoMoRetrievalTaskReceipt,
  LoCoMoRetrievalTraceReceipt,
} from "../benchmarks/published/locomo/retrieval-trace-runner.js";
import { canonicalJsonStringify, hashCanonicalJson, hashString, isSha256Hex } from "../integrity/hash-verification.js";

export const LOCOMO_RETRIEVAL_TRACE_DELTA_SCHEMA_VERSION = 1 as const;

const CATEGORIES = ["single_hop", "multi_hop", "temporal", "open_domain", "adversarial"] as const;
const MECHANISMS = [
  "real-core-visible-lcm-displacement",
  "lcm-selection-change",
  "composition-filter-displacement",
  "composition-digest-change",
  "budget-truncation-change",
  "mixed",
  "no-structural-delta",
  "insufficient-exact-lineage",
] as const;

export type LoCoMoRetrievalMechanism = (typeof MECHANISMS)[number];
export type LoCoMoCategory = (typeof CATEGORIES)[number];

export interface LoCoMoStructuralMultisetDelta {
  baselineCount: number;
  realCount: number;
  sharedCount: number;
  baselineOnlyCount: number;
  realOnlyCount: number;
  changed: boolean;
}

export interface LoCoMoRetrievalTaskDelta {
  taskRef: { sha256: string; length: number };
  category: LoCoMoCategory;
  mechanism: LoCoMoRetrievalMechanism;
  dimensions: {
    sectionVisibleChars: LoCoMoStructuralMultisetDelta;
    selections: LoCoMoStructuralMultisetDelta;
    archiveRows: LoCoMoStructuralMultisetDelta;
    lcmCandidates: LoCoMoStructuralMultisetDelta;
    coreResults: LoCoMoStructuralMultisetDelta;
    coreFilters: LoCoMoStructuralMultisetDelta;
    coreBudget: LoCoMoStructuralMultisetDelta;
    recallBudget: LoCoMoStructuralMultisetDelta;
    compositionPolicy: LoCoMoStructuralMultisetDelta;
    compositionDigests: LoCoMoStructuralMultisetDelta;
  };
}

export interface LoCoMoRetrievalMechanismSummary {
  taskCount: number;
  mechanisms: Record<LoCoMoRetrievalMechanism, number>;
}

export interface LoCoMoRetrievalTraceDeltaReport {
  schemaVersion: typeof LOCOMO_RETRIEVAL_TRACE_DELTA_SCHEMA_VERSION;
  benchmarkId: "locomo";
  analysisKind: "paired-retrieval-structural-delta";
  artifactHash: string;
  sensitivity: {
    classification: "restricted";
    contentEncoding: "sha256+length";
    containsGold: false;
    containsRawContent: false;
    containsRawIdentifiers: false;
  };
  comparison: {
    baselineArtifactHash: string;
    realArtifactHash: string;
    retrievalConfigHashesDiffer: true;
    taskOrderSha256: string;
  };
  overall: LoCoMoRetrievalMechanismSummary;
  categories: Array<LoCoMoRetrievalMechanismSummary & { category: LoCoMoCategory }>;
  dominantMultiHopMechanism: {
    status: "supported" | "not-supported";
    mechanism?: LoCoMoRetrievalMechanism;
    count: number;
    taskCount: number;
    rule: "strict-majority-and-at-least-two";
  };
  tasks: LoCoMoRetrievalTaskDelta[];
  evidenceBoundary: {
    attribution: "observed-structural-mechanism-only";
    causalClaim: false;
    exactLineageRequired: true;
    explanation: string;
  };
}

export function diagnoseLoCoMoRetrievalTraceDelta(
  baseline: LoCoMoRetrievalTraceReceipt,
  real: LoCoMoRetrievalTraceReceipt
): LoCoMoRetrievalTraceDeltaReport {
  assertReceipt(baseline, "baseline");
  assertReceipt(real, "real");
  assertComparable(baseline, real);

  const tasks = baseline.tasks.map((baselineTask, index) =>
    compareTask(baselineTask, real.tasks[index] as LoCoMoRetrievalTaskReceipt)
  );
  const overall = summarize(tasks);
  const categories = CATEGORIES.filter((category) => tasks.some((task) => task.category === category)).map(
    (category) => ({ category, ...summarize(tasks.filter((task) => task.category === category)) })
  );
  const multiHop = tasks.filter((task) => task.category === "multi_hop");
  const candidates = MECHANISMS.filter(
    (mechanism) => mechanism !== "no-structural-delta" && mechanism !== "insufficient-exact-lineage"
  ).map((mechanism) => ({ mechanism, count: multiHop.filter((task) => task.mechanism === mechanism).length }));
  candidates.sort((left, right) => right.count - left.count || left.mechanism.localeCompare(right.mechanism));
  const dominant = candidates[0];
  const supported = dominant !== undefined && dominant.count >= 2 && dominant.count * 2 > multiHop.length;

  const withoutHash = {
    schemaVersion: LOCOMO_RETRIEVAL_TRACE_DELTA_SCHEMA_VERSION,
    benchmarkId: "locomo" as const,
    analysisKind: "paired-retrieval-structural-delta" as const,
    sensitivity: {
      classification: "restricted" as const,
      contentEncoding: "sha256+length" as const,
      containsGold: false as const,
      containsRawContent: false as const,
      containsRawIdentifiers: false as const,
    },
    comparison: {
      baselineArtifactHash: baseline.artifactHash,
      realArtifactHash: real.artifactHash,
      retrievalConfigHashesDiffer: true as const,
      taskOrderSha256: hashCanonicalJson(baseline.tasks.map((task) => digestIdentifier(task.taskId))),
    },
    overall,
    categories,
    dominantMultiHopMechanism: {
      status: supported ? ("supported" as const) : ("not-supported" as const),
      ...(supported && dominant ? { mechanism: dominant.mechanism } : {}),
      count: dominant?.count ?? 0,
      taskCount: multiHop.length,
      rule: "strict-majority-and-at-least-two" as const,
    },
    tasks,
    evidenceBoundary: {
      attribution: "observed-structural-mechanism-only" as const,
      causalClaim: false as const,
      exactLineageRequired: true as const,
      explanation:
        "Labels summarize paired, content-free structural differences. They do not prove that a retrieval mechanism caused an answer or score change.",
    },
  };
  return { ...withoutHash, artifactHash: hashCanonicalJson(withoutHash) };
}

export function serializeLoCoMoRetrievalTraceDelta(report: LoCoMoRetrievalTraceDeltaReport): string {
  return `${canonicalJsonStringify(report, 2)}\n`;
}

function compareTask(baseline: LoCoMoRetrievalTaskReceipt, real: LoCoMoRetrievalTaskReceipt): LoCoMoRetrievalTaskDelta {
  const category = categoryOf(baseline.taskId);
  const dimensions = {
    sectionVisibleChars: delta(signatures(baseline, "sectionVisibleChars"), signatures(real, "sectionVisibleChars")),
    selections: delta(signatures(baseline, "selections"), signatures(real, "selections")),
    archiveRows: delta(signatures(baseline, "archiveRows"), signatures(real, "archiveRows")),
    lcmCandidates: delta(signatures(baseline, "lcmCandidates"), signatures(real, "lcmCandidates")),
    coreResults: delta(signatures(baseline, "coreResults"), signatures(real, "coreResults")),
    coreFilters: delta(signatures(baseline, "coreFilters"), signatures(real, "coreFilters")),
    coreBudget: delta(signatures(baseline, "coreBudget"), signatures(real, "coreBudget")),
    recallBudget: delta(signatures(baseline, "recallBudget"), signatures(real, "recallBudget")),
    compositionPolicy: delta(signatures(baseline, "compositionPolicy"), signatures(real, "compositionPolicy")),
    compositionDigests: delta(signatures(baseline, "compositionDigests"), signatures(real, "compositionDigests")),
  };
  const hasCompleteExactLineage = (task: LoCoMoRetrievalTaskReceipt): boolean => {
    return task.sessions.every((session) => {
      const renderedSections = session.trace.sections.filter(
        (section) => section.source === "lcm-summary" || section.source === "raw-row"
      );
      const lcmSelections = session.trace.selections.filter(
        (selection) => selection.kind === "lcm-summary" || selection.kind === "raw-row"
      );
      const selectionMatchesSection = (selection: (typeof session.trace.selections)[number]): boolean =>
        renderedSections.some((section) => section.id === selection.sectionId && section.source === selection.kind);
      const renderedLineageComplete = renderedSections.every((section) =>
        lcmSelections.some(
          (selection) =>
            selection.sectionId === section.id &&
            selection.kind === section.source &&
            hasExactSelectionLineage(selection)
        )
      );
      const candidateLineageComplete = session.trace.lcmCandidates.every(hasExactCandidateLineage);
      const hasCarrier =
        (renderedSections.length > 0 && renderedLineageComplete) ||
        (renderedSections.length === 0 &&
          lcmSelections.length === 0 &&
          session.trace.lcmCandidates.length > 0 &&
          candidateLineageComplete);
      const hasLcmEvidence =
        renderedSections.length > 0 || lcmSelections.length > 0 || session.trace.lcmCandidates.length > 0;
      return (
        (!hasLcmEvidence || hasCarrier) &&
        lcmSelections.every(selectionMatchesSection) &&
        lcmSelections.every(hasExactSelectionLineage) &&
        (renderedSections.length > 0 || candidateLineageComplete) &&
        (session.trace.coreCapture?.results.every(
          (result) => isSha256Hex(result.memoryIdRef.sha256) && result.memoryIdRef.length > 0
        ) ??
          true)
      );
    });
  };
  const exact = hasCompleteExactLineage(baseline) && hasCompleteExactLineage(real);
  const lcmSelectionsChanged = delta(
    exactSelectionSignatures(baseline, "lcm"),
    exactSelectionSignatures(real, "lcm")
  ).changed;
  const lcmArchiveRowsChanged = delta(
    exactArchiveRowSignatures(baseline, "lcm"),
    exactArchiveRowSignatures(real, "lcm")
  ).changed;
  const auxiliarySelectionsChanged = delta(
    exactSelectionSignatures(baseline, "auxiliary"),
    exactSelectionSignatures(real, "auxiliary")
  ).changed;
  const auxiliaryArchiveRowsChanged = delta(
    exactArchiveRowSignatures(baseline, "auxiliary"),
    exactArchiveRowSignatures(real, "auxiliary")
  ).changed;
  const core = dimensions.coreResults.changed || dimensions.coreFilters.changed || dimensions.coreBudget.changed;
  const baselineVisible = visibleCharsByGroup(baseline);
  const realVisible = visibleCharsByGroup(real);
  const coreSections = sectionGroupChanged(baseline, real, "core");
  const lcmSections = sectionGroupChanged(baseline, real, "lcm");
  const otherSections = sectionGroupChanged(baseline, real, "other");
  const lcm = lcmSections || lcmSelectionsChanged || lcmArchiveRowsChanged || dimensions.lcmCandidates.changed;
  const auxiliary = auxiliarySelectionsChanged || auxiliaryArchiveRowsChanged;
  const other = otherSections || auxiliary;
  const compositionPolicy = dimensions.compositionPolicy.changed;
  const compositionDigests = dimensions.compositionDigests.changed;
  const budget = dimensions.recallBudget.changed;
  const coreVisibleLcmDisplacement =
    core &&
    lcm &&
    realVisible.core > baselineVisible.core &&
    realVisible.lcm < baselineVisible.lcm &&
    !other &&
    !budget;
  let mechanism: LoCoMoRetrievalMechanism;
  if (!exact) mechanism = "insufficient-exact-lineage";
  else if (coreVisibleLcmDisplacement) mechanism = "real-core-visible-lcm-displacement";
  else if (lcm && !core && !coreSections && !other && !budget) mechanism = "lcm-selection-change";
  else if (budget && !core && !coreSections && !lcm && !other) mechanism = "budget-truncation-change";
  else if (compositionPolicy && !core && !coreSections && !lcm && !other && !budget)
    mechanism = "composition-filter-displacement";
  else if (compositionDigests && !compositionPolicy && !core && !coreSections && !lcm && !other && !budget)
    mechanism = "composition-digest-change";
  else if (!core && !coreSections && !lcm && !other && !budget && !compositionPolicy && !compositionDigests)
    mechanism = "no-structural-delta";
  else mechanism = "mixed";
  return { taskRef: digestIdentifier(baseline.taskId), category, mechanism, dimensions };
}

function visibleCharsByGroup(task: LoCoMoRetrievalTaskReceipt): { core: number; lcm: number; other: number } {
  const output = { core: 0, lcm: 0, other: 0 };
  for (const session of task.sessions) {
    for (const section of session.trace.sections) {
      if (section.source === "core") {
        output.core += section.visibleChars;
      } else if (section.source === "lcm-summary" || section.source === "raw-row") {
        output.lcm += section.visibleChars;
      } else {
        output.other += section.visibleChars;
      }
    }
  }
  return output;
}

type SectionGroup = "core" | "lcm" | "other";

function sectionGroupChanged(
  baseline: LoCoMoRetrievalTaskReceipt,
  real: LoCoMoRetrievalTaskReceipt,
  group: SectionGroup
): boolean {
  const signaturesFor = (task: LoCoMoRetrievalTaskReceipt): string[] => {
    const output: string[] = [];
    task.sessions.forEach((session, sessionOrdinal) => {
      session.trace.sections.forEach((section, sectionOrdinal) => {
        if (sectionGroup(section.source) === group) {
          output.push(structuralSectionSignature(section, sessionOrdinal, sectionOrdinal));
        }
      });
    });
    return output;
  };
  return delta(signaturesFor(baseline), signaturesFor(real)).changed;
}

function sectionGroup(
  source: LoCoMoRetrievalTaskReceipt["sessions"][number]["trace"]["sections"][number]["source"]
): SectionGroup {
  if (source === "core") return "core";
  if (source === "lcm-summary" || source === "raw-row") return "lcm";
  return "other";
}

function structuralSectionSignature(
  section: LoCoMoRetrievalTaskReceipt["sessions"][number]["trace"]["sections"][number],
  sessionOrdinal: number,
  sectionOrdinal: number
): string {
  return hashCanonicalJson({
    sessionOrdinal,
    sectionOrdinal,
    sectionIdRef: digestIdentifier(section.id),
    source: section.source,
    separatorStart: section.separatorStart,
    contentStart: section.contentStart,
    contentEnd: section.contentEnd,
    composedStart: section.composedStart,
    composedEnd: section.composedEnd,
    visibleStart: section.visibleStart,
    visibleEnd: section.visibleEnd,
    visibleChars: section.visibleChars,
  });
}

type Dimension = keyof LoCoMoRetrievalTaskDelta["dimensions"];
type SelectionScope = "all" | "lcm" | "auxiliary";

function selectionInScope(
  selection: LoCoMoRetrievalTaskReceipt["sessions"][number]["trace"]["selections"][number],
  scope: SelectionScope
): boolean {
  const isLcm = selection.kind === "lcm-summary" || selection.kind === "raw-row";
  return scope === "all" || (scope === "lcm" ? isLcm : !isLcm);
}

function exactSelectionSignatures(task: LoCoMoRetrievalTaskReceipt, scope: SelectionScope): string[] {
  const output: string[] = [];
  task.sessions.forEach((session, sessionOrdinal) => {
    for (const value of session.trace.selections) {
      if (!selectionInScope(value, scope) || !hasExactSelectionLineage(value)) continue;
      output.push(
        hashCanonicalJson({
          sessionOrdinal,
          kind: value.kind,
          lineageStatus: value.lineageStatus,
          turnIndex: value.turnIndex,
          role: value.role,
          score: value.score,
          summary: value.summary,
          archiveRowIds: value.archiveRowIds,
          composedStart: value.composedStart,
          composedEnd: value.composedEnd,
          visibleStart: value.visibleStart,
          visibleEnd: value.visibleEnd,
        })
      );
    }
  });
  return output;
}

function exactArchiveRowSignatures(task: LoCoMoRetrievalTaskReceipt, scope: SelectionScope): string[] {
  const output: string[] = [];
  task.sessions.forEach((session, sessionOrdinal) => {
    for (const value of session.trace.selections) {
      if (!selectionInScope(value, scope) || !hasExactSelectionLineage(value)) continue;
      for (const archiveRowId of value.archiveRowIds ?? []) {
        output.push(hashCanonicalJson({ sessionOrdinal, archiveRowId }));
      }
    }
  });
  return output;
}

function hasExactSelectionLineage(
  selection: LoCoMoRetrievalTaskReceipt["sessions"][number]["trace"]["selections"][number]
): boolean {
  if (selection.lineageStatus !== "exact") return false;
  if (selection.kind === "lcm-summary") {
    return (
      selection.summary !== undefined &&
      Number.isSafeInteger(selection.summary.depth) &&
      selection.summary.depth >= 0 &&
      Number.isSafeInteger(selection.summary.msgStart) &&
      selection.summary.msgStart >= 0 &&
      Number.isSafeInteger(selection.summary.msgEnd) &&
      selection.summary.msgEnd >= selection.summary.msgStart
    );
  }
  return (
    Array.isArray(selection.archiveRowIds) &&
    selection.archiveRowIds.length > 0 &&
    selection.archiveRowIds.every((id) => Number.isSafeInteger(id) && id > 0)
  );
}

function hasExactCandidateLineage(
  candidate: LoCoMoRetrievalTaskReceipt["sessions"][number]["trace"]["lcmCandidates"][number]
): boolean {
  return (
    candidate.lineageStatus === "exact" &&
    Number.isSafeInteger(candidate.archiveRowId) &&
    (candidate.archiveRowId as number) > 0
  );
}

function signatures(task: LoCoMoRetrievalTaskReceipt, dimension: Dimension): string[] {
  if (dimension === "selections") return exactSelectionSignatures(task, "all");
  if (dimension === "archiveRows") return exactArchiveRowSignatures(task, "all");
  if (dimension === "recallBudget") {
    return [
      hashCanonicalJson({
        recallBudgetChars: task.recallBudgetChars,
        budgets: task.sessions.map((session) => ({
          requestedChars: session.trace.budget.requestedChars,
          truncated: session.trace.budget.truncated,
        })),
      }),
    ];
  }
  if (dimension === "compositionPolicy") {
    return [
      hashCanonicalJson({
        mode: task.composition.mode,
        multiHopRecallComposition: task.composition.multiHopRecallComposition,
        selectedLines: task.composition.selectedLines.map((line) => ({
          inputOrdinal: line.inputOrdinal,
          stage: line.stage,
          hop: line.hop,
          visible: line.visible,
        })),
      }),
    ];
  }
  if (dimension === "compositionDigests") {
    return [
      hashCanonicalJson({
        input: task.composition.input,
        output: task.composition.output,
        selectedLines: task.composition.selectedLines.map((line) => ({ input: line.input, output: line.output })),
      }),
    ];
  }
  const output: string[] = [];
  task.sessions.forEach((session, sessionOrdinal) => {
    const trace = session.trace;
    if (dimension === "sectionVisibleChars") {
      trace.sections.forEach((value, sectionOrdinal) => {
        output.push(structuralSectionSignature(value, sessionOrdinal, sectionOrdinal));
      });
    } else if (dimension === "lcmCandidates") {
      for (const value of trace.lcmCandidates) {
        if (!hasExactCandidateLineage(value)) continue;
        output.push(
          hashCanonicalJson({
            sessionOrdinal,
            rank: value.rank,
            archiveRowId: value.archiveRowId,
            turnIndex: value.turnIndex,
            role: value.role,
            score: value.score,
            lineageStatus: value.lineageStatus,
          })
        );
      }
    } else if (dimension === "coreResults") {
      for (const [resultOrdinal, value] of (trace.coreCapture?.results ?? []).entries())
        output.push(
          hashCanonicalJson({
            sessionOrdinal,
            resultOrdinal,
            memoryIdRef: value.memoryIdRef,
            servedBy: value.servedBy,
            scoreDecomposition: value.scoreDecomposition,
            admittedBy: value.admittedBy,
            rejectedBy: value.rejectedBy,
            disclosure: value.disclosure,
            estimatedTokens: value.estimatedTokens,
          })
        );
    } else if (dimension === "coreFilters") {
      for (const value of trace.coreCapture?.filters ?? [])
        output.push(
          hashCanonicalJson({
            sessionOrdinal,
            name: value.name,
            considered: value.considered,
            admitted: value.admitted,
          })
        );
    } else if (dimension === "coreBudget") {
      if (trace.coreCapture) output.push(hashCanonicalJson({ sessionOrdinal, ...trace.coreCapture.budget }));
    }
  });
  return output;
}

function delta(baseline: string[], real: string[]): LoCoMoStructuralMultisetDelta {
  const realCounts = counts(real);
  let sharedCount = 0;
  for (const entry of baseline) {
    const available = realCounts.get(entry) ?? 0;
    if (available > 0) {
      sharedCount += 1;
      realCounts.set(entry, available - 1);
    }
  }
  return {
    baselineCount: baseline.length,
    realCount: real.length,
    sharedCount,
    baselineOnlyCount: baseline.length - sharedCount,
    realOnlyCount: real.length - sharedCount,
    changed: sharedCount !== baseline.length || sharedCount !== real.length,
  };
}

function counts(values: string[]): Map<string, number> {
  const output = new Map<string, number>();
  for (const value of values) output.set(value, (output.get(value) ?? 0) + 1);
  return output;
}

function summarize(tasks: LoCoMoRetrievalTaskDelta[]): LoCoMoRetrievalMechanismSummary {
  const mechanisms = Object.fromEntries(MECHANISMS.map((mechanism) => [mechanism, 0])) as Record<
    LoCoMoRetrievalMechanism,
    number
  >;
  for (const task of tasks) mechanisms[task.mechanism] += 1;
  return { taskCount: tasks.length, mechanisms };
}

function digestIdentifier(value: string): { sha256: string; length: number } {
  return { sha256: hashString(value), length: value.length };
}

function categoryOf(taskId: string): LoCoMoCategory {
  const category = CATEGORIES.find((candidate) => taskId.endsWith(`-${candidate}`));
  if (!category) throw new Error("LoCoMo retrieval trace task id has an unsupported category.");
  return category;
}

function assertReceipt(receipt: LoCoMoRetrievalTraceReceipt, label: string): void {
  if (!receipt || typeof receipt !== "object") throw new Error(`${label} receipt must be an object.`);
  assertFiniteJson(receipt, `${label} receipt`);
  assertExactKeys(
    receipt,
    ["schemaVersion", "benchmarkId", "captureKind", "artifactHash", "sensitivity", "provenance", "selection", "tasks"],
    `${label} receipt`
  );
  assertExactKeys(
    receipt.sensitivity,
    ["classification", "contentEncoding", "containsGold", "containsRawContent"],
    `${label} receipt.sensitivity`
  );
  assertExactKeys(
    receipt.provenance,
    [
      "gitSha",
      "remnicVersion",
      "runtimeProfile",
      "adapterMode",
      "replayExtractionMode",
      "providerFree",
      "dataset",
      "retrievalConfigSha256",
      "recallBudget",
    ],
    `${label} receipt.provenance`
  );
  assertExactKeys(receipt.provenance.dataset, ["id", "sha256"], `${label} receipt.provenance.dataset`);
  assertExactKeys(
    receipt.provenance.recallBudget,
    ["algorithm", "version"],
    `${label} receipt.provenance.recallBudget`
  );
  assertExactKeys(
    receipt.selection,
    ["algorithm", "version", "seed", "candidateCount", "selectedCount", "selectedTaskIds", "selectedTaskIdsSha256"],
    `${label} receipt.selection`
  );
  const { artifactHash, ...withoutHash } = receipt;
  if (!isSha256Hex(artifactHash) || hashCanonicalJson(withoutHash) !== artifactHash) {
    throw new Error(`${label} retrieval trace artifact hash verification failed.`);
  }
  if (
    receipt.schemaVersion !== 1 ||
    receipt.benchmarkId !== "locomo" ||
    receipt.captureKind !== "retrieval-only" ||
    receipt.sensitivity.classification !== "restricted" ||
    receipt.sensitivity.contentEncoding !== "sha256+length" ||
    receipt.sensitivity.containsGold !== false ||
    receipt.sensitivity.containsRawContent !== false ||
    receipt.provenance.providerFree !== true ||
    receipt.provenance.adapterMode !== "direct" ||
    receipt.provenance.replayExtractionMode !== "skip" ||
    receipt.provenance.dataset.id !== "locomo-10" ||
    receipt.provenance.recallBudget.algorithm !== "benchmarkRecallBudgetForSessionCount" ||
    receipt.provenance.recallBudget.version !== 1 ||
    typeof receipt.provenance.gitSha !== "string" ||
    receipt.provenance.gitSha.length === 0 ||
    typeof receipt.provenance.remnicVersion !== "string" ||
    receipt.provenance.remnicVersion.length === 0 ||
    receipt.selection.version !== 1 ||
    (receipt.selection.algorithm !== "explicit-task-ids" && receipt.selection.algorithm !== "sha256-seeded-sample") ||
    (receipt.selection.algorithm === "explicit-task-ids" && receipt.selection.seed !== undefined) ||
    (receipt.selection.algorithm === "sha256-seeded-sample" && !isNonNegativeSafeInteger(receipt.selection.seed)) ||
    !Array.isArray(receipt.selection.selectedTaskIds) ||
    receipt.selection.selectedTaskIds.some((taskId) => typeof taskId !== "string" || taskId.length === 0) ||
    !Array.isArray(receipt.tasks) ||
    !Number.isSafeInteger(receipt.selection.candidateCount) ||
    !Number.isSafeInteger(receipt.selection.selectedCount) ||
    receipt.selection.selectedCount <= 0 ||
    receipt.selection.candidateCount < receipt.selection.selectedCount ||
    receipt.selection.selectedCount !== receipt.tasks.length ||
    receipt.selection.selectedTaskIds.length !== receipt.tasks.length ||
    new Set(receipt.selection.selectedTaskIds).size !== receipt.selection.selectedTaskIds.length ||
    new Set(receipt.tasks.map((task) => task.taskId)).size !== receipt.tasks.length ||
    receipt.selection.selectedTaskIdsSha256 !== hashCanonicalJson(receipt.selection.selectedTaskIds) ||
    receipt.selection.selectedTaskIds.some((taskId, index) => taskId !== receipt.tasks[index]?.taskId) ||
    receipt.tasks.length === 0
  ) {
    throw new Error(`${label} retrieval trace receipt violates the restricted provider-free contract.`);
  }
  if (!isSha256Hex(receipt.provenance.dataset.sha256) || !isSha256Hex(receipt.provenance.retrievalConfigSha256)) {
    throw new Error(`${label} retrieval trace receipt contains invalid provenance hashes.`);
  }
  for (const task of receipt.tasks) {
    assertExactKeys(
      task,
      ["taskId", "question", "recallBudgetChars", "sessions", "composition"],
      `${label} retrieval trace task`
    );
    if (
      typeof task.taskId !== "string" ||
      task.taskId.length === 0 ||
      !Array.isArray(task.sessions) ||
      task.sessions.length === 0 ||
      !isDigest(task.question) ||
      !Number.isSafeInteger(task.recallBudgetChars) ||
      task.recallBudgetChars < 0
    ) {
      throw new Error(`${label} retrieval trace task structure is invalid.`);
    }
    categoryOf(task.taskId);
    assertComposition(task.composition, label);
    for (const session of task.sessions) {
      assertExactKeys(session, ["session", "trace"], `${label} retrieval trace session`);
      const trace = session.trace;
      assertExactKeys(
        trace,
        ["schemaVersion", "sensitivity", "sections", "selections", "lcmCandidates", "coreCapture", "budget"],
        `${label} retrieval structural trace`
      );
      assertExactKeys(
        trace.sensitivity,
        ["classification", "contentEncoding", "containsGold"],
        `${label} retrieval trace sensitivity`
      );
      assertExactKeys(
        trace.budget,
        ["requestedChars", "composedChars", "returnedChars", "truncated"],
        `${label} retrieval trace budget`
      );
      if (
        !isDigest(session.session) ||
        !trace ||
        trace.schemaVersion !== 1 ||
        trace.sensitivity.classification !== "restricted" ||
        trace.sensitivity.contentEncoding !== "sha256+length" ||
        trace.sensitivity.containsGold !== false ||
        !Array.isArray(trace.sections) ||
        !Array.isArray(trace.selections) ||
        !Array.isArray(trace.lcmCandidates) ||
        new Set(trace.sections.map((section) => section.id)).size !== trace.sections.length ||
        !isTraceBudget(trace.budget) ||
        trace.budget.requestedChars !== task.recallBudgetChars ||
        trace.budget.returnedChars > trace.budget.composedChars ||
        trace.budget.truncated !== trace.budget.returnedChars < trace.budget.composedChars
      ) {
        throw new Error(`${label} retrieval trace session structure is invalid.`);
      }
      for (const section of trace.sections) {
        assertExactKeys(
          section,
          [
            "id",
            "source",
            "separatorStart",
            "contentStart",
            "contentEnd",
            "composedStart",
            "composedEnd",
            "visibleStart",
            "visibleEnd",
            "visibleChars",
          ],
          `${label} retrieval trace section`
        );
        if (
          ![
            "derived",
            "explicit-cue",
            "trajectory-analysis",
            "core",
            "evidence-pack",
            "lcm-summary",
            "raw-row",
          ].includes(section.source) ||
          typeof section.id !== "string" ||
          section.id.length === 0 ||
          !isTraceRange(section) ||
          ![section.separatorStart, section.contentStart, section.contentEnd].every(isNonNegativeSafeInteger) ||
          !Number.isSafeInteger(section.visibleChars) ||
          section.visibleChars < 0
        ) {
          throw new Error(`${label} retrieval trace section structure is invalid.`);
        }
      }
      for (const selection of trace.selections) {
        assertExactKeys(
          selection,
          [
            "sectionId",
            "kind",
            "lineageStatus",
            "archiveRowIds",
            "turnIndex",
            "role",
            "score",
            "summary",
            "composedStart",
            "composedEnd",
            "visibleStart",
            "visibleEnd",
          ],
          `${label} retrieval trace selection`
        );
        if (selection.summary !== undefined) {
          assertExactKeys(
            selection.summary,
            ["depth", "msgStart", "msgEnd"],
            `${label} retrieval trace selection summary`
          );
        }
        const selectedSection = trace.sections.find((section) => section.id === selection.sectionId);
        if (
          !["evidence-block", "trajectory-line", "lcm-summary", "raw-row"].includes(selection.kind) ||
          typeof selection.sectionId !== "string" ||
          selection.sectionId.length === 0 ||
          selectedSection === undefined ||
          (selection.kind === "lcm-summary" && selectedSection.source !== "lcm-summary") ||
          (selection.kind === "raw-row" && selectedSection.source !== "raw-row") ||
          !isTraceRange(selection) ||
          (selection.lineageStatus !== "exact" && selection.lineageStatus !== "unavailable") ||
          (selection.turnIndex !== undefined && !isNonNegativeSafeInteger(selection.turnIndex)) ||
          (selection.role !== undefined && typeof selection.role !== "string") ||
          (selection.score !== undefined && !Number.isFinite(selection.score)) ||
          (selection.summary !== undefined &&
            ![selection.summary.depth, selection.summary.msgStart, selection.summary.msgEnd].every(
              isNonNegativeSafeInteger
            )) ||
          (selection.archiveRowIds !== undefined &&
            (!Array.isArray(selection.archiveRowIds) ||
              selection.archiveRowIds.some((id) => !Number.isSafeInteger(id) || id <= 0)))
        ) {
          throw new Error(`${label} retrieval trace selection structure is invalid.`);
        }
      }
      for (const candidate of trace.lcmCandidates) {
        assertExactKeys(
          candidate,
          ["rank", "archiveRowId", "turnIndex", "role", "score", "lineageStatus"],
          `${label} retrieval trace LCM candidate`
        );
        if (
          (candidate.lineageStatus !== "exact" && candidate.lineageStatus !== "unavailable") ||
          !Number.isSafeInteger(candidate.rank) ||
          candidate.rank < 0 ||
          !isNonNegativeSafeInteger(candidate.turnIndex) ||
          typeof candidate.role !== "string" ||
          (candidate.score !== undefined && !Number.isFinite(candidate.score)) ||
          (candidate.lineageStatus === "exact" && candidate.archiveRowId === undefined) ||
          (candidate.lineageStatus === "unavailable" && candidate.archiveRowId !== undefined) ||
          (candidate.archiveRowId !== undefined &&
            (!Number.isSafeInteger(candidate.archiveRowId) || candidate.archiveRowId <= 0))
        ) {
          throw new Error(`${label} retrieval trace LCM candidate structure is invalid.`);
        }
      }
      if (trace.coreCapture) {
        assertExactKeys(trace.coreCapture, ["budget", "filters", "results"], `${label} retrieval trace core capture`);
        assertExactKeys(trace.coreCapture.budget, ["chars", "used"], `${label} retrieval trace core budget`);
        for (const filter of trace.coreCapture.filters) {
          assertExactKeys(filter, ["name", "considered", "admitted"], `${label} retrieval trace core filter`);
          if (
            typeof filter.name !== "string" ||
            !isNonNegativeSafeInteger(filter.considered) ||
            !isNonNegativeSafeInteger(filter.admitted) ||
            filter.admitted > filter.considered
          ) {
            throw new Error(`${label} retrieval trace core filter structure is invalid.`);
          }
        }
        for (const result of trace.coreCapture.results) {
          assertExactKeys(
            result,
            [
              "memoryIdRef",
              "servedBy",
              "scoreDecomposition",
              "admittedBy",
              "rejectedBy",
              "disclosure",
              "estimatedTokens",
            ],
            `${label} retrieval trace core result`
          );
          assertExactKeys(result.memoryIdRef, ["sha256", "length"], `${label} retrieval trace core memory reference`);
          assertExactKeys(
            result.scoreDecomposition,
            ["vector", "bm25", "importance", "mmrPenalty", "tierPrior", "reinforcementBoost", "final"],
            `${label} retrieval trace score decomposition`
          );
          if (
            typeof result.servedBy !== "string" ||
            !Number.isFinite(result.scoreDecomposition.final) ||
            !Object.values(result.scoreDecomposition).every((score) => score === undefined || Number.isFinite(score)) ||
            !Array.isArray(result.admittedBy) ||
            result.admittedBy.some((reason) => typeof reason !== "string") ||
            (result.rejectedBy !== undefined && typeof result.rejectedBy !== "string") ||
            (result.disclosure !== undefined && !["chunk", "section", "raw"].includes(result.disclosure)) ||
            (result.estimatedTokens !== undefined && !isNonNegativeSafeInteger(result.estimatedTokens))
          ) {
            throw new Error(`${label} retrieval trace core result structure is invalid.`);
          }
        }
        if (
          !isCountBudget(trace.coreCapture.budget) ||
          !Array.isArray(trace.coreCapture.filters) ||
          !Array.isArray(trace.coreCapture.results) ||
          trace.coreCapture.results.some(
            (result) =>
              !isSha256Hex(result.memoryIdRef?.sha256) ||
              !Number.isSafeInteger(result.memoryIdRef?.length) ||
              result.memoryIdRef.length <= 0
          )
        ) {
          throw new Error(`${label} retrieval trace core capture structure is invalid.`);
        }
      }
    }
  }
}

function assertComposition(composition: LoCoMoRetrievalTaskReceipt["composition"], label: string): void {
  assertExactKeys(
    composition,
    ["schemaVersion", "mode", "multiHopRecallComposition", "input", "output", "selectedLines"],
    `${label} retrieval trace composition`
  );
  if (
    !composition ||
    composition.schemaVersion !== 1 ||
    (composition.mode !== "focused" && composition.mode !== "fallback") ||
    typeof composition.multiHopRecallComposition !== "boolean" ||
    !isDigest(composition.input) ||
    !isDigest(composition.output) ||
    !Array.isArray(composition.selectedLines)
  ) {
    throw new Error(`${label} retrieval trace composition structure is invalid.`);
  }
  for (const line of composition.selectedLines) {
    assertExactKeys(
      line,
      [
        "inputOrdinal",
        "input",
        "output",
        "stage",
        "hop",
        "visible",
        "outputStart",
        "outputEnd",
        "visibleStart",
        "visibleEnd",
      ],
      `${label} retrieval trace composition line`
    );
    if (
      !isNonNegativeSafeInteger(line.inputOrdinal) ||
      !isDigest(line.input) ||
      !isDigest(line.output) ||
      (line.stage !== "direct" && line.stage !== "linked") ||
      (line.hop !== undefined && !isNonNegativeSafeInteger(line.hop)) ||
      typeof line.visible !== "boolean" ||
      ![line.outputStart, line.outputEnd, line.visibleStart, line.visibleEnd].every(isNonNegativeSafeInteger)
    ) {
      throw new Error(`${label} retrieval trace composition line structure is invalid.`);
    }
  }
}

function assertExactKeys(value: unknown, allowed: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error(`${label} contains an unsupported field.`);
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTraceRange(value: {
  composedStart?: unknown;
  composedEnd?: unknown;
  visibleStart?: unknown;
  visibleEnd?: unknown;
}): boolean {
  return [value.composedStart, value.composedEnd, value.visibleStart, value.visibleEnd].every(isNonNegativeSafeInteger);
}

function isTraceBudget(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const budget = value as {
    requestedChars?: unknown;
    composedChars?: unknown;
    returnedChars?: unknown;
    truncated?: unknown;
  };
  return (
    [budget.requestedChars, budget.composedChars, budget.returnedChars].every(
      (entry) => Number.isSafeInteger(entry) && (entry as number) >= 0
    ) && typeof budget.truncated === "boolean"
  );
}

function isCountBudget(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const budget = value as { chars?: unknown; used?: unknown };
  return [budget.chars, budget.used].every((entry) => Number.isSafeInteger(entry) && (entry as number) >= 0);
}

function assertFiniteJson(value: unknown, label: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertFiniteJson(entry, `${label}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") throw new Error(`${label} is not canonical JSON.`);
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) throw new Error(`${label}.${key} is undefined.`);
    assertFiniteJson(entry, `${label}.${key}`);
  }
}

function assertComparable(baseline: LoCoMoRetrievalTraceReceipt, real: LoCoMoRetrievalTraceReceipt): void {
  if (baseline.provenance.runtimeProfile !== "baseline" || real.provenance.runtimeProfile !== "real") {
    throw new Error("Paired retrieval traces require baseline and real runtime profiles in that order.");
  }
  const matching = [
    [baseline.schemaVersion, real.schemaVersion],
    [baseline.benchmarkId, real.benchmarkId],
    [baseline.provenance.gitSha, real.provenance.gitSha],
    [baseline.provenance.remnicVersion, real.provenance.remnicVersion],
    [baseline.provenance.dataset.sha256, real.provenance.dataset.sha256],
    [baseline.provenance.recallBudget.version, real.provenance.recallBudget.version],
    [baseline.selection.selectedTaskIdsSha256, real.selection.selectedTaskIdsSha256],
    [canonicalJsonStringify(baseline.selection), canonicalJsonStringify(real.selection)],
    [baseline.tasks.length, real.tasks.length],
  ];
  if (matching.some(([left, right]) => left !== right))
    throw new Error("Paired retrieval trace provenance does not match.");
  if (baseline.provenance.retrievalConfigSha256 === real.provenance.retrievalConfigSha256) {
    throw new Error("Paired retrieval traces must use different baseline and real retrieval configuration hashes.");
  }
  baseline.tasks.forEach((left, index) => {
    const right = real.tasks[index];
    if (
      !right ||
      left.taskId !== right.taskId ||
      canonicalJsonStringify(left.question) !== canonicalJsonStringify(right.question) ||
      left.recallBudgetChars !== right.recallBudgetChars ||
      left.sessions.length !== right.sessions.length ||
      left.composition.multiHopRecallComposition !== right.composition.multiHopRecallComposition
    ) {
      throw new Error(`Paired retrieval trace task mismatch at index ${index}.`);
    }
    left.sessions.forEach((session, sessionIndex) => {
      const other = right.sessions[sessionIndex];
      if (!other || canonicalJsonStringify(session.session) !== canonicalJsonStringify(other.session)) {
        throw new Error(`Paired retrieval trace session mismatch at task ${index}, session ${sessionIndex}.`);
      }
      if (session.trace.budget.requestedChars !== other.trace.budget.requestedChars) {
        throw new Error(`Paired retrieval trace budget mismatch at task ${index}, session ${sessionIndex}.`);
      }
    });
  });
}

function isDigest(value: unknown): value is { sha256: string; charCount: number; lineCount: number } {
  if (!value || typeof value !== "object") return false;
  if (Object.keys(value).some((key) => !["sha256", "charCount", "lineCount"].includes(key))) return false;
  const digest = value as { sha256?: unknown; charCount?: unknown; lineCount?: unknown };
  return (
    isSha256Hex(digest.sha256) &&
    Number.isSafeInteger(digest.charCount) &&
    (digest.charCount as number) >= 0 &&
    Number.isSafeInteger(digest.lineCount) &&
    (digest.lineCount as number) >= 0
  );
}
