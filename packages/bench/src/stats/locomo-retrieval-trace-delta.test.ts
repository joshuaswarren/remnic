import assert from "node:assert/strict";
import test from "node:test";

import { createBenchRecallTraceRecorder } from "../adapters/remnic-recall-trace.js";
import type {
  LoCoMoRetrievalTaskReceipt,
  LoCoMoRetrievalTraceReceipt,
} from "../benchmarks/published/locomo/retrieval-trace-runner.js";
import { prioritizeLoCoMoRecallTextWithTrace } from "../benchmarks/published/locomo/runner.js";
import { hashCanonicalJson, hashString } from "../integrity/hash-verification.js";
import {
  diagnoseLoCoMoRetrievalTraceDelta,
  serializeLoCoMoRetrievalTraceDelta,
} from "./locomo-retrieval-trace-delta.js";

const DATASET_HASH = hashString("dataset");

function digest(value: string) {
  return { sha256: hashString(value), charCount: value.length, lineCount: 1 };
}

function task(
  id: string,
  options: {
    sectionCopies?: number;
    sectionChars?: number;
    coreChars?: number;
    coreScore?: number;
    compositionMode?: "focused" | "fallback";
    lineageStatus?: "exact" | "unavailable";
  } = {}
): LoCoMoRetrievalTaskReceipt {
  const sectionCopies = options.sectionCopies ?? 1;
  const sectionChars = options.sectionChars ?? 20;
  const coreScore = options.coreScore ?? 1;
  const coreChars = options.coreChars ?? 0;
  const lineageStatus = options.lineageStatus ?? "exact";
  const sections: LoCoMoRetrievalTaskReceipt["sessions"][number]["trace"]["sections"] = [];
  const selections: LoCoMoRetrievalTaskReceipt["sessions"][number]["trace"]["selections"] = [];
  let composedChars = 0;
  for (let index = 0; index < sectionCopies; index += 1) {
    const separatorStart = composedChars;
    const contentStart = separatorStart + (sections.length === 0 ? 0 : 2);
    const contentEnd = contentStart + sectionChars;
    sections.push({
      id: `section-${index}`,
      source: "lcm-summary",
      separatorStart,
      contentStart,
      contentEnd,
      composedStart: separatorStart,
      composedEnd: contentEnd,
      visibleStart: separatorStart,
      visibleEnd: contentEnd,
      visibleChars: contentEnd - separatorStart,
    });
    selections.push({
      sectionId: `section-${index}`,
      kind: "lcm-summary",
      lineageStatus,
      ...(lineageStatus === "exact" ? { archiveRowIds: [7 + index] } : {}),
      summary: { depth: 1, msgStart: index, msgEnd: index + 1 },
      composedStart: contentStart,
      composedEnd: contentEnd,
      visibleStart: contentStart,
      visibleEnd: contentEnd,
    });
    composedChars = contentEnd;
  }
  if (coreChars > 0) {
    const separatorStart = composedChars;
    const contentStart = separatorStart + (sections.length === 0 ? 0 : 2);
    const contentEnd = contentStart + coreChars;
    sections.push({
      id: "core-section",
      source: "core",
      separatorStart,
      contentStart,
      contentEnd,
      composedStart: separatorStart,
      composedEnd: contentEnd,
      visibleStart: separatorStart,
      visibleEnd: contentEnd,
      visibleChars: contentEnd - separatorStart,
    });
    composedChars = contentEnd;
  }
  const returnedChars = composedChars;
  return {
    taskId: id,
    question: digest(`question:${id}`),
    recallBudgetChars: 100,
    sessions: [
      {
        session: digest(`session:${id}`),
        trace: {
          schemaVersion: 1,
          sensitivity: { classification: "restricted", contentEncoding: "sha256+length", containsGold: false },
          sections,
          selections,
          lcmCandidates: [
            {
              rank: 0,
              ...(lineageStatus === "exact" ? { archiveRowId: 7 } : {}),
              turnIndex: 2,
              role: "user",
              score: sectionChars,
              lineageStatus,
            },
          ],
          coreCapture: {
            budget: { chars: 100, used: 10 },
            filters: [{ name: "admission", considered: 1, admitted: 1 }],
            results: [
              {
                memoryIdRef: { sha256: hashString("private-core-memory-id"), length: 22 },
                servedBy: "hot",
                scoreDecomposition: { final: coreScore },
                admittedBy: ["budget"],
              },
            ],
          },
          budget: {
            requestedChars: 100,
            composedChars,
            returnedChars,
            truncated: false,
          },
        },
      },
    ],
    composition: {
      schemaVersion: 1,
      mode: options.compositionMode ?? "focused",
      multiHopRecallComposition: true,
      input: digest("composition-input"),
      output: digest(options.compositionMode ?? "focused"),
      selectedLines: [],
    },
  };
}

function receipt(
  profile: "baseline" | "real",
  tasks: LoCoMoRetrievalTaskReceipt[],
  config = profile
): LoCoMoRetrievalTraceReceipt {
  const selectedTaskIds = tasks.map((entry) => entry.taskId);
  const withoutHash = {
    schemaVersion: 1 as const,
    benchmarkId: "locomo" as const,
    captureKind: "retrieval-only" as const,
    sensitivity: {
      classification: "restricted" as const,
      contentEncoding: "sha256+length" as const,
      containsGold: false as const,
      containsRawContent: false as const,
    },
    provenance: {
      gitSha: "abc123",
      remnicVersion: "9.6.32",
      runtimeProfile: profile,
      adapterMode: "direct" as const,
      replayExtractionMode: "skip" as const,
      providerFree: true as const,
      dataset: { id: "locomo-10" as const, sha256: DATASET_HASH },
      retrievalConfigSha256: hashString(config),
      recallBudget: { algorithm: "benchmarkRecallBudgetForSessionCount" as const, version: 1 as const },
    },
    selection: {
      algorithm: "explicit-task-ids" as const,
      version: 1 as const,
      candidateCount: tasks.length,
      selectedCount: tasks.length,
      selectedTaskIds,
      selectedTaskIdsSha256: hashCanonicalJson(selectedTaskIds),
    },
    tasks,
  };
  return { ...withoutHash, artifactHash: hashCanonicalJson(withoutHash) };
}

function reseal(value: LoCoMoRetrievalTraceReceipt): LoCoMoRetrievalTraceReceipt {
  const { artifactHash: _artifactHash, ...withoutHash } = value;
  return { ...withoutHash, artifactHash: hashCanonicalJson(withoutHash) };
}

