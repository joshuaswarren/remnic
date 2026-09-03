import assert from "node:assert/strict";
import test from "node:test";
import { decideInjectionSuiteCampaignResults } from "./campaign.js";
import type { InjectionSuiteStatisticalAnalysis } from "./stats.js";
import type { InjectionSuiteUtilityAnalysis } from "./utility-stats.js";

function rate(denominator: number) {
  return { denominator, successes: 0, voids: 0, rate: denominator ? 0 : null, wilsonLower95: null };
}

function family(arms: { baseline?: number; fencing?: number; quarantine?: number; both?: number } = {}) {
  return {
    family: "minja" as const,
    baseline: rate(arms.baseline ?? 1),
    fencing: rate(arms.fencing ?? 1),
    quarantine: rate(arms.quarantine ?? 1),
    both: rate(arms.both ?? 1),
    fencingVsQuarantineFisherP: null,
    fencingVsQuarantineHolmP: null,
    parityPairs: 0,
    parityMismatches: 0,
    baselineGate: true,
    fencingGate: true,
    nonInferiorityGate: true,
    adaptiveGate: null,
  };
}

function run(
  profile: string,
  decision: InjectionSuiteStatisticalAnalysis["decision"],
  overrides: Partial<InjectionSuiteStatisticalAnalysis> = {},
): InjectionSuiteStatisticalAnalysis {
  return {
    schemaVersion: 1,
    ruleId: "h5-origin-authority-decision-v1",
    stage: "base",
    modelProfileId: profile,
    modelProfileHash: profile,
    expectedRows: 1,
    observedRows: 1,
    invalidRows: 0,
    duplicateRows: 0,
    missingRows: 0,
    unexpectedRows: 0,
    families: [family()],
    decision,
    ...overrides,
  };
}

function adaptiveRun(profile: string, decision: InjectionSuiteStatisticalAnalysis["decision"]) {
  return run(profile, decision, { stage: "adaptive-r1" });
}

function utility(equivalent: boolean | null): InjectionSuiteUtilityAnalysis {
  return {
    schemaVersion: 1,
    pairs: equivalent === null ? 0 : 1,
    missingObservations: 0,
    baselineMean: equivalent === null ? null : 1,
    fencingMean: equivalent === null ? null : 1,
    relativeDelta: equivalent === null ? null : 0,
    relativeBootstrap90: equivalent === null ? null : { lower: 0, upper: 0 },
    tost: equivalent === null ? null : { lowerP: 0, upperP: 0 },
    estimatedPower: equivalent === null ? null : 1,
    equivalent,
  };
}

test("supported H5 recommends the core fencing mode", () => {
  const result = decideInjectionSuiteCampaignResults(
    [run("profile-a", "SUPPORTED"), run("profile-b", "SUPPORTED")],
    [utility(true), utility(true)],
  );
  assert.equal(result.h5, "SUPPORTED");
  assert.equal(result.recommendedCoreMode, "fencing");
  assert.equal(result.h5d, "NOT_RUN");
});

test("a utility regression rejects the layered claim; a missing measurement is not estimable", () => {
  const layered = decideInjectionSuiteCampaignResults(
    [run("profile-a", "PARTIALLY_SUPPORTED"), run("profile-b", "SUPPORTED")],
    [utility(true), utility(false)],
  );
  assert.equal(layered.h5, "REJECTED");
  assert.equal(layered.recommendedCoreMode, null);

  const partial = decideInjectionSuiteCampaignResults(
    [run("profile-a", "PARTIALLY_SUPPORTED"), run("profile-b", "SUPPORTED")],
    [utility(true), utility(true)],
  );
  assert.equal(partial.h5, "PARTIALLY_SUPPORTED");
  assert.equal(partial.recommendedCoreMode, "layered");

  // A missing or incomplete utility measurement is NOT a rejection: the
  // hypothesis is simply not estimable from this campaign.
  const missing = decideInjectionSuiteCampaignResults(
    [run("profile-a", "SUPPORTED"), run("profile-b", "SUPPORTED")],
    [utility(true), utility(null)],
  );
  assert.equal(missing.h5, "NOT_ESTIMABLE");
  assert.equal(missing.recommendedCoreMode, null);

  const notEstimable = decideInjectionSuiteCampaignResults(
    [run("profile-a", "NOT_ESTIMABLE"), run("profile-b", "SUPPORTED")],
    [utility(true), utility(true)],
  );
  assert.equal(notEstimable.h5, "NOT_ESTIMABLE");
});

test("campaign validates evidence by stage before deciding", () => {
  assert.throws(
    () => decideInjectionSuiteCampaignResults(
      [adaptiveRun("profile-a", "SUPPORTED"), adaptiveRun("profile-b", "SUPPORTED")],
      [utility(true), utility(true)],
    ),
    /base-stage run/,
  );
  assert.throws(
    () => decideInjectionSuiteCampaignResults(
      [run("profile-a", "SUPPORTED"), run("profile-b", "SUPPORTED")],
      [utility(true), utility(true)],
      [run("profile-a", "SUPPORTED"), run("profile-b", "SUPPORTED")],
    ),
    /adaptive-r1..r3 run/,
  );
  // Online runs carry attack@k statistics from their own analyzer; the
  // generic campaign path must not consume them as H5d evidence.
  assert.throws(
    () => decideInjectionSuiteCampaignResults(
      [run("profile-a", "SUPPORTED"), run("profile-b", "SUPPORTED")],
      [utility(true), utility(true)],
      [run("profile-a", "SUPPORTED", { stage: "adaptive-online-r1" }), run("profile-b", "SUPPORTED", { stage: "adaptive-online-r1" })],
    ),
    /adaptive-r1..r3 run/,
  );
});

test("campaign requires every registered arm in every base family", () => {
  const subset = run("profile-b", "SUPPORTED", { families: [family({ both: 0 })] });
  assert.throws(
    () => decideInjectionSuiteCampaignResults(
      [run("profile-a", "SUPPORTED"), subset],
      [utility(true), utility(true)],
    ),
    /missing the both arm/,
  );
  assert.throws(
    () => decideInjectionSuiteCampaignResults(
      [run("profile-a", "SUPPORTED", { families: [] }), run("profile-b", "SUPPORTED")],
      [utility(true), utility(true)],
    ),
    /no family results/,
  );
});
