import assert from "node:assert/strict";
import test from "node:test";

import { describeIntegrity } from "./integrity-model";

test("describeIntegrity does not verify results with unknown canary floor status", () => {
  const model = describeIntegrity({
    split: "holdout",
    sealsPresent: true,
    canaryUnderFloor: null,
    canaryScore: 0.2,
    canaryFloor: 0.1,
    qrelsSealedHashShort: "abc",
    judgePromptHashShort: "def",
    datasetHashShort: "ghi",
  });

  assert.equal(model.level, "partial");
  assert.equal(model.label, "Integrity: partial");
  assert.match(model.canaryText, /status unknown/);
  assert.doesNotMatch(model.canaryText, /ABOVE FLOOR/);
  assert.ok(model.reasons.includes("Canary floor comparison was not recorded."));
});