function recorderTask(id: string, sectionChars: number): LoCoMoRetrievalTaskReceipt {
  const requestedChars = 20;
  const taskReceipt = task(id);
  const recorder = createBenchRecallTraceRecorder(requestedChars);
  recorder.appendSection("section-0", "lcm-summary", sectionChars);
  recorder.recordSummarySelections("section-0", [
    { id: "summary-0", depth: 1, msgStart: 0, msgEnd: 1, entryStart: 0, entryEnd: 10 },
  ]);
  recorder.recordLcmCandidate({
    rank: 0,
    archiveRowId: 7,
    turnIndex: 2,
    role: "user",
    score: 0.5,
    lineageStatus: "exact",
  });
  const trace = recorder.finalize(Math.min(requestedChars, sectionChars));
  const coreCapture = taskReceipt.sessions[0]?.trace.coreCapture;
  const session = taskReceipt.sessions[0];
  assert.ok(session);
  session.trace = {
    ...trace,
    selections: trace.selections.map(({ summary, ...selection }) => ({
      ...selection,
      ...(summary === undefined
        ? {}
        : { summary: { depth: summary.depth, msgStart: summary.msgStart, msgEnd: summary.msgEnd } }),
    })),
    ...(coreCapture === undefined ? {} : { coreCapture }),
  };
  taskReceipt.recallBudgetChars = requestedChars;
  taskReceipt.composition.input = digest(`recall-prefix-${Math.min(requestedChars, sectionChars)}`);
  taskReceipt.composition.output = digest("stable composition output");
  return taskReceipt;
}

test("pairs deterministic receipts and reports core-visible LCM displacement without raw identifiers", () => {
  const ids = ["private-alpha-q0-multi_hop", "private-alpha-q1-multi_hop", "private-alpha-q2-multi_hop"];
  const baseline = receipt(
    "baseline",
    ids.map((id) => task(id))
  );
  const real = receipt(
    "real",
    ids.map((id) => task(id, { sectionChars: 19, coreChars: 10, coreScore: 0.5 }))
  );
  const first = diagnoseLoCoMoRetrievalTraceDelta(baseline, real);
  const second = diagnoseLoCoMoRetrievalTraceDelta(baseline, real);

  assert.deepEqual(first, second);
  assert.equal(first.overall.mechanisms["real-core-visible-lcm-displacement"], 3);
  assert.deepEqual(first.dominantMultiHopMechanism, {
    status: "supported",
    mechanism: "real-core-visible-lcm-displacement",
    count: 3,
    taskCount: 3,
    rule: "strict-majority-and-at-least-two",
  });
  const serialized = serializeLoCoMoRetrievalTraceDelta(first);
  assert.equal(serialized.includes("private-alpha"), false);
  assert.equal(serialized.includes("private-core-memory-id"), false);
  assert.doesNotMatch(serialized, /"(?:taskId|sessionId|memoryId|archiveRowId|path|excerpt|timestamp)"/u);
  const { artifactHash, ...withoutHash } = first;
  assert.equal(artifactHash, hashCanonicalJson(withoutHash));
});

test("uses true multiset subtraction and labels composition and budget changes", () => {
  const baselineTasks = [
    task("fixture-q0-single_hop", { sectionCopies: 2 }),
    task("fixture-q1-temporal"),
    recorderTask("fixture-q2-adversarial", 15),
  ];
  const realTasks = [
    task("fixture-q0-single_hop", { sectionCopies: 1 }),
    task("fixture-q1-temporal", { compositionMode: "fallback" }),
    recorderTask("fixture-q2-adversarial", 25),
  ];
  const report = diagnoseLoCoMoRetrievalTraceDelta(receipt("baseline", baselineTasks), receipt("real", realTasks));

  assert.deepEqual(report.tasks[0]?.dimensions.sectionVisibleChars, {
    baselineCount: 2,
    realCount: 1,
    sharedCount: 1,
    baselineOnlyCount: 1,
    realOnlyCount: 0,
    changed: true,
  });
  assert.equal(report.tasks[0]?.mechanism, "lcm-selection-change");
  assert.equal(report.tasks[1]?.mechanism, "composition-filter-displacement");
  assert.equal(report.tasks[1]?.dimensions.compositionPolicy.changed, true);
  assert.equal(report.tasks[1]?.dimensions.compositionDigests.changed, true);
  assert.equal(report.tasks[2]?.mechanism, "budget-truncation-change");
});

test("preserves equal-total section source and layout changes as structural signals", () => {
  const sourceBaseline = task("fixture-q0-single_hop", { sectionChars: 10 });
  const sourceReal = task("fixture-q0-single_hop", { sectionChars: 10 });
  const baselineSection = sourceBaseline.sessions[0]?.trace.sections[0];
  const realSection = sourceReal.sessions[0]?.trace.sections[0];
  assert.ok(baselineSection);
  assert.ok(realSection);
  baselineSection.source = "explicit-cue";
  realSection.source = "evidence-pack";
  for (const entry of [sourceBaseline, sourceReal]) {
    const selection = entry.sessions[0]?.trace.selections[0];
    assert.ok(selection);
    selection.kind = "evidence-block";
    delete selection.summary;
  }
  const sourceDelta = diagnoseLoCoMoRetrievalTraceDelta(
    receipt("baseline", [sourceBaseline]),
    receipt("real", [sourceReal])
  ).tasks[0];
  assert.equal(sourceDelta?.dimensions.sectionVisibleChars.changed, true);
  assert.equal(sourceDelta?.mechanism, "mixed");

  const layoutDelta = diagnoseLoCoMoRetrievalTraceDelta(
    receipt("baseline", [task("fixture-q1-multi_hop", { sectionCopies: 2, sectionChars: 5 })]),
    receipt("real", [task("fixture-q1-multi_hop", { sectionCopies: 1, sectionChars: 10 })])
  ).tasks[0];
  assert.equal(layoutDelta?.dimensions.sectionVisibleChars.changed, true);
  assert.equal(layoutDelta?.mechanism, "lcm-selection-change");
});

test("preserves equal-length section identity and ordering changes", () => {
  const reorderedId = "fixture-q0-multi_hop";
  const reorderedBaseline = task(reorderedId, { sectionCopies: 2 });
  const reorderedReal = task(reorderedId, { sectionCopies: 2 });
  const reorderedTrace = reorderedReal.sessions[0]?.trace;
  assert.ok(reorderedTrace?.sections[0]);
  assert.ok(reorderedTrace.sections[1]);
  assert.ok(reorderedTrace.selections[0]);
  assert.ok(reorderedTrace.selections[1]);
  [reorderedTrace.sections[0].id, reorderedTrace.sections[1].id] = [
    reorderedTrace.sections[1].id,
    reorderedTrace.sections[0].id,
  ];
  [reorderedTrace.selections[0].sectionId, reorderedTrace.selections[1].sectionId] = [
    reorderedTrace.selections[1].sectionId,
    reorderedTrace.selections[0].sectionId,
  ];
  const reorderedDelta = diagnoseLoCoMoRetrievalTraceDelta(
    receipt("baseline", [reorderedBaseline]),
    receipt("real", [reorderedReal])
  ).tasks[0];
  assert.equal(reorderedDelta?.dimensions.sectionVisibleChars.changed, true);
  assert.equal(reorderedDelta?.dimensions.selections.changed, true);
  assert.equal(reorderedDelta?.mechanism, "lcm-selection-change");

  const replacedId = "fixture-q1-multi_hop";
  const replacedBaseline = task(replacedId);
  const replacedReal = task(replacedId);
  const replacedTrace = replacedReal.sessions[0]?.trace;
  const replacedSection = replacedTrace?.sections[0];
  const replacedSelection = replacedTrace?.selections[0];
  assert.ok(replacedSection);
  assert.ok(replacedSelection);
  replacedSection.id = "replacement-section";
  replacedSelection.sectionId = "replacement-section";
  const replacedDelta = diagnoseLoCoMoRetrievalTraceDelta(
    receipt("baseline", [replacedBaseline]),
    receipt("real", [replacedReal])
  ).tasks[0];
  assert.equal(replacedDelta?.dimensions.sectionVisibleChars.changed, true);
  assert.equal(replacedDelta?.dimensions.selections.changed, true);
  assert.equal(replacedDelta?.mechanism, "lcm-selection-change");
});

