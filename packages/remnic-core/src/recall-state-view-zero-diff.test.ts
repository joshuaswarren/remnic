import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import { RecallResultFormatter } from "./orchestration/recall-result-formatter.js";
import { applyRecallStateViews } from "./recall-state-view-wire.js";
import { isChangeOrientedQuery } from "./recall-state-view.js";
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

/** A fixture row: the guard's line shape plus the fields the live route reads. */
type LiveFixtureRow = StateViewLine & {
  score: number;
  supersededAt?: string;
  supersededBy?: string;
};

// Review round 2: the earlier follow-up ran `injectStateViewLines`, which has
// no production caller. The live route in orchestration/recall-entry.ts is
// applyRecallStateViews -> RecallResultFormatter.formatQmdResultEntries, so
// these cases drive those two real stages. A regression that reorders, drops,
// or perturbs current-only entries in widening OR in live formatting now
// fails here.
function liveEntries(
  results: readonly LiveFixtureRow[],
  query: string,
  stateViewsEnabled: boolean,
): string[] {
  // parseConfig intentionally does not carry `recallStateViews` (see
  // recall-state-view-wire.ts: "parseConfig cannot grow"), so operators set it
  // on the live config object. Setting it INSIDE parseConfig silently yields a
  // disabled render, which makes a zero-diff assertion vacuous.
  const parsed = parseConfig({ memoryDir: "/tmp/remnic-zero-diff-test" });
  const config = stateViewsEnabled
    ? ({ ...parsed, recallStateViews: true } as typeof parsed)
    : parsed;
  const qmdResults = results.map((result) => ({
    path: `/tmp/remnic-zero-diff-test/facts/${result.memoryId}.md`,
    score: result.score,
    snippet: result.text,
    memoryId: result.memoryId,
    stateLabel: result.stateLabel,
    ...(result.supersededAt ? { supersededAt: result.supersededAt } : {}),
    ...(result.supersededBy ? { supersededBy: result.supersededBy } : {}),
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture
  const widened = applyRecallStateViews(qmdResults as any[], query, config);
  const formatter = new RecallResultFormatter(config);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture
  return formatter.formatQmdResultEntries("Relevant Memories", widened as any[]).entries;
}

function linesFrom(
  entries: readonly string[],
  results: readonly LiveFixtureRow[],
): StateViewLine[] {
  return entries.map((text, index) => ({
    memoryId: results[index]!.memoryId,
    text,
    stateLabel: results[index]!.stateLabel,
  }));
}

test("the fixture really enables state views (guards a vacuous zero-diff)", () => {
  const parsed = parseConfig({ memoryDir: "/tmp/remnic-zero-diff-test" }) as unknown as Record<string, unknown>;
  assert.equal(parsed.recallStateViews, undefined, "parseConfig must not carry the flag");
  const live = { ...parsed, recallStateViews: true };
  assert.equal(live.recallStateViews, true, "the live config object must carry it");
  // A change-oriented query is the other half of the enable condition.
  assert.ok(isChangeOrientedQuery("what changed about the database?"));
});

test("the live recall route is zero-diff for a current-only result set", () => {
  const results = [
    { memoryId: "m-1", text: "the API limit is 100/min", stateLabel: "current" as const, score: 0.9 },
    { memoryId: "m-2", text: "we chose SQLite", stateLabel: "current" as const, score: 0.8 },
  ];
  const query = "what changed about the database?";
  const baseline = liveEntries(results, query, false);
  const annotated = liveEntries(results, query, true);

  assert.deepEqual(annotated, baseline, "state views must not touch a current-only render");
  const check = checkStateViewZeroDiff({
    baseline: linesFrom(baseline, results),
    annotated: linesFrom(annotated, results),
  });
  assert.deepEqual(check, { ok: true, reason: "verified" });
});

test("the live route still renders every current entry it was given", () => {
  // Guards the inverse failure: an empty or dropped render would satisfy a
  // naive zero-diff comparison, so assert the payload actually survives.
  const results = [
    { memoryId: "m-1", text: "the API limit is 100/min", stateLabel: "current" as const, score: 0.9 },
    { memoryId: "m-2", text: "we chose SQLite", stateLabel: "current" as const, score: 0.8 },
  ];
  const entries = liveEntries(results, "what changed about the database?", true);
  assert.equal(entries.length, 2);
  assert.match(entries[0]!, /the API limit is 100\/min/);
  assert.match(entries[1]!, /we chose SQLite/);
});
