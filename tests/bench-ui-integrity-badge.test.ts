import test from "node:test";
import assert from "node:assert/strict";
import { describeIntegrity } from "../packages/bench-ui/src/components/integrity-model.js";
import type { BenchIntegritySummary } from "../packages/bench-ui/src/bench-data.js";

function summary(overrides: Partial<BenchIntegritySummary> = {}): BenchIntegritySummary {
  return {
    split: "holdout",
    sealsPresent: true,
    canaryScore: 0.02,
    canaryFloor: 0.1,
    canaryUnderFloor: true,
    qrelsSealedHashShort: "abcdef012345",
    judgePromptHashShort: "fedcba987654",
    datasetHashShort: "0123456789ab",
    ...overrides,
  };
}

test("verified badge when holdout + sealed + canary under floor", () => {
  const model = describeIntegrity(summary());
  assert.equal(model.level, "verified");
  assert.match(model.label, /verified/u);
  assert.equal(model.reasons.length, 0);
});

test("partial badge when split is public", () => {
  const model = describeIntegrity(summary({ split: "public" }));
  assert.equal(model.level, "partial");
  assert.ok(model.reasons.some((r) => /Public-split/u.test(r)));
});

test("partial badge when split is unknown", () => {
  const model = describeIntegrity(summary({ split: "unknown" }));
  assert.equal(model.level, "partial");
  assert.ok(model.reasons.some((r) => /split type/iu.test(r)));
});

test("unverified badge when seals are missing", () => {
  const model = describeIntegrity(
    summary({ sealsPresent: false, qrelsSealedHashShort: null }),
  );
  assert.equal(model.level, "unverified");
  assert.ok(model.reasons.some((r) => /Sealed-artifact/u.test(r)));
});

test("unverified badge when canary is above floor", () => {
  const model = describeIntegrity(
    summary({ canaryScore: 0.4, canaryUnderFloor: false }),
  );
  assert.equal(model.level, "unverified");
  assert.ok(model.reasons.some((r) => /above the configured floor/u.test(r)));
});

test("partial badge when canary score is missing but everything else is good", () => {
  const model = describeIntegrity(
    summary({ canaryScore: null, canaryUnderFloor: null }),
  );
  assert.equal(model.level, "partial");
  assert.ok(model.reasons.some((r) => /Canary score/u.test(r)));
});

test("model exposes human-readable split and canary text", () => {
  const model = describeIntegrity(summary());
  assert.match(model.splitText, /Holdout/iu);
  assert.match(model.canaryText, /0\.020/u);
  assert.match(model.canaryText, /floor 0\.10/u);
});

test("results.ts integrity summary is surfaced for legacy results without hashes", () => {
  const legacy = summary({
    split: "unknown",
    sealsPresent: false,
    canaryScore: null,
    canaryUnderFloor: null,
    qrelsSealedHashShort: null,
    judgePromptHashShort: null,
    datasetHashShort: null,
  });
  const model = describeIntegrity(legacy);
  assert.equal(model.level, "unverified");
  // Legacy result should still render without throwing.
  assert.ok(model.sealLines.every((line) => typeof line === "string"));
});