test("binds selection lineage to its section identity", () => {
  const id = "fixture-q0-multi_hop";
  const baselineTask = task(id, { sectionCopies: 2 });
  const realTask = task(id, { sectionCopies: 2 });
  const realSelections = realTask.sessions[0]?.trace.selections;
  assert.ok(realSelections?.[0]);
  assert.ok(realSelections[1]);
  [realSelections[0].sectionId, realSelections[1].sectionId] = [
    realSelections[1].sectionId,
    realSelections[0].sectionId,
  ];

  assert.throws(
    () => diagnoseLoCoMoRetrievalTraceDelta(receipt("baseline", [baselineTask]), receipt("real", [realTask])),
    /selection structure is invalid/
  );
});

test("binds summary and raw-row lineage identities to rendered positions", () => {
  const summaryId = "fixture-q0-multi_hop";
  const summaryBaseline = task(summaryId, { sectionCopies: 2 });
  const summaryReal = task(summaryId, { sectionCopies: 2 });
  const summarySelections = summaryReal.sessions[0]?.trace.selections;
  assert.ok(summarySelections?.[0]?.summary);
  assert.ok(summarySelections[1]?.summary);
  [summarySelections[0].summary, summarySelections[1].summary] = [
    summarySelections[1].summary,
    summarySelections[0].summary,
  ];
  const summaryDelta = diagnoseLoCoMoRetrievalTraceDelta(
    receipt("baseline", [summaryBaseline]),
    receipt("real", [summaryReal])
  ).tasks[0];
  assert.equal(summaryDelta?.dimensions.sectionVisibleChars.changed, false);
  assert.equal(summaryDelta?.dimensions.selections.changed, true);
  assert.equal(summaryDelta?.mechanism, "lcm-selection-change");

  const rawRowId = "fixture-q1-multi_hop";
  const rawRowBaseline = task(rawRowId, { sectionCopies: 2 });
  const rawRowReal = task(rawRowId, { sectionCopies: 2 });
  for (const entry of [rawRowBaseline, rawRowReal]) {
    const trace = entry.sessions[0]?.trace;
    assert.ok(trace);
    trace.sections.forEach((section) => {
      section.source = "raw-row";
    });
    trace.selections = trace.selections.map((selection) => {
      const { summary: _summary, ...rawRowSelection } = selection;
      return { ...rawRowSelection, kind: "raw-row" };
    });
  }
  const rawSelections = rawRowReal.sessions[0]?.trace.selections;
  assert.ok(rawSelections?.[0]?.archiveRowIds);
  assert.ok(rawSelections[1]?.archiveRowIds);
  [rawSelections[0].archiveRowIds, rawSelections[1].archiveRowIds] = [
    rawSelections[1].archiveRowIds,
    rawSelections[0].archiveRowIds,
  ];
  const rawRowDelta = diagnoseLoCoMoRetrievalTraceDelta(
    receipt("baseline", [rawRowBaseline]),
    receipt("real", [rawRowReal])
  ).tasks[0];
  assert.equal(rawRowDelta?.dimensions.sectionVisibleChars.changed, false);
  assert.equal(rawRowDelta?.dimensions.archiveRows.changed, false);
  assert.equal(rawRowDelta?.dimensions.selections.changed, true);
  assert.equal(rawRowDelta?.mechanism, "lcm-selection-change");
});

test("attributes upstream displacement before downstream composition digest drift", () => {
  const id = "fixture-q0-multi_hop";
  const baselineTask = task(id);
  const realTask = task(id, { sectionChars: 19, coreChars: 10, coreScore: 0.5 });
  baselineTask.composition = prioritizeLoCoMoRecallTextWithTrace({
    question: "Where does Alice live?",
    recalledText: "Alice lives in Rome.",
    multiHopRecallComposition: true,
  }).receipt;
  realTask.composition = prioritizeLoCoMoRecallTextWithTrace({
    question: "Where does Alice live?",
    recalledText: "Alice lives in Lima.",
    multiHopRecallComposition: true,
  }).receipt;

  const delta = diagnoseLoCoMoRetrievalTraceDelta(receipt("baseline", [baselineTask]), receipt("real", [realTask]))
    .tasks[0];
  assert.equal(delta?.dimensions.compositionPolicy.changed, false);
  assert.equal(delta?.dimensions.compositionDigests.changed, true);
  assert.equal(delta?.mechanism, "real-core-visible-lcm-displacement");
});

test("does not claim core-visible LCM displacement across composition policy changes", () => {
  const id = "fixture-q0-multi_hop";
  const baselineTask = task(id);
  const realTask = task(id, {
    sectionChars: 19,
    coreChars: 10,
    coreScore: 0.5,
    compositionMode: "fallback",
  });
  realTask.composition.output = baselineTask.composition.output;

  const delta = diagnoseLoCoMoRetrievalTraceDelta(receipt("baseline", [baselineTask]), receipt("real", [realTask]))
    .tasks[0];
  assert.equal(delta?.dimensions.compositionPolicy.changed, true);
  assert.equal(delta?.dimensions.compositionDigests.changed, false);
  assert.equal(delta?.mechanism, "mixed");
});

test("does not claim LCM selection change across composition policy changes", () => {
  const id = "fixture-q0-multi_hop";
  const baselineTask = task(id);
  const realTask = task(id, { sectionChars: 19, compositionMode: "fallback" });
  realTask.composition.output = baselineTask.composition.output;

  const delta = diagnoseLoCoMoRetrievalTraceDelta(receipt("baseline", [baselineTask]), receipt("real", [realTask]))
    .tasks[0];
  assert.equal(delta?.dimensions.sectionVisibleChars.changed, true);
  assert.equal(delta?.dimensions.compositionPolicy.changed, true);
  assert.equal(delta?.dimensions.compositionDigests.changed, false);
  assert.equal(delta?.mechanism, "mixed");
});

