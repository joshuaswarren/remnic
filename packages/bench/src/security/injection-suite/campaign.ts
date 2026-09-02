import { writeFileAtomically } from "@remnic/core/maintenance/atomic-file";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { analyzeInjectionSuiteRun, type InjectionSuiteStatisticalAnalysis } from "./stats.js";
import { writeInjectionSuiteReport } from "./report.js";
import type { InjectionSuiteUtilityAnalysis } from "./utility-stats.js";

export interface InjectionSuiteCampaignDecision {
  schemaVersion: 1;
  modelProfileHashes: string[];
  baseDecisions: string[];
  utilityEquivalent: Array<boolean | null>;
  adaptiveDecisions: string[];
  h5: "SUPPORTED" | "REJECTED" | "NOT_ESTIMABLE";
  h5d: "SUPPORTED" | "REJECTED" | "NOT_ESTIMABLE" | "NOT_RUN";
  recommendedCoreMode: "fencing" | "layered" | null;
}

export function decideInjectionSuiteCampaignResults(
  base: readonly InjectionSuiteStatisticalAnalysis[],
  utility: readonly InjectionSuiteUtilityAnalysis[],
  adaptive: readonly InjectionSuiteStatisticalAnalysis[] = [],
): InjectionSuiteCampaignDecision {
  if (base.length !== 2) throw new Error("H5 campaign requires exactly two base model runs");
  if (utility.length !== 2) throw new Error("H5 campaign requires exactly two utility analyses");
  if (adaptive.length !== 0 && adaptive.length !== 2) {
    throw new Error("H5 adaptive campaign requires zero or two model runs");
  }
  const profiles = base.map((analysis) => analysis.modelProfileHash);
  if (new Set(profiles).size !== 2) throw new Error("H5 campaign model profiles must be distinct");
  const baseNotEstimable = base.some((analysis) => analysis.decision === "NOT_ESTIMABLE");
  const utilityNotEquivalent = utility.some((analysis) => analysis.equivalent !== true);
  let h5: InjectionSuiteCampaignDecision["h5"];
  if (baseNotEstimable || utilityNotEquivalent) {
    h5 = "REJECTED";
  } else if (base.every((analysis) => analysis.decision === "SUPPORTED")) {
    h5 = "SUPPORTED";
  } else {
    h5 = "REJECTED";
  }

  let h5d: InjectionSuiteCampaignDecision["h5d"];
  if (adaptive.length === 0) h5d = "NOT_RUN";
  else if (adaptive.some((analysis) => analysis.decision === "NOT_ESTIMABLE")) h5d = "NOT_ESTIMABLE";
  else h5d = adaptive.every((analysis) => analysis.decision === "SUPPORTED")
    ? "SUPPORTED"
    : "REJECTED";
  const recommendedCoreMode: InjectionSuiteCampaignDecision["recommendedCoreMode"] =
    h5 === "SUPPORTED" ? "fencing" : null;
  return {
    schemaVersion: 1,
    modelProfileHashes: profiles,
    baseDecisions: base.map((analysis) => analysis.decision),
    utilityEquivalent: utility.map((analysis) => analysis.equivalent),
    adaptiveDecisions: adaptive.map((analysis) => analysis.decision),
    h5,
    h5d,
    recommendedCoreMode,
  };
}

export async function decideInjectionSuiteCampaign(input: {
  baseRunDirs: readonly string[];
  utilityStatisticsPaths: readonly string[];
  adaptiveRunDirs?: readonly string[];
  outputDir: string;
}): Promise<InjectionSuiteCampaignDecision> {
  const base = await Promise.all(input.baseRunDirs.map(analyzeInjectionSuiteRun));
  const utility = await Promise.all(input.utilityStatisticsPaths.map(async (file) =>
    JSON.parse(await readFile(file, "utf8")) as InjectionSuiteUtilityAnalysis));
  const adaptive = await Promise.all((input.adaptiveRunDirs ?? []).map(analyzeInjectionSuiteRun));
  const decision = decideInjectionSuiteCampaignResults(base, utility, adaptive);
  await writeFileAtomically(
    path.join(input.outputDir, "campaign-decision.json"),
    `${JSON.stringify(decision, null, 2)}\n`,
  );
  await writeInjectionSuiteReport({
    outputDir: input.outputDir,
    decision,
    base,
    utility,
    adaptive,
  });
  return decision;
}
