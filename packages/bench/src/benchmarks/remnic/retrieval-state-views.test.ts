import assert from "node:assert/strict";
import test from "node:test";

import { annotateStateView, formatSupersededPrefix } from "@remnic/core";

import { STATE_VIEW_TASKS, runStateViewTask } from "./retrieval-state-views.js";

test("every state-view task passes in baseline mode (feature off hides superseded)", () => {
  for (const task of STATE_VIEW_TASKS) {
    const result = runStateViewTask(task, { enabled: false });
    assert.equal(result.passed, true, `${task.id}: ${JSON.stringify(result)}`);
  }
});

test("every state-view task passes in enabled mode (labels + anchoring)", () => {
  for (const task of STATE_VIEW_TASKS) {
    const result = runStateViewTask(task, { enabled: true });
    assert.equal(result.passed, true, `${task.id}: ${JSON.stringify(result)}`);
  }
});

test("enabled mode beats baseline exactly where history exists", () => {
  // The delta between modes is the labeled history rows — never a change to
  // which current rows surface.
  for (const task of STATE_VIEW_TASKS) {
    const baseline = runStateViewTask(task, { enabled: false });
    const enabled = runStateViewTask(task, { enabled: true });
    const baselineCurrent = baseline.actual.filter((row) => row.label !== "historical" && row.label !== "transition").map((row) => row.id).sort();
    const enabledCurrent = enabled.actual.filter((row) => row.label === "current" || row.label === undefined).map((row) => row.id).sort();
    assert.deepEqual(enabledCurrent, baselineCurrent, task.id);
  }
});

test("superseded never appears without its successor in enabled output", () => {
  for (const task of STATE_VIEW_TASKS) {
    const enabled = runStateViewTask(task, { enabled: true });
    const ids = new Set(enabled.actual.map((row) => row.id));
    for (const row of enabled.actual) {
      const corpusRow = task.corpus.find((candidate) => candidate.id === row.id);
      assert.ok(corpusRow, `${task.id}: output row ${row.id} not in corpus`);
      if (row.label === "historical" || row.label === "transition") {
        const successorId = corpusRow.supersededBy ?? task.chains?.find((c) => c.predecessorId === row.id)?.successorId;
        assert.ok(
          successorId !== undefined && ids.has(successorId),
          `${task.id}: superseded row ${row.id} rendered without successor`,
        );
      }
    }
  }
});

test("bench tasks exercise the shared core annotator directly (no drift)", () => {
  const task = STATE_VIEW_TASKS.find((candidate) => candidate.id === "state-view/multi-hop");
  assert.ok(task);
  const labeled = annotateStateView([...task.corpus], task.query, [], { enabled: true });
  assert.deepEqual(
    labeled.map((row) => [row.id, row.stateLabel]),
    [
      ["db-v1", "historical"],
      ["db-v2", "transition"],
      ["db-v3", "current"],
    ],
  );
  // Render contract the formatter applies to labeled rows.
  assert.equal(
    formatSupersededPrefix("2026-04-01", "db-v2"),
    "[superseded 2026-04-01 by db-v2]",
  );
});
