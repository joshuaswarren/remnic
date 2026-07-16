import assert from "node:assert/strict";
import test from "node:test";

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
    truncated?: boolean;
    lineageStatus?: "exact" | "unavailable";
  } = {}
): LoCoMoRetrievalTaskReceipt {
  const sectionCopies = options.sectionCopies ?? 1;
  const sectionChars = options.sectionChars ?? 20;
  const coreScore = options.coreScore ?? 1;
  const coreChars = options.coreChars ?? 0;
  const lineageStatus = options.lineageStatus ?? "exact";
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
          sections: [
            ...Array.from({ length: sectionCopies }, (_, index) => ({
              id: `section-${index}`,
              source: "lcm-summary" as const,
              separatorStart: index * sectionChars,
              contentStart: index * sectionChars,
              contentEnd: (index + 1) * sectionChars,
              composedStart: index * sectionChars,
              composedEnd: (index + 1) * sectionChars,
              visibleStart: index * sectionChars,
              visibleEnd: (index + 1) * sectionChars,
              visibleChars: sectionChars,
            })),
            ...(coreChars === 0
              ? []
              : [
                  {
                    id: "core-section",
                    source: "core" as const,
                    separatorStart: 0,
                    contentStart: 0,
                    contentEnd: coreChars,
                    composedStart: 0,
                    composedEnd: coreChars,
                    visibleStart: 0,
                    visibleEnd: coreChars,
                    visibleChars: coreChars,
                  },
                ]),
          ],
          selections: [
            {
              sectionId: "section-0",
              kind: "lcm-summary",
              lineageStatus,
              ...(lineageStatus === "exact" ? { archiveRowIds: [7] } : {}),
              summary: { depth: 1, msgStart: 0, msgEnd: 1 },
              composedStart: 0,
              composedEnd: sectionChars,
              visibleStart: 0,
              visibleEnd: sectionChars,
            },
          ],
          lcmCandidates: [{ rank: 0, archiveRowId: 7, turnIndex: 2, role: "user", score: sectionChars, lineageStatus }],
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
            composedChars: 20,
            returnedChars: options.truncated ? 10 : 20,
            truncated: options.truncated ?? false,
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
    task("fixture-q2-adversarial"),
  ];
  const realTasks = [
    task("fixture-q0-single_hop", { sectionCopies: 1 }),
    task("fixture-q1-temporal", { compositionMode: "fallback" }),
    task("fixture-q2-adversarial", { truncated: true }),
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
  baselineSection.source = "derived";
  realSection.source = "evidence-pack";
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
    recalledText: "Alice lives in Paris.",
    multiHopRecallComposition: true,
  }).receipt;

  const delta = diagnoseLoCoMoRetrievalTraceDelta(receipt("baseline", [baselineTask]), receipt("real", [realTask]))
    .tasks[0];
  assert.equal(delta?.dimensions.compositionPolicy.changed, false);
  assert.equal(delta?.dimensions.compositionDigests.changed, true);
  assert.equal(delta?.mechanism, "real-core-visible-lcm-displacement");
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
  const changedBudgetSession = changedBudget.tasks[0]?.sessions[0];
  assert.ok(changedBudgetSession);
  changedBudgetSession.trace.budget.requestedChars += 1;
  assert.throws(() => diagnoseLoCoMoRetrievalTraceDelta(baseline, reseal(changedBudget)), /budget mismatch/);

  for (const missingLineage of ["selection-missing", "selection-empty", "candidate-missing"] as const) {
    const incomplete = receipt("real", [task("fixture-q0-multi_hop")]);
    const trace = incomplete.tasks[0]?.sessions[0]?.trace;
    assert.ok(trace);
    if (missingLineage === "selection-missing" && trace.selections[0]) {
      const { archiveRowIds: _archiveRowIds, ...withoutArchiveRows } = trace.selections[0];
      trace.selections[0] = withoutArchiveRows;
    }
    if (missingLineage === "selection-empty" && trace.selections[0]) trace.selections[0].archiveRowIds = [];
    if (missingLineage === "candidate-missing" && trace.lcmCandidates[0]) {
      const { archiveRowId: _archiveRowId, ...withoutArchiveRow } = trace.lcmCandidates[0];
      trace.lcmCandidates[0] = withoutArchiveRow;
    }
    assert.equal(
      diagnoseLoCoMoRetrievalTraceDelta(baseline, reseal(incomplete)).tasks[0]?.mechanism,
      "insufficient-exact-lineage"
    );
  }
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