test("does not classify rendered character counts as recall-budget changes", () => {
  const id = "fixture-q0-multi_hop";
  const baselineTask = task(id);
  const realTask = task(id, { sectionChars: 19, coreChars: 10, coreScore: 0.5 });

  const delta = diagnoseLoCoMoRetrievalTraceDelta(receipt("baseline", [baselineTask]), receipt("real", [realTask]))
    .tasks[0];
  assert.equal(delta?.dimensions.recallBudget.changed, false);
  assert.equal(delta?.mechanism, "real-core-visible-lcm-displacement");
});

test("reports recorder-built fixed-budget tail-geometry transitions", () => {
  const baselineTask = recorderTask("fixture-q0-multi_hop", 15);
  const realTask = recorderTask("fixture-q0-multi_hop", 25);

  const delta = diagnoseLoCoMoRetrievalTraceDelta(receipt("baseline", [baselineTask]), receipt("real", [realTask]))
    .tasks[0];
  assert.equal(delta?.dimensions.recallBudget.changed, true);
  assert.equal(delta?.dimensions.sectionVisibleChars.changed, true);
  assert.equal(delta?.dimensions.selections.changed, false);
  assert.equal(delta?.dimensions.compositionDigests.changed, true);
  assert.equal(delta?.dimensions.compositionPolicy.changed, false);
  assert.equal(delta?.mechanism, "budget-truncation-change");

  const reverse = diagnoseLoCoMoRetrievalTraceDelta(
    receipt("baseline", [recorderTask("fixture-q1-multi_hop", 25)]),
    receipt("real", [recorderTask("fixture-q1-multi_hop", 15)])
  ).tasks[0];
  assert.equal(reverse?.mechanism, "budget-truncation-change");
});

test("keeps policy and pre-truncation retrieval changes out of budget tail attribution", () => {
  const cases: Array<{
    name: string;
    mutate: (baselineTask: LoCoMoRetrievalTaskReceipt, realTask: LoCoMoRetrievalTaskReceipt) => void;
  }> = [
    {
      name: "composition policy",
      mutate: (_baselineTask, realTask) => {
        realTask.composition.mode = "fallback";
      },
    },
    {
      name: "composed section layout",
      mutate: (baselineTask, realTask) => {
        for (const entry of [baselineTask, realTask]) {
          const trace = entry.sessions[0]?.trace;
          assert.ok(trace);
          const separatorStart = trace.budget.composedChars;
          const contentStart = separatorStart + 2;
          trace.sections.push({
            id: "derived-tail",
            source: "derived",
            separatorStart,
            contentStart,
            contentEnd: contentStart,
            composedStart: separatorStart,
            composedEnd: contentStart,
            visibleStart: Math.min(separatorStart, trace.budget.requestedChars),
            visibleEnd: Math.min(contentStart, trace.budget.requestedChars),
            visibleChars:
              Math.min(contentStart, trace.budget.requestedChars) -
              Math.min(separatorStart, trace.budget.requestedChars),
          });
          trace.budget.composedChars = contentStart;
          trace.budget.returnedChars = Math.min(trace.budget.requestedChars, contentStart);
          trace.budget.truncated = trace.budget.returnedChars < contentStart;
        }
      },
    },
    {
      name: "selection lineage",
      mutate: (_baselineTask, realTask) => {
        const summary = realTask.sessions[0]?.trace.selections[0]?.summary;
        assert.ok(summary);
        summary.msgEnd += 1;
      },
    },
    {
      name: "candidate identity",
      mutate: (_baselineTask, realTask) => {
        const candidate = realTask.sessions[0]?.trace.lcmCandidates[0];
        assert.ok(candidate);
        candidate.archiveRowId = 8;
      },
    },
    {
      name: "unavailable candidate structure",
      mutate: (baselineTask, realTask) => {
        for (const entry of [baselineTask, realTask]) {
          const trace = entry.sessions[0]?.trace;
          const candidate = trace?.lcmCandidates[0];
          assert.ok(trace);
          assert.ok(candidate);
          const { archiveRowId: _archiveRowId, ...withoutArchiveRowId } = candidate;
          trace.lcmCandidates[0] = { ...withoutArchiveRowId, lineageStatus: "unavailable" };
        }
        const realCandidate = realTask.sessions[0]?.trace.lcmCandidates[0];
        assert.ok(realCandidate);
        realCandidate.role = "assistant";
      },
    },
    {
      name: "composition output",
      mutate: (_baselineTask, realTask) => {
        realTask.composition.output = digest("different composition output");
      },
    },
    {
      name: "composition selected-line digest",
      mutate: (baselineTask, realTask) => {
        const composition = prioritizeLoCoMoRecallTextWithTrace({
          question: "Where does Alice live and work?",
          recalledText: "Alice lives in Rome.\nAlice works at Acme.",
          multiHopRecallComposition: true,
        }).receipt;
        baselineTask.composition = structuredClone(composition);
        realTask.composition = structuredClone(composition);
        const selectedLine = realTask.composition.selectedLines[0];
        assert.ok(selectedLine);
        selectedLine.output = digest("Alice lives in Lima.");
      },
    },
    {
      name: "composition selected-line geometry",
      mutate: (baselineTask, realTask) => {
        const composition = prioritizeLoCoMoRecallTextWithTrace({
          question: "Where does Alice live and work?",
          recalledText: "Alice lives in Rome.\nAlice works at Acme.",
          multiHopRecallComposition: true,
        }).receipt;
        baselineTask.composition = structuredClone(composition);
        realTask.composition = structuredClone(composition);
        const selectedLine = realTask.composition.selectedLines[0];
        assert.ok(selectedLine);
        selectedLine.outputStart += 1;
        selectedLine.outputEnd += 1;
        selectedLine.visibleStart += 1;
        selectedLine.visibleEnd += 1;
      },
    },
  ];

  for (const testCase of cases) {
    const baselineTask = recorderTask(`fixture-${testCase.name}-q0-multi_hop`, 15);
    const realTask = recorderTask(`fixture-${testCase.name}-q0-multi_hop`, 25);
    testCase.mutate(baselineTask, realTask);
    const delta = diagnoseLoCoMoRetrievalTraceDelta(receipt("baseline", [baselineTask]), receipt("real", [realTask]))
      .tasks[0];
    assert.equal(delta?.mechanism, "mixed", testCase.name);
  }
});

