import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { RecallXraySnapshot } from "@remnic/core";

import {
  createBenchRecallTraceRecorder,
  projectBenchCoreCapture,
} from "./remnic-recall-trace.js";

const SENSITIVE_MEMORY_ID = "entities/Secret Person/profile.md";

function sensitiveSnapshot(): RecallXraySnapshot {
  const results: RecallXraySnapshot["results"] = [{
    memoryId: SENSITIVE_MEMORY_ID,
    path: "/secret/path.md",
    servedBy: "hybrid",
    scoreDecomposition: { vector: 0.8, final: 0.7 },
    graphPath: ["secret-node"],
    admittedBy: ["validity"],
    tags: ["secret-tag"],
    sourceSpan: {
      quote: "secret quote",
      observedAt: "2026-01-01T00:00:00.000Z",
      provenance: "verified",
    },
    disclosure: "section",
    estimatedTokens: 10,
  }];

  return {
    schemaVersion: "1",
    query: "secret query",
    snapshotId: "snapshot-1",
    capturedAt: 123,
    traceId: "trace-1",
    tierExplain: null,
    filters: [{ name: "validity", considered: 3, admitted: 2, reason: "raw reason" }],
    budget: { chars: 100, used: 40 },
    results,
    appliedResultLimit: results.length,
    appliedResults: results,
    headroomResults: [],
  };
}

test("recorder translates local receipt offsets and clips visible ranges", () => {
  const recorder = createBenchRecallTraceRecorder(12);
  recorder.appendSection("first", "derived", 5);
  recorder.appendSection("evidence", "evidence-pack", 10);
  recorder.recordEvidenceSelections("evidence", [
    {
      item: { archiveRowId: 41, turnIndex: 7, role: "user", score: 0.9 },
      blockStart: 2,
      blockEnd: 8,
    },
  ]);

  const trace = recorder.finalize(12);

  assert.deepEqual(trace.sections, [
    {
      id: "first",
      source: "derived",
      separatorStart: 0,
      contentStart: 0,
      contentEnd: 5,
      composedStart: 0,
      composedEnd: 5,
      visibleStart: 0,
      visibleEnd: 5,
      visibleChars: 5,
    },
    {
      id: "evidence",
      source: "evidence-pack",
      separatorStart: 5,
      contentStart: 7,
      contentEnd: 17,
      composedStart: 5,
      composedEnd: 17,
      visibleStart: 5,
      visibleEnd: 12,
      visibleChars: 7,
    },
  ]);
  assert.deepEqual(trace.selections[0], {
    sectionId: "evidence",
    kind: "evidence-block",
    lineageStatus: "exact",
    composedStart: 9,
    composedEnd: 15,
    visibleStart: 9,
    visibleEnd: 12,
    archiveRowIds: [41],
    turnIndex: 7,
    role: "user",
    score: 0.9,
  });
  assert.deepEqual(trace.budget, {
    requestedChars: 12,
    composedChars: 17,
    returnedChars: 12,
    truncated: true,
  });
});

test("section geometry accounts for truncation inside the separator", () => {
  const recorder = createBenchRecallTraceRecorder(6);
  recorder.appendSection("first", "derived", 5);
  recorder.appendSection("second", "derived", 3);

  const trace = recorder.finalize(6);

  assert.equal(trace.sections[0]?.visibleChars, 5);
  assert.deepEqual(trace.sections[1], {
    id: "second",
    source: "derived",
    separatorStart: 5,
    contentStart: 7,
    contentEnd: 10,
    composedStart: 5,
    composedEnd: 10,
    visibleStart: 5,
    visibleEnd: 6,
    visibleChars: 1,
  });
  assert.equal(
    trace.sections.reduce((total, section) => total + section.visibleChars, 0),
    trace.budget.returnedChars,
  );
});

test("geometry uses JavaScript string character offsets for non-ASCII content", () => {
  const first = "é🙂";
  const second = "漢";
  assert.equal(first.length, 3);
  assert.equal(second.length, 1);

  const recorder = createBenchRecallTraceRecorder(5);
  recorder.appendSection("first", "evidence-pack", first.length);
  recorder.recordEvidenceSelections("first", [{
    item: { archiveRowId: 7 },
    blockStart: 1,
    blockEnd: 3,
  }]);
  recorder.appendSection("second", "derived", second.length);
  const trace = recorder.finalize(5);

  assert.deepEqual(trace.selections[0] && {
    composedStart: trace.selections[0].composedStart,
    composedEnd: trace.selections[0].composedEnd,
    visibleChars:
      trace.selections[0].visibleEnd - trace.selections[0].visibleStart,
  }, {
    composedStart: 1,
    composedEnd: 3,
    visibleChars: 2,
  });
  assert.deepEqual(trace.sections.map((section) => ({
    separatorStart: section.separatorStart,
    contentStart: section.contentStart,
    contentEnd: section.contentEnd,
    visibleChars: section.visibleChars,
  })), [
    { separatorStart: 0, contentStart: 0, contentEnd: 3, visibleChars: 3 },
    { separatorStart: 3, contentStart: 5, contentEnd: 6, visibleChars: 2 },
  ]);
  assert.equal(
    trace.sections.reduce((total, section) => total + section.visibleChars, 0),
    trace.budget.returnedChars,
  );
});

test("recorder rejects malformed receipt ranges outside section content", () => {
  const recorder = createBenchRecallTraceRecorder(10);
  recorder.appendSection("evidence", "evidence-pack", 5);

  assert.throws(
    () => recorder.recordEvidenceSelections("evidence", [{
      item: { archiveRowId: 1 },
      blockStart: 4,
      blockEnd: 6,
    }]),
    /Invalid benchmark recall trace range/,
  );
});

