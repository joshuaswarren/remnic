import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import { RecallResultFormatter } from "./orchestration/recall-result-formatter.js";
import { applyRecallStateViews } from "./recall-state-view-wire.js";
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
  supersedes?: string;
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
): { entries: string[]; widened: { id?: string; stateLabel?: string }[] } {
  // parseConfig now carries `recallStateViews` (default false); the override
  // below exercises the enabled path against the real parsed config, and the
  // disabled path uses the parsed default — so a parse regression (flag
  // silently ignored) makes the enabled assertions below fail.
  const parsed = parseConfig({ memoryDir: "/tmp/remnic-zero-diff-test" });
  const config = stateViewsEnabled
    ? ({ ...parsed, recallStateViews: true } as typeof parsed)
    : parsed;
  const qmdResults = results.map((result) => ({
    path: `/tmp/remnic-zero-diff-test/facts/${result.memoryId}.md`,
    score: result.score,
    snippet: result.text,
    // `resultStateViewId` reads `id ?? docid` — NOT memoryId. A fixture keyed
    // only on memoryId gives every row the empty id, so widening drops any
    // superseded row and the test silently measures nothing.
    id: result.memoryId,
    memoryId: result.memoryId,
    stateLabel: result.stateLabel,
    ...(result.supersededAt ? { supersededAt: result.supersededAt } : {}),
    ...(result.supersededBy ? { supersededBy: result.supersededBy } : {}),
    ...(result.supersedes ? { supersedes: result.supersedes } : {}),
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture
  const widened = applyRecallStateViews(qmdResults as any[], query, config);
  const formatter = new RecallResultFormatter(config);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture
  const entries = formatter.formatQmdResultEntries("Relevant Memories", widened as any[]).entries;
  return { entries, widened: widened as unknown as { id?: string; stateLabel?: string }[] };
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

test("the enabled route labels a superseded row and renders the historical prefix", () => {
  const results = [
    { memoryId: "m-1", text: "we use PostgreSQL", stateLabel: "current" as const, score: 0.9 },
    {
      memoryId: "m-0",
      text: "we use SQLite",
      stateLabel: "current" as const,
      supersededAt: "2026-08-01",
      supersededBy: "m-1",
      score: 0.7,
    },
  ];
  const query = "what changed about the database?";
  const enabled = liveEntries(results, query, true);
  const disabled = liveEntries(results, query, false);

  // Observable effect #1: widening relabels the superseded row, and only when
  // the live config carries the flag. This fails if recallStateViews is ignored.
  assert.equal(
    enabled.widened.find((row) => row.id === "m-0")?.stateLabel,
    "historical",
    "the enabled route must relabel the superseded row",
  );
  assert.equal(
    disabled.widened.find((row) => row.id === "m-0")?.stateLabel,
    "current",
    "the disabled route must not touch labels",
  );
  // Observable effect #2 (rendering slice): the enabled route prefixes the
  // admitted superseded row with `[superseded <date> by <id>]`; the disabled
  // render stays byte-identical (no prefix, same snippet).
  const enabledOld = enabled.entries.find((entry) => entry.includes("we use SQLite"));
  const disabledOld = disabled.entries.find((entry) => entry.includes("we use SQLite"));
  assert.ok(enabledOld, "enabled render includes the superseded row");
  assert.ok(disabledOld, "disabled render includes the (unlabeled) row");
  assert.match(enabledOld!, /\[superseded 2026-08-01 by m-1\] we use SQLite/);
  assert.doesNotMatch(disabledOld!, /\[superseded/);
  // Current rows are untouched in both renders.
  for (const entries of [enabled.entries, disabled.entries]) {
    const current = entries.find((entry) => entry.includes("we use PostgreSQL"));
    assert.ok(current);
    assert.doesNotMatch(current!, /\[superseded/);
  }
});

test("the enabled route drops a superseded row whose successor is absent", () => {
  // Observable effect #2, and the sharper one: an orphaned superseded row is
  // admitted when state views are off and dropped when they are on, so the
  // entry count itself depends on the live config reaching widening.
  const results = [
    { memoryId: "m-9", text: "unrelated current fact", stateLabel: "current" as const, score: 0.9 },
    {
      memoryId: "m-0",
      text: "we use SQLite",
      stateLabel: "current" as const,
      supersededAt: "2026-08-01",
      supersededBy: "m-absent",
      score: 0.7,
    },
  ];
  const query = "what changed about the database?";
  assert.equal(liveEntries(results, query, false).entries.length, 2, "disabled admits both rows");
  assert.equal(liveEntries(results, query, true).entries.length, 1, "enabled drops the orphan");
});
test("the live recall route is zero-diff for a current-only result set", () => {
  const results = [
    { memoryId: "m-1", text: "the API limit is 100/min", stateLabel: "current" as const, score: 0.9 },
    { memoryId: "m-2", text: "we chose SQLite", stateLabel: "current" as const, score: 0.8 },
  ];
  const query = "what changed about the database?";
  const baseline = liveEntries(results, query, false).entries;
  const annotated = liveEntries(results, query, true).entries;

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
  const entries = liveEntries(results, "what changed about the database?", true).entries;
  assert.equal(entries.length, 2);
  assert.match(entries[0]!, /the API limit is 100\/min/);
  assert.match(entries[1]!, /we chose SQLite/);
});

test("the enabled route renders history for a supersedes-only pair", () => {
  const results = [
    {
      memoryId: "m-1",
      text: "we use PostgreSQL",
      stateLabel: "current" as const,
      score: 0.9,
      supersedes: "m-0",
    },
    {
      memoryId: "m-0",
      text: "we use SQLite",
      stateLabel: "current" as const,
      supersededAt: "2026-08-01",
      score: 0.7,
    },
  ];
  const query = "what changed about the database?";
  const enabled = liveEntries(results, query, true);
  const old = enabled.entries.find((entry) => entry.includes("we use SQLite"));
  assert.equal(
    enabled.widened.find((row) => row.id === "m-0")?.stateLabel,
    "historical",
  );
  assert.ok(old, "enabled render includes the predecessor");
  assert.match(old!, /\[superseded 2026-08-01 by m-1\] we use SQLite/);
});
