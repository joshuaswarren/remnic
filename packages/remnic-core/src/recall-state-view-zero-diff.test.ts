import assert from "node:assert/strict";
import test from "node:test";

import { injectStateViewLines } from "./recall-state-view-inject.js";
import { checkStateViewZeroDiff, type StateViewLine } from "./recall-state-view-zero-diff.js";

function line(memoryId: string, text: string, stateLabel = "current"): StateViewLine {
  return { memoryId, text, stateLabel };
}

test("identical current-only lists pass", () => {
  const baseline = [line("a", "Works at Acme"), line("b", "Prefers dark mode")];
  const annotated = baseline.map((l) => ({ ...l }));
  assert.deepEqual(checkStateViewZeroDiff({ baseline, annotated }), {
    ok: true,
    reason: "verified",
  });
  assert.deepEqual(checkStateViewZeroDiff({ baseline: [], annotated: [] }), {
    ok: true,
    reason: "verified",
  });
});

test("changed current line reports current_line_changed with the id", () => {
  const baseline = [line("a", "Was a baker"), line("b", "Runs daily")];
  const annotated = [line("a", "Was a baker at a shop"), line("b", "Runs daily")];
  assert.deepEqual(checkStateViewZeroDiff({ baseline, annotated }), {
    ok: false,
    error: "current_line_changed",
    memoryId: "a",
  });
});

test("trailing space on a current line is a diff", () => {
  const baseline = [line("a", "Was a baker")];
  const annotated = [line("a", "Was a baker ")];
  assert.deepEqual(checkStateViewZeroDiff({ baseline, annotated }), {
    ok: false,
    error: "current_line_changed",
    memoryId: "a",
  });
});

test("reordered lines report order_changed", () => {
  const baseline = [line("a", "A"), line("b", "B")];
  const reordered = [line("b", "B"), line("a", "A")];
  assert.deepEqual(checkStateViewZeroDiff({ baseline, annotated: reordered }), {
    ok: false,
    error: "order_changed",
  });
});

test("dropped or added current lines report order_changed", () => {
  const baseline = [line("a", "A"), line("b", "B")];
  const dropped = [line("a", "A")];
  assert.deepEqual(checkStateViewZeroDiff({ baseline, annotated: dropped }), {
    ok: false,
    error: "order_changed",
  });
  const added = [line("a", "A"), line("b", "B"), line("c", "C")];
  assert.deepEqual(checkStateViewZeroDiff({ baseline, annotated: added }), {
    ok: false,
    error: "order_changed",
  });
});

test("text mismatch wins over order mismatch", () => {
  const baseline = [line("a", "A"), line("b", "B")];
  const annotated = [line("b", "B"), line("a", "Changed")];
  assert.deepEqual(checkStateViewZeroDiff({ baseline, annotated }), {
    ok: false,
    error: "current_line_changed",
    memoryId: "a",
  });
});

test("historical or transition item means the guarantee does not apply", () => {
  const baseline = [line("new", "Current job")];
  const withHistorical = [line("old", "Was a baker", "historical"), line("new", "Current job")];
  assert.deepEqual(checkStateViewZeroDiff({ baseline, annotated: withHistorical }), {
    ok: true,
    reason: "not_applicable",
  });
  const withTransition = [line("mid", "Bridge job", "transition"), line("new", "Current job")];
  assert.deepEqual(checkStateViewZeroDiff({ baseline, annotated: withTransition }), {
    ok: true,
    reason: "not_applicable",
  });
});

test("non-current label in baseline throws RangeError", () => {
  const baseline = [line("old", "Was a baker", "historical")];
  assert.throws(
    () => checkStateViewZeroDiff({ baseline, annotated: [] }),
    (err: unknown) => err instanceof RangeError && /baseline/.test(String(err.message)),
  );
});

test("unknown state label throws TypeError listing allowed values", () => {
  const annotated = [line("a", "Text", "bogus")];
  assert.throws(
    () => checkStateViewZeroDiff({ baseline: [], annotated }),
    (err: unknown) =>
      err instanceof TypeError &&
      /state label/.test(String(err.message)) &&
      /current, historical, transition/.test(String(err.message)),
  );
});

test("duplicate memoryId throws RangeError in either list", () => {
  assert.throws(
    () =>
      checkStateViewZeroDiff({
        baseline: [line("a", "A"), line("a", "A")],
        annotated: [],
      }),
    (err: unknown) => err instanceof RangeError && /duplicate/.test(String(err.message)),
  );
  assert.throws(
    () =>
      checkStateViewZeroDiff({
        baseline: [line("a", "A")],
        annotated: [line("b", "B"), line("b", "B again")],
      }),
    (err: unknown) => err instanceof RangeError && /duplicate/.test(String(err.message)),
  );
});

test("inputs are not mutated", () => {
  const baseline = [line("a", "A"), line("b", "B")];
  const annotated = [line("old", "Old", "historical"), line("a", "A"), line("b", "B")];
  const baselineCopy = structuredClone(baseline);
  const annotatedCopy = structuredClone(annotated);
  checkStateViewZeroDiff({ baseline, annotated });
  assert.deepEqual(baseline, baselineCopy);
  assert.deepEqual(annotated, annotatedCopy);
});

// Review: a guard referenced only by its own unit test is machinery, not
// enforcement. These cases run the REAL render/inject pipeline with state
// views disabled and enabled, then assert the promise through the guard, so a
// change to renderStateViewLine or injectStateViewLines that perturbs a
// current-only result set fails here.
test("the real inject pipeline is zero-diff for a current-only result set", () => {
  const results = [
    { memoryId: "m-1", text: "the API limit is 100/min", stateLabel: "current" as const },
    { memoryId: "m-2", text: "we chose SQLite", stateLabel: "current" as const },
  ];
  const baselineText = injectStateViewLines(results, { enabled: false });
  const annotatedText = injectStateViewLines(results, { enabled: true });

  const check = checkStateViewZeroDiff({
    baseline: results.map((result, i) => ({
      memoryId: result.memoryId,
      text: baselineText[i]!,
      stateLabel: "current",
    })),
    annotated: results.map((result, i) => ({
      memoryId: result.memoryId,
      text: annotatedText[i]!,
      stateLabel: result.stateLabel,
    })),
  });
  assert.deepEqual(check, { ok: true, reason: "verified" });
});

test("the real pipeline does annotate once a historical item qualifies", () => {
  const results = [
    { memoryId: "m-1", text: "we use PostgreSQL", stateLabel: "current" as const },
    {
      memoryId: "m-0",
      text: "we use SQLite",
      stateLabel: "historical" as const,
      supersededAt: "2026-08-01",
      supersededBy: "m-1",
    },
  ];
  const annotatedText = injectStateViewLines(results, { enabled: true });
  // Sanity that the pipeline really changes historical rows, so the zero-diff
  // assertion above is not passing because rendering is a no-op everywhere.
  assert.match(annotatedText[1]!, /superseded 2026-08-01 by m-1/);

  const check = checkStateViewZeroDiff({
    baseline: [{ memoryId: "m-1", text: "we use PostgreSQL", stateLabel: "current" }],
    annotated: results.map((result, i) => ({
      memoryId: result.memoryId,
      text: annotatedText[i]!,
      stateLabel: result.stateLabel,
    })),
  });
  assert.ok(check.ok, "a qualifying historical item means the promise does not apply");
  assert.equal(check.ok && check.reason, "not_applicable");
});