test("raw-row identity accepts only positive safe archive row ids", () => {
  for (const id of [undefined, Number.NaN, 0, -1, 1.5]) {
    const recorder = createBenchRecallTraceRecorder(10);
    recorder.appendSection("raw", "raw-row", 5);
    recorder.recordRawRow("raw", { start: 0, end: 5 }, {
      ...(id === undefined ? {} : { id }),
      turn_index: 1,
      role: "user",
    });
    const selection = recorder.finalize(5).selections[0];
    assert.equal(selection?.lineageStatus, "unavailable");
    assert.equal(selection?.archiveRowIds, undefined);
  }

  const recorder = createBenchRecallTraceRecorder(10);
  recorder.appendSection("raw", "raw-row", 5);
  recorder.recordRawRow("raw", { start: 0, end: 5 }, {
    id: 9,
    turn_index: 1,
    role: "user",
  });
  assert.deepEqual(recorder.finalize(5).selections[0]?.archiveRowIds, [9]);
});

test("zero budget finalizes an empty, non-truncated trace", () => {
  const trace = createBenchRecallTraceRecorder(0).finalize(0);
  assert.deepEqual(trace.budget, {
    requestedChars: 0,
    composedChars: 0,
    returnedChars: 0,
    truncated: false,
  });
  assert.deepEqual(trace.sections, []);
});

test("recorder preserves exact trajectory, summary, raw-row, and candidate lineage", () => {
  const recorder = createBenchRecallTraceRecorder(100);
  recorder.appendSection("trajectory", "trajectory-analysis", 20);
  recorder.recordTrajectorySelections("trajectory", [
    {
      lineStart: 1,
      lineEnd: 8,
      lineageStatus: "exact",
      actionArchiveRowIds: [11],
      observationArchiveRowIds: [12],
    },
  ]);
  recorder.appendSection("summary", "lcm-summary", 20);
  recorder.recordSummarySelections("summary", [
    { id: "sum-1", depth: 2, msgStart: 4, msgEnd: 9, entryStart: 3, entryEnd: 15 },
  ]);
  recorder.appendSection("raw", "raw-row", 20);
  recorder.recordRawRow("raw", { start: 3, end: 12 }, {
    id: 91,
    turn_index: 15,
    role: "assistant",
  });
  recorder.recordLcmCandidate({
    rank: 1,
    archiveRowId: 91,
    turnIndex: 15,
    role: "assistant",
    score: 0.8,
    lineageStatus: "exact",
  });

  const trace = recorder.finalize(64);
  assert.deepEqual(trace.selections.map((selection) => selection.kind), [
    "trajectory-line",
    "lcm-summary",
    "raw-row",
  ]);
  assert.deepEqual(trace.selections[0]?.archiveRowIds, [11, 12]);
  assert.deepEqual(trace.selections[1]?.summary, {
    id: "sum-1",
    depth: 2,
    msgStart: 4,
    msgEnd: 9,
  });
  assert.equal(trace.selections[2]?.lineageStatus, "exact");
  assert.deepEqual(trace.lcmCandidates, [{
    rank: 1,
    archiveRowId: 91,
    turnIndex: 15,
    role: "assistant",
    score: 0.8,
    lineageStatus: "exact",
  }]);
});

test("core projection copies only the explicit content-free allow-list", () => {
  const snapshot = sensitiveSnapshot();
  const scoresWithFutureField: typeof snapshot.results[number]["scoreDecomposition"] & {
    futureSecretScore?: string;
  } = snapshot.results[0]!.scoreDecomposition;
  scoresWithFutureField.futureSecretScore = "future-score-sentinel";

  const projected = projectBenchCoreCapture(snapshot);
  const serialized = JSON.stringify(projected);

  assert.deepEqual(projected.filters, [{ name: "validity", considered: 3, admitted: 2 }]);
  assert.deepEqual(projected.results[0]?.memoryIdRef, {
    sha256: createHash("sha256").update(SENSITIVE_MEMORY_ID, "utf8").digest("hex"),
    length: Buffer.byteLength(SENSITIVE_MEMORY_ID, "utf8"),
  });
  for (const forbidden of [
    SENSITIVE_MEMORY_ID,
    "secret query",
    "/secret/path.md",
    "raw reason",
    "secret-node",
    "secret-tag",
    "secret quote",
    "futureSecretScore",
    "future-score-sentinel",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("final trace carries restricted sensitivity metadata and no forbidden fields", () => {
  const recorder = createBenchRecallTraceRecorder(10);
  recorder.appendSection("safe", "derived", 4);
  recorder.recordCoreCapture(sensitiveSnapshot());
  const trace = recorder.finalize(4);
  const forbiddenKeys = new Set([
    "query",
    "sessionId",
    "content",
    "snippet",
    "path",
    "tags",
    "sourceSpan",
    "reason",
    "memoryId",
  ]);
  const forbiddenValues = [
    SENSITIVE_MEMORY_ID,
    "secret query",
    "/secret/path.md",
    "raw reason",
    "secret-node",
    "secret-tag",
    "secret quote",
  ];

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === "string") {
      for (const forbidden of forbiddenValues) {
        assert.equal(value.includes(forbidden), false, `forbidden trace value: ${forbidden}`);
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbiddenKeys.has(key), false, `forbidden trace key: ${key}`);
      visit(child);
    }
  };

  assert.deepEqual(trace.sensitivity, {
    classification: "restricted",
    contentEncoding: "sha256+length",
    containsGold: false,
  });
  visit(trace);
});
