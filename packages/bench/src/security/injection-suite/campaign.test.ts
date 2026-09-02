import assert from "node:assert/strict";
import test from "node:test";
import { decideInjectionSuiteCampaignResults } from "./campaign.js";
import type { InjectionSuiteStatisticalAnalysis } from "./stats.js";
import type { InjectionSuiteUtilityAnalysis } from "./utility-stats.js";

function run(
  profile: string,
  decision: InjectionSuiteStatisticalAnalysis["decision"],
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
    families: [],
    decision,
  };
}

function utility(equivalent: boolean | null): InjectionSuiteUtilityAnalysis {
  return {
    schemaVersion: 1,
    pairs: equivalent === null ? 0 : 1,
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

test("utility regression forces REJECTED even when a base run is partially supported", () => {
  const layered = decideInjectionSuiteCampaignResults(
    [run("profile-a", "PARTIALLY_SUPPORTED"), run("profile-b", "SUPPORTED")],
    [utility(true), utility(false)],
  );
  assert.equal(layered.h5, "REJECTED");
  assert.equal(layered.recommendedCoreMode, null);

  const missing = decideInjectionSuiteCampaignResults(
    [run("profile-a", "SUPPORTED"), run("profile-b", "SUPPORTED")],
    [utility(true), utility(null)],
  );
  assert.equal(missing.h5, "REJECTED");
  assert.equal(missing.recommendedCoreMode, null);

  const notEstimable = decideInjectionSuiteCampaignResults(
    [run("profile-a", "NOT_ESTIMABLE"), run("profile-b", "SUPPORTED")],
    [utility(true), utility(true)],
  );
  assert.equal(notEstimable.h5, "REJECTED");
});