test("keeps core and auxiliary changes out of budget tail attribution", () => {
  const cases: Array<{
    name: string;
    mutate: (realTask: LoCoMoRetrievalTaskReceipt) => void;
  }> = [
    {
      name: "core result",
      mutate: (realTask) => {
        const result = realTask.sessions[0]?.trace.coreCapture?.results[0];
        assert.ok(result);
        result.scoreDecomposition.final = 0.5;
      },
    },
    {
      name: "core filter",
      mutate: (realTask) => {
        const filter = realTask.sessions[0]?.trace.coreCapture?.filters[0];
        assert.ok(filter);
        filter.admitted = 0;
      },
    },
    {
      name: "core allocation",
      mutate: (realTask) => {
        const budget = realTask.sessions[0]?.trace.coreCapture?.budget;
        assert.ok(budget);
        budget.used += 1;
      },
    },
    {
      name: "auxiliary structure",
      mutate: (realTask) => {
        const trace = realTask.sessions[0]?.trace;
        assert.ok(trace);
        trace.sections.push({
          id: "evidence-section",
          source: "evidence-pack",
          separatorStart: 25,
          contentStart: 27,
          contentEnd: 35,
          composedStart: 25,
          composedEnd: 35,
          visibleStart: 20,
          visibleEnd: 20,
          visibleChars: 0,
        });
        trace.budget.composedChars = 35;
      },
    },
  ];

  for (const testCase of cases) {
    const baselineTask = recorderTask(`fixture-${testCase.name}-q0-multi_hop`, 15);
    const realTask = recorderTask(`fixture-${testCase.name}-q0-multi_hop`, 25);
    testCase.mutate(realTask);
    const delta = diagnoseLoCoMoRetrievalTraceDelta(receipt("baseline", [baselineTask]), receipt("real", [realTask]))
      .tasks[0];
    assert.equal(delta?.mechanism, "mixed", testCase.name);
  }
});

test("labels composition-digest-only changes without claiming no structural delta", () => {
  const id = "fixture-q0-multi_hop";
  const baselineTask = task(id);
  const realTask = task(id);
  realTask.composition.output = digest("different composition output");

  const delta = diagnoseLoCoMoRetrievalTraceDelta(receipt("baseline", [baselineTask]), receipt("real", [realTask]))
    .tasks[0];
  assert.equal(delta?.dimensions.compositionDigests.changed, true);
  assert.equal(delta?.mechanism, "composition-digest-change");
});

test("accepts exact compressed-summary lineage without archive row ids", () => {
  const id = "fixture-q0-multi_hop";
  const baselineTask = task(id);
  const realTask = task(id);
  for (const entry of [baselineTask, realTask]) {
    const trace = entry.sessions[0]?.trace;
    const selection = trace?.selections[0];
    assert.ok(trace);
    assert.ok(selection);
    delete selection.archiveRowIds;
    if (selection.summary) selection.summary.msgEnd = selection.summary.msgStart;
    trace.lcmCandidates = [];
  }

  const delta = diagnoseLoCoMoRetrievalTraceDelta(receipt("baseline", [baselineTask]), receipt("real", [realTask]))
    .tasks[0];
  assert.equal(delta?.mechanism, "no-structural-delta");
});

test("treats LCM-free tasks and exact raw-row fallback as complete lineage", () => {
  const coreOnlyId = "fixture-q0-multi_hop";
  const coreOnlyBaseline = task(coreOnlyId, { sectionCopies: 0, coreChars: 10 });
  const coreOnlyReal = task(coreOnlyId, { sectionCopies: 0, coreChars: 10 });
  for (const entry of [coreOnlyBaseline, coreOnlyReal]) {
    const trace = entry.sessions[0]?.trace;
    assert.ok(trace);
    trace.selections = [];
    trace.lcmCandidates = [];
  }
  assert.equal(
    diagnoseLoCoMoRetrievalTraceDelta(receipt("baseline", [coreOnlyBaseline]), receipt("real", [coreOnlyReal])).tasks[0]
      ?.mechanism,
    "no-structural-delta"
  );

  const rawRowId = "fixture-q1-multi_hop";
  const rawRowBaseline = task(rawRowId);
  const rawRowReal = task(rawRowId);
  for (const entry of [rawRowBaseline, rawRowReal]) {
    const trace = entry.sessions[0]?.trace;
    const section = trace?.sections[0];
    const selection = trace?.selections[0];
    assert.ok(trace);
    assert.ok(section);
    assert.ok(selection);
    section.source = "raw-row";
    const { summary: _summary, ...rawRowSelection } = selection;
    trace.selections[0] = { ...rawRowSelection, kind: "raw-row" };
    trace.lcmCandidates = [];
  }
  assert.equal(
    diagnoseLoCoMoRetrievalTraceDelta(receipt("baseline", [rawRowBaseline]), receipt("real", [rawRowReal])).tasks[0]
      ?.mechanism,
    "no-structural-delta"
  );
});

test("ignores unavailable candidates when rendered LCM lineage is exact", () => {
  const id = "fixture-q0-multi_hop";
  const baselineTask = task(id);
  const realTask = task(id);
  const baselineCandidate = baselineTask.sessions[0]?.trace.lcmCandidates[0];
  const baselineTrace = baselineTask.sessions[0]?.trace;
  const realTrace = realTask.sessions[0]?.trace;
  assert.ok(baselineCandidate);
  assert.ok(baselineTrace);
  assert.ok(realTrace);
  const { archiveRowId: _baselineArchiveRowId, ...baselineCandidateWithoutRow } = baselineCandidate;
  baselineTrace.lcmCandidates[0] = { ...baselineCandidateWithoutRow, lineageStatus: "unavailable" };
  realTrace.lcmCandidates = [];

  const delta = diagnoseLoCoMoRetrievalTraceDelta(receipt("baseline", [baselineTask]), receipt("real", [realTask]))
    .tasks[0];
  assert.equal(delta?.dimensions.lcmCandidates.changed, false);
  assert.equal(delta?.mechanism, "no-structural-delta");

  const candidateOnly = task(id, { sectionCopies: 0 });
  const candidateOnlyTrace = candidateOnly.sessions[0]?.trace;
  const candidateOnlyCandidate = candidateOnlyTrace?.lcmCandidates[0];
  assert.ok(candidateOnlyTrace);
  assert.ok(candidateOnlyCandidate);
  const { archiveRowId: _candidateOnlyArchiveRowId, ...candidateOnlyWithoutRow } = candidateOnlyCandidate;
  candidateOnlyTrace.lcmCandidates[0] = { ...candidateOnlyWithoutRow, lineageStatus: "unavailable" };
  assert.equal(
    diagnoseLoCoMoRetrievalTraceDelta(receipt("baseline", [task(id)]), receipt("real", [candidateOnly])).tasks[0]
      ?.mechanism,
    "insufficient-exact-lineage"
  );
});

