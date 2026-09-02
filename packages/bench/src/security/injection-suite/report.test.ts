import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { InjectionSuiteCampaignDecision } from "./campaign.js";
import { writeInjectionSuiteReport } from "./report.js";
import type { InjectionSuiteStatisticalAnalysis } from "./stats.js";
import type { InjectionSuiteUtilityAnalysis } from "./utility-stats.js";

function analysis(profile: string): InjectionSuiteStatisticalAnalysis {
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
    decision: "SUPPORTED",
  };
}

const utility: InjectionSuiteUtilityAnalysis = {
  schemaVersion: 1,
  pairs: 1,
  missingObservations: 0,
  baselineMean: 1,
  fencingMean: 1,
  relativeDelta: 0,
  relativeBootstrap90: { lower: 0, upper: 0 },
  tost: { lowerP: 0, upperP: 0 },
  estimatedPower: 1,
  equivalent: true,
};

const decision: InjectionSuiteCampaignDecision = {
  schemaVersion: 1,
  modelProfileHashes: ["profile-a", "profile-b"],
  baseDecisions: ["SUPPORTED", "SUPPORTED"],
  utilityEquivalent: [true, true],
  adaptiveDecisions: [],
  h5: "SUPPORTED",
  h5d: "NOT_RUN",
  recommendedCoreMode: "fencing",
};

test("H5 report emits bound Markdown, CSV, SVG, and manifest", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "h5-report-"));
  try {
    await writeInjectionSuiteReport({
      outputDir,
      decision,
      base: [analysis("profile-a"), analysis("profile-b")],
      utility: [utility, utility],
      adaptive: [],
    });
    const report = await readFile(path.join(outputDir, "paper", "report.md"), "utf8");
    const csv = await readFile(path.join(outputDir, "paper", "tables", "family-results.csv"), "utf8");
    const svg = await readFile(path.join(outputDir, "paper", "figures", "block-rates.svg"), "utf8");
    const manifest = JSON.parse(
      await readFile(path.join(outputDir, "paper", "report-manifest.json"), "utf8"),
    );
    assert.match(report, /Recommended core mode: \*\*fencing\*\*/);
    assert.match(report, /blocked this frozen canary suite/);
    assert.match(csv, /^model_profile,family,/);
    assert.match(svg, /<svg/);
    assert.deepEqual(Object.keys(manifest.artifacts).sort(), [
      "figures/block-rates.svg",
      "report.md",
      "tables/family-results.csv",
    ]);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
