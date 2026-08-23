import assert from "node:assert/strict";
import test from "node:test";

import { applyRecallStateViews } from "./recall-state-view-wire.js";
import { widenRecallStateViews } from "./recall-state-view-widen.js";
import type { StateViewResult } from "./recall-state-view.js";

function fact(id: string, extra: Partial<StateViewResult> = {}): StateViewResult {
  return { id, ...extra };
}

const CURRENT = fact("new-job", { status: "active" });
const HISTORICAL = fact("old-job", {
  status: "superseded",
  supersededBy: "new-job",
  supersededAt: "2026-03-01",
});
const ORPHAN = fact("orphan-job", {
  status: "superseded",
  supersededBy: "missing-job",
});
const ON = { recallStateViews: true } as const;
const CHANGE = "when did the job title change";
const NON_CHANGE = "what is the current job title";

test("change-intent query labels both facts when successor is in the set", () => {
  const labeled = widenRecallStateViews([CURRENT], CHANGE, ON, [HISTORICAL]);
  assert.equal(labeled.length, 2);
  assert.equal(labeled[0]?.id, "new-job");
  assert.equal(labeled[0]?.stateLabel, "current");
  assert.equal(labeled[1]?.id, "old-job");
  assert.equal(labeled[1]?.stateLabel, "historical");
  assert.deepEqual(
    applyRecallStateViews([CURRENT, HISTORICAL], CHANGE, ON).map((row) => [
      row.id,
      row.stateLabel,
    ]),
    [
      ["new-job", "current"],
      ["old-job", "historical"],
    ],
  );
});

test("non-change query is identical (same array reference)", () => {
  const input = [CURRENT, HISTORICAL];
  assert.equal(widenRecallStateViews(input, NON_CHANGE, ON, [ORPHAN]), input);
  assert.equal(applyRecallStateViews(input, NON_CHANGE, ON), input);
  assert.equal(input[0]?.stateLabel, undefined);
});

test("recallStateViews false is identity (same array reference)", () => {
  const input = [CURRENT];
  assert.equal(widenRecallStateViews(input, CHANGE, {}, [HISTORICAL]), input);
  assert.equal(widenRecallStateViews(input, CHANGE, { recallStateViews: false }, [HISTORICAL]), input);
  assert.equal(applyRecallStateViews(input, CHANGE, { recallStateViews: false }), input);
  assert.equal(input[0]?.stateLabel, undefined);
});

test("superseded without successor is dropped", () => {
  assert.deepEqual(widenRecallStateViews([ORPHAN], CHANGE, ON), []);
  assert.deepEqual(widenRecallStateViews([CURRENT], CHANGE, ON, [ORPHAN]), [
    { ...CURRENT, stateLabel: "current" },
  ]);
  assert.deepEqual(applyRecallStateViews([ORPHAN], CHANGE, ON), []);
});

test("#1952 per-call override: stateViewActive=true labels even when config is false", () => {
  const OFF = { recallStateViews: false } as const;
  const labeled = widenRecallStateViews([CURRENT], CHANGE, OFF, [HISTORICAL], true);
  assert.deepEqual(
    labeled.map((row) => [row.id, row.stateLabel]),
    [
      ["new-job", "current"],
      ["old-job", "historical"],
    ],
    "per-call true must widen and label against a global false",
  );
  assert.deepEqual(
    applyRecallStateViews([CURRENT, HISTORICAL], CHANGE, OFF, true).map((row) => [
      row.id,
      row.stateLabel,
    ]),
    [
      ["new-job", "current"],
      ["old-job", "historical"],
    ],
    "inject seam must label on the threaded flag, not the config reread",
  );
});

test("#1952 precedence is OR: per-call false never disables a global true", () => {
  const input = [CURRENT];
  const labeled = widenRecallStateViews(input, CHANGE, ON, [HISTORICAL], false);
  assert.equal(labeled.length, 2, "config true + call false still widens");
  assert.equal(labeled[1]?.stateLabel, "historical");
});

test("#1952 override true on a non-change query stays identity (change gate applies)", () => {
  const input = [CURRENT, HISTORICAL];
  assert.equal(widenRecallStateViews(input, NON_CHANGE, { recallStateViews: false }, [], true), input);
  assert.equal(applyRecallStateViews(input, NON_CHANGE, { recallStateViews: false }, true), input);
  assert.equal(input[0]?.stateLabel, undefined);
});