test("ignores unavailable non-LCM selections for exact attribution", () => {
  const id = "fixture-q0-multi_hop";
  const baselineTask = task(id);
  const realTask = task(id);
  for (const entry of [baselineTask, realTask]) {
    const trace = entry.sessions[0]?.trace;
    assert.ok(trace);
    trace.sections.push({
      id: "evidence-section",
      source: "evidence-pack",
      separatorStart: 20,
      contentStart: 22,
      contentEnd: 30,
      composedStart: 20,
      composedEnd: 30,
      visibleStart: 20,
      visibleEnd: 30,
      visibleChars: 10,
    });
    trace.budget.composedChars = 30;
    trace.budget.returnedChars = 30;
  }
  const baselineTrace = baselineTask.sessions[0]?.trace;
  assert.ok(baselineTrace);
  baselineTrace.selections.push({
    sectionId: "evidence-section",
    kind: "evidence-block",
    lineageStatus: "unavailable",
    composedStart: 22,
    composedEnd: 30,
    visibleStart: 22,
    visibleEnd: 30,
  });
  const delta = diagnoseLoCoMoRetrievalTraceDelta(receipt("baseline", [baselineTask]), receipt("real", [realTask]))
    .tasks[0];
  assert.equal(delta?.dimensions.sectionVisibleChars.changed, false);
  assert.equal(delta?.dimensions.selections.changed, false);
  assert.equal(delta?.dimensions.archiveRows.changed, false);
  assert.equal(delta?.mechanism, "no-structural-delta");
});

test("keeps exact auxiliary selection changes out of LCM attribution", () => {
  const id = "fixture-q0-multi_hop";
  const baselineTask = task(id);
  const realTask = task(id);
  for (const [index, entry] of [baselineTask, realTask].entries()) {
    const trace = entry.sessions[0]?.trace;
    assert.ok(trace);
    trace.sections.push({
      id: "evidence-section",
      source: "evidence-pack",
      separatorStart: 20,
      contentStart: 22,
      contentEnd: 30,
      composedStart: 20,
      composedEnd: 30,
      visibleStart: 20,
      visibleEnd: 30,
      visibleChars: 10,
    });
    trace.selections.push({
      sectionId: "evidence-section",
      kind: "evidence-block",
      lineageStatus: "exact",
      archiveRowIds: [101 + index],
      composedStart: 22,
      composedEnd: 30,
      visibleStart: 22,
      visibleEnd: 30,
    });
    trace.budget.composedChars = 30;
    trace.budget.returnedChars = 30;
  }

  const delta = diagnoseLoCoMoRetrievalTraceDelta(receipt("baseline", [baselineTask]), receipt("real", [realTask]))
    .tasks[0];
  assert.equal(delta?.dimensions.sectionVisibleChars.changed, false);
  assert.equal(delta?.dimensions.selections.changed, true);
  assert.equal(delta?.dimensions.archiveRows.changed, true);
  assert.equal(delta?.dimensions.lcmCandidates.changed, false);
  assert.equal(delta?.mechanism, "mixed");
});

test("analyzes core-capture budget presence as a structural delta", () => {
  const id = "fixture-q0-multi_hop";
  const baselineTask = task(id);
  const realTask = task(id);
  const baselineTrace = baselineTask.sessions[0]?.trace;
  assert.ok(baselineTrace);
  const { coreCapture: _coreCapture, ...withoutCoreCapture } = baselineTrace;
  const baselineSession = baselineTask.sessions[0];
  assert.ok(baselineSession);
  baselineSession.trace = withoutCoreCapture;

  const delta = diagnoseLoCoMoRetrievalTraceDelta(receipt("baseline", [baselineTask]), receipt("real", [realTask]))
    .tasks[0];
  assert.equal(delta?.dimensions.coreBudget.changed, true);
  assert.equal(delta?.dimensions.coreResults.changed, true);
});

test("preserves ranked core-result ordering as a structural signal", () => {
  const id = "fixture-q0-multi_hop";
  const baselineTask = task(id, { coreChars: 10 });
  const realTask = task(id, { coreChars: 10 });
  for (const entry of [baselineTask, realTask]) {
    const results = entry.sessions[0]?.trace.coreCapture?.results;
    const first = results?.[0];
    assert.ok(results);
    assert.ok(first);
    results.push({
      ...structuredClone(first),
      memoryIdRef: { sha256: hashString("second-private-core-memory-id"), length: 29 },
      scoreDecomposition: { ...first.scoreDecomposition, final: 0.5 },
    });
  }
  const realResults = realTask.sessions[0]?.trace.coreCapture?.results;
  assert.ok(realResults);
  realResults.reverse();

  const delta = diagnoseLoCoMoRetrievalTraceDelta(receipt("baseline", [baselineTask]), receipt("real", [realTask]))
    .tasks[0];
  assert.equal(delta?.dimensions.sectionVisibleChars.changed, false);
  assert.equal(delta?.dimensions.coreBudget.changed, false);
  assert.equal(delta?.dimensions.coreFilters.changed, false);
  assert.deepEqual(delta?.dimensions.coreResults, {
    baselineCount: 2,
    realCount: 2,
    sharedCount: 0,
    baselineOnlyCount: 2,
    realOnlyCount: 2,
    changed: true,
  });
  assert.equal(delta?.dimensions.recallBudget.changed, false);
  assert.equal(delta?.dimensions.compositionPolicy.changed, false);
  assert.equal(delta?.dimensions.compositionDigests.changed, false);
  assert.equal(delta?.mechanism, "mixed");
});

test("requires an LCM-specific lineage carrier for LCM-bearing sections", () => {
  const id = "fixture-q0-multi_hop";
  const baselineTask = task(id);
  const realTask = task(id);
  for (const entry of [baselineTask, realTask]) {
    const trace = entry.sessions[0]?.trace;
    assert.ok(trace);
    trace.selections = [];
    trace.lcmCandidates = [];
  }

  const delta = diagnoseLoCoMoRetrievalTraceDelta(receipt("baseline", [baselineTask]), receipt("real", [realTask]))
    .tasks[0];
  assert.equal(delta?.mechanism, "insufficient-exact-lineage");
});

test("binds exact LCM lineage to every rendered LCM section", () => {
  const id = "fixture-q0-multi_hop";
  const orphaned = task(id);
  const orphanedSelection = orphaned.sessions[0]?.trace.selections[0];
  assert.ok(orphanedSelection);
  orphanedSelection.sectionId = "missing-section";
  assert.throws(
    () => diagnoseLoCoMoRetrievalTraceDelta(receipt("baseline", [task(id)]), receipt("real", [orphaned])),
    /selection structure is invalid/
  );

  const baselineTask = task(id);
  const realTask = task(id);
  for (const entry of [baselineTask, realTask]) {
    const trace = entry.sessions[0]?.trace;
    assert.ok(trace);
    trace.sections.push({
      id: "raw-row-section",
      source: "raw-row",
      separatorStart: 20,
      contentStart: 22,
      contentEnd: 30,
      composedStart: 20,
      composedEnd: 30,
      visibleStart: 20,
      visibleEnd: 30,
      visibleChars: 10,
    });
    trace.budget.composedChars = 30;
    trace.budget.returnedChars = 30;
  }
  assert.equal(
    diagnoseLoCoMoRetrievalTraceDelta(receipt("baseline", [baselineTask]), receipt("real", [realTask])).tasks[0]
      ?.mechanism,
    "insufficient-exact-lineage"
  );
});

