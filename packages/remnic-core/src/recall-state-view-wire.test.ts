import assert from "node:assert/strict";
import test from "node:test";

import { applyRecallStateViews } from "./recall-state-view-wire.js";
import type { StateViewResult } from "./recall-state-view.js";

function fact(id: string, extra: Partial<StateViewResult> = {}): StateViewResult {
  return { id, ...extra };
}

const PAIR: StateViewResult[] = [
  fact("new-job", { status: "active" }),
  fact("old-job", { status: "superseded", supersededBy: "new-job", supersededAt: "2026-03-01" }),
];

test("recallStateViews false is identity (same array reference)", () => {
  const input = PAIR.map((row) => ({ ...row }));
  assert.equal(applyRecallStateViews(input, "when did the job title change", {}), input);
  assert.equal(
    applyRecallStateViews(input, "when did the job title change", { recallStateViews: false }),
    input,
  );
  assert.equal(input[0]?.stateLabel, undefined);
});

test("change-intent query labels a synthetic superseded pair when recallStateViews is on", () => {
  const labeled = applyRecallStateViews(PAIR, "when did the job title change", {
    recallStateViews: true,
  });
  assert.equal(labeled.length, 2);
  assert.equal(labeled[0]?.id, "new-job");
  assert.equal(labeled[0]?.stateLabel, "current");
  assert.equal(labeled[1]?.id, "old-job");
  assert.equal(labeled[1]?.stateLabel, "historical");
});