test("fails closed on tampering, pairing drift, equal config hashes, and unavailable lineage", () => {
  const baseline = receipt("baseline", [task("fixture-q0-multi_hop")]);
  const real = receipt("real", [task("fixture-q0-multi_hop", { lineageStatus: "unavailable" })]);
  assert.equal(diagnoseLoCoMoRetrievalTraceDelta(baseline, real).tasks[0]?.mechanism, "insufficient-exact-lineage");

  const tampered = structuredClone(real);
  const tamperedTask = tampered.tasks[0];
  assert.ok(tamperedTask);
  tamperedTask.recallBudgetChars += 1;
  assert.throws(() => diagnoseLoCoMoRetrievalTraceDelta(baseline, tampered), /hash verification failed/);

  const mismatched = receipt("real", [task("different-q0-multi_hop")]);
  assert.throws(
    () => diagnoseLoCoMoRetrievalTraceDelta(baseline, mismatched),
    /provenance does not match|task mismatch/
  );

  const equalConfig = receipt("real", [task("fixture-q0-multi_hop")], "baseline");
  assert.throws(() => diagnoseLoCoMoRetrievalTraceDelta(baseline, equalConfig), /different baseline and real/);

  const changedQuestion = structuredClone(real);
  const changedQuestionTask = changedQuestion.tasks[0];
  assert.ok(changedQuestionTask);
  changedQuestionTask.question = digest("different question");
  assert.throws(() => diagnoseLoCoMoRetrievalTraceDelta(baseline, reseal(changedQuestion)), /task mismatch/);

  const changedSession = structuredClone(real);
  const changedSessionReceipt = changedSession.tasks[0]?.sessions[0];
  assert.ok(changedSessionReceipt);
  changedSessionReceipt.session = digest("different session");
  assert.throws(() => diagnoseLoCoMoRetrievalTraceDelta(baseline, reseal(changedSession)), /session mismatch/);

  const changedBudget = structuredClone(real);
  const changedBudgetTask = changedBudget.tasks[0];
  const changedBudgetSession = changedBudget.tasks[0]?.sessions[0];
  assert.ok(changedBudgetTask);
  assert.ok(changedBudgetSession);
  changedBudgetTask.recallBudgetChars += 1;
  changedBudgetSession.trace.budget.requestedChars += 1;
  assert.throws(() => diagnoseLoCoMoRetrievalTraceDelta(baseline, reseal(changedBudget)), /task mismatch/);

  const inconsistentBudget = receipt("real", [task("fixture-q0-multi_hop")]);
  const inconsistentTrace = inconsistentBudget.tasks[0]?.sessions[0]?.trace;
  assert.ok(inconsistentTrace);
  inconsistentTrace.budget.returnedChars = inconsistentTrace.budget.composedChars - 1;
  assert.throws(
    () => diagnoseLoCoMoRetrievalTraceDelta(baseline, reseal(inconsistentBudget)),
    /session structure is invalid/
  );

  const malformedCompanionBaseline = recorderTask("fixture-q1-multi_hop", 15);
  const malformedCompanionReal = recorderTask("fixture-q1-multi_hop", 25);
  const malformedCompanion = structuredClone(malformedCompanionBaseline.sessions[0]);
  assert.ok(malformedCompanion);
  malformedCompanion.trace.budget.composedChars = 30;
  malformedCompanion.trace.budget.returnedChars = 20;
  malformedCompanion.trace.budget.truncated = true;
  malformedCompanionBaseline.sessions.push(structuredClone(malformedCompanion));
  malformedCompanionReal.sessions.push(structuredClone(malformedCompanion));
  assert.throws(
    () =>
      diagnoseLoCoMoRetrievalTraceDelta(
        receipt("baseline", [malformedCompanionBaseline]),
        receipt("real", [malformedCompanionReal])
      ),
    /session structure is invalid/
  );

  const inconsistentSectionVisibility = receipt("real", [task("fixture-q0-multi_hop")]);
  const invalidSection = inconsistentSectionVisibility.tasks[0]?.sessions[0]?.trace.sections[0];
  assert.ok(invalidSection);
  invalidSection.visibleEnd -= 1;
  invalidSection.visibleChars -= 1;
  assert.throws(
    () => diagnoseLoCoMoRetrievalTraceDelta(baseline, reseal(inconsistentSectionVisibility)),
    /section structure is invalid/
  );

  const malformedSectionLayout = receipt("real", [task("fixture-q0-multi_hop", { sectionCopies: 2 })]);
  const malformedSecondSection = malformedSectionLayout.tasks[0]?.sessions[0]?.trace.sections[1];
  assert.ok(malformedSecondSection);
  malformedSecondSection.separatorStart += 1;
  malformedSecondSection.contentStart += 1;
  malformedSecondSection.composedStart += 1;
  assert.throws(
    () => diagnoseLoCoMoRetrievalTraceDelta(baseline, reseal(malformedSectionLayout)),
    /section structure is invalid/
  );

  const outOfSectionSelection = receipt("real", [task("fixture-q0-multi_hop")]);
  const invalidSelection = outOfSectionSelection.tasks[0]?.sessions[0]?.trace.selections[0];
  assert.ok(invalidSelection);
  invalidSelection.composedEnd += 1;
  invalidSelection.visibleEnd += 1;
  assert.throws(
    () => diagnoseLoCoMoRetrievalTraceDelta(baseline, reseal(outOfSectionSelection)),
    /selection structure is invalid/
  );

  const invalidComposition = receipt("real", [task("fixture-q0-multi_hop")]);
  const invalidCompositionTask = invalidComposition.tasks[0];
  assert.ok(invalidCompositionTask);
  invalidCompositionTask.composition = prioritizeLoCoMoRecallTextWithTrace({
    question: "Where does Alice live?",
    recalledText: "Alice lives in Rome.",
    multiHopRecallComposition: true,
  }).receipt;
  const invalidCompositionLine = invalidCompositionTask.composition.selectedLines[0];
  assert.ok(invalidCompositionLine);
  invalidCompositionLine.visible = !invalidCompositionLine.visible;
  assert.throws(
    () => diagnoseLoCoMoRetrievalTraceDelta(baseline, reseal(invalidComposition)),
    /composition line structure is invalid/
  );

  for (const missingLineage of ["selection-missing", "selection-empty", "candidate-missing"] as const) {
    const incomplete = receipt("real", [task("fixture-q0-multi_hop")]);
    const trace = incomplete.tasks[0]?.sessions[0]?.trace;
    assert.ok(trace);
    if ((missingLineage === "selection-missing" || missingLineage === "selection-empty") && trace.selections[0]) {
      trace.selections[0].kind = "raw-row";
      delete trace.selections[0].summary;
      const section = trace.sections.find((entry) => entry.id === trace.selections[0]?.sectionId);
      assert.ok(section);
      section.source = "raw-row";
    }
    if (missingLineage === "selection-missing" && trace.selections[0]) {
      const { archiveRowIds: _archiveRowIds, ...withoutArchiveRows } = trace.selections[0];
      trace.selections[0] = withoutArchiveRows;
    }
    if (missingLineage === "selection-empty" && trace.selections[0]) trace.selections[0].archiveRowIds = [];
    if (missingLineage === "candidate-missing" && trace.lcmCandidates[0]) {
      const { archiveRowId: _archiveRowId, ...withoutArchiveRow } = trace.lcmCandidates[0];
      trace.lcmCandidates[0] = withoutArchiveRow;
    }
    if (missingLineage === "candidate-missing") {
      assert.throws(
        () => diagnoseLoCoMoRetrievalTraceDelta(baseline, reseal(incomplete)),
        /candidate structure is invalid/
      );
    } else {
      assert.equal(
        diagnoseLoCoMoRetrievalTraceDelta(baseline, reseal(incomplete)).tasks[0]?.mechanism,
        "insufficient-exact-lineage"
      );
    }
  }

  const emptyLineage = receipt("real", [task("fixture-q0-multi_hop", { sectionChars: 19 })]);
  const emptyTrace = emptyLineage.tasks[0]?.sessions[0]?.trace;
  assert.ok(emptyTrace);
  emptyTrace.selections = [];
  emptyTrace.lcmCandidates = [];
  assert.equal(
    diagnoseLoCoMoRetrievalTraceDelta(baseline, reseal(emptyLineage)).tasks[0]?.mechanism,
    "insufficient-exact-lineage"
  );

  const sessionIncompleteBaseline = task("fixture-q0-multi_hop");
  const sessionIncompleteReal = task("fixture-q0-multi_hop");
  const completeSecondSession = structuredClone(sessionIncompleteBaseline.sessions[0]);
  const emptySecondSession = structuredClone(sessionIncompleteReal.sessions[0]);
  assert.ok(completeSecondSession);
  assert.ok(emptySecondSession);
  sessionIncompleteBaseline.sessions.push(completeSecondSession);
  emptySecondSession.trace.selections = [];
  emptySecondSession.trace.lcmCandidates = [];
  sessionIncompleteReal.sessions.push(emptySecondSession);
  assert.equal(
    diagnoseLoCoMoRetrievalTraceDelta(
      receipt("baseline", [sessionIncompleteBaseline]),
      receipt("real", [sessionIncompleteReal])
    ).tasks[0]?.mechanism,
    "insufficient-exact-lineage"
  );

  const futureField = receipt("real", [task("fixture-q0-multi_hop")]);
  const futureCandidate = futureField.tasks[0]?.sessions[0]?.trace.lcmCandidates[0] as
    | (LoCoMoRetrievalTaskReceipt["sessions"][number]["trace"]["lcmCandidates"][number] & {
        futureRaw?: string;
      })
    | undefined;
  assert.ok(futureCandidate);
  futureCandidate.futureRaw = "must-not-influence-attribution";
  assert.throws(() => diagnoseLoCoMoRetrievalTraceDelta(baseline, reseal(futureField)), /unsupported field/);

  for (const invalidSelection of [
    { algorithm: "bogus", seed: undefined },
    { algorithm: "explicit-task-ids", seed: 7 },
    { algorithm: "sha256-seeded-sample", seed: undefined },
  ] as const) {
    const invalid = receipt("real", [task("fixture-q0-multi_hop")]);
    invalid.selection.algorithm = invalidSelection.algorithm as typeof invalid.selection.algorithm;
    if (invalidSelection.seed === undefined) delete invalid.selection.seed;
    else invalid.selection.seed = invalidSelection.seed;
    assert.throws(
      () => diagnoseLoCoMoRetrievalTraceDelta(baseline, reseal(invalid)),
      /restricted provider-free contract/
    );
  }

  const missingFinal = receipt("real", [task("fixture-q0-multi_hop")]);
  const score = missingFinal.tasks[0]?.sessions[0]?.trace.coreCapture?.results[0]?.scoreDecomposition as
    | Record<string, unknown>
    | undefined;
  assert.ok(score);
  delete score.final;
  assert.throws(
    () => diagnoseLoCoMoRetrievalTraceDelta(baseline, reseal(missingFinal)),
    /core result structure is invalid/
  );

  const noSessions = receipt("real", [task("fixture-q0-multi_hop")]);
  const noSessionsTask = noSessions.tasks[0];
  assert.ok(noSessionsTask);
  noSessionsTask.sessions = [];
  assert.throws(() => diagnoseLoCoMoRetrievalTraceDelta(baseline, reseal(noSessions)), /task structure is invalid/);
});

test("rejects duplicate task identities and impossible selection counts", () => {
  const duplicate = receipt("baseline", [task("fixture-q0-multi_hop"), task("fixture-q0-multi_hop")]);
  const real = receipt("real", [task("fixture-q0-multi_hop"), task("fixture-q0-multi_hop")]);
  assert.throws(() => diagnoseLoCoMoRetrievalTraceDelta(duplicate, real), /restricted provider-free contract/);

  const impossible = receipt("baseline", [task("fixture-q0-multi_hop")]);
  impossible.selection.candidateCount = 0;
  assert.throws(
    () => diagnoseLoCoMoRetrievalTraceDelta(reseal(impossible), receipt("real", [task("fixture-q0-multi_hop")])),
    /restricted provider-free contract/
  );
});

test("requires a strict majority and at least two multi-hop observations", () => {
  const ids = Array.from({ length: 4 }, (_, index) => `fixture-q${index}-multi_hop`);
  const baseline = receipt(
    "baseline",
    ids.map((id) => task(id))
  );
  const realTwoOfFour = receipt(
    "real",
    ids.map((id, index) => task(id, index < 2 ? { sectionChars: 21 } : {}))
  );
  assert.equal(
    diagnoseLoCoMoRetrievalTraceDelta(baseline, realTwoOfFour).dominantMultiHopMechanism.status,
    "not-supported"
  );

  const threeIds = ids.slice(0, 3);
  const realTwoOfThree = receipt(
    "real",
    threeIds.map((id, index) => task(id, index < 2 ? { sectionChars: 21 } : {}))
  );
  const supported = diagnoseLoCoMoRetrievalTraceDelta(
    receipt(
      "baseline",
      threeIds.map((id) => task(id))
    ),
    realTwoOfThree
  ).dominantMultiHopMechanism;
  assert.equal(supported.status, "supported");
  assert.equal(supported.count, 2);
});
