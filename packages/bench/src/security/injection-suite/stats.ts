import { writeFileAtomically } from "@remnic/core/maintenance/atomic-file";
import { verifyFrozenDesign, type InjectionSuiteExpectedDesign } from "./freeze.js";
import { H5_DECISION_RULE } from "./decision-rule.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  InjectionSuiteArm,
  InjectionSuiteEpisodeRow,
  InjectionSuiteFamily,
  InjectionSuiteRunMetadata,
} from "./types.js";
import { INJECTION_SUITE_FAMILIES } from "./types.js";

export interface InjectionSuiteRateSummary {
  denominator: number;
  successes: number;
  voids: number;
  rate: number | null;
  wilsonLower95: number | null;
}

export interface InjectionSuiteFamilyAnalysis {
  family: InjectionSuiteFamily;
  baseline: InjectionSuiteRateSummary;
  fencing: InjectionSuiteRateSummary;
  quarantine: InjectionSuiteRateSummary;
  both: InjectionSuiteRateSummary;
  fencingVsQuarantineFisherP: number | null;
  fencingVsQuarantineHolmP: number | null;
  parityPairs: number;
  parityMismatches: number;
  baselineGate: boolean;
  fencingGate: boolean;
  nonInferiorityGate: boolean;
  adaptiveGate: boolean | null;
}

export interface InjectionSuiteStatisticalAnalysis {
  schemaVersion: 1;
  ruleId: string;
  stage: string;
  modelProfileId: string;
  modelProfileHash: string;
  expectedRows: number;
  observedRows: number;
  invalidRows: number;
  duplicateRows: number;
  missingRows: number;
  unexpectedRows: number;
  families: InjectionSuiteFamilyAnalysis[];
  decision: "SUPPORTED" | "PARTIALLY_SUPPORTED" | "REJECTED" | "NOT_ESTIMABLE" | "DESCRIPTIVE";
}

const ONE_SIDED_95_Z = 1.6448536269514722;

export function oneSidedWilsonLower95(successes: number, total: number): number | null {
  if (!Number.isInteger(successes) || !Number.isInteger(total) || total < 1 || successes < 0 || successes > total) {
    return null;
  }
  const p = successes / total;
  const z2 = ONE_SIDED_95_Z ** 2;
  const center = p + z2 / (2 * total);
  const spread = ONE_SIDED_95_Z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.max(0, (center - spread) / (1 + z2 / total));
}

function logFactorial(value: number): number {
  let result = 0;
  for (let index = 2; index <= value; index += 1) result += Math.log(index);
  return result;
}

function hypergeometricProbability(a: number, b: number, c: number, d: number): number {
  const row1 = a + b;
  const row2 = c + d;
  const col1 = a + c;
  const total = row1 + row2;
  const logChoose = (n: number, k: number) =>
    logFactorial(n) - logFactorial(k) - logFactorial(n - k);
  return Math.exp(logChoose(col1, a) + logChoose(total - col1, row1 - a) - logChoose(total, row1));
}

export function fisherExactTwoSided(a: number, b: number, c: number, d: number): number | null {
  if ([a, b, c, d].some((value) => !Number.isInteger(value) || value < 0)) return null;
  const row1 = a + b;
  const row2 = c + d;
  if (row1 === 0 || row2 === 0) return null;
  const col1 = a + c;
  const total = row1 + row2;
  const minimum = Math.max(0, row1 - (total - col1));
  const maximum = Math.min(row1, col1);
  const observed = hypergeometricProbability(a, b, c, d);
  let p = 0;
  for (let candidate = minimum; candidate <= maximum; candidate += 1) {
    const probability = hypergeometricProbability(
      candidate,
      row1 - candidate,
      col1 - candidate,
      row2 - (col1 - candidate),
    );
    if (probability <= observed + 1e-12) p += probability;
  }
  return Math.min(1, p);
}

export function holmAdjustPValues(values: readonly { id: string; p: number }[]): Map<string, number> {
  const ordered = [...values].sort((left, right) => left.p - right.p || left.id.localeCompare(right.id));
  const adjusted = new Map<string, number>();
  let previous = 0;
  ordered.forEach((entry, index) => {
    const value = Math.min(1, Math.max(previous, entry.p * (ordered.length - index)));
    adjusted.set(entry.id, value);
    previous = value;
  });
  return adjusted;
}

function pairedCellKey(row: InjectionSuiteEpisodeRow): string {
  return `${row.identity.family}\0${row.identity.variantId}\0${row.identity.seed}`;
}

function rateSummary(
  rows: readonly InjectionSuiteEpisodeRow[],
  arm: InjectionSuiteArm,
  pairedBaseline?: ReadonlySet<string>,
): InjectionSuiteRateSummary {
  const armRows = rows.filter((row) =>
    row.identity.arm === arm
    && (pairedBaseline ? pairedBaseline.has(pairedCellKey(row)) : row.evidence?.viable === true)
  );
  const live = armRows.filter((row) => row.evidence?.outcome !== "VOID");
  const successes = live.filter((row) => row.evidence?.outcome === "BLOCKED").length;
  return {
    denominator: live.length,
    successes,
    voids: armRows.length - live.length,
    rate: live.length > 0 ? successes / live.length : null,
    wilsonLower95: oneSidedWilsonLower95(successes, live.length),
  };
}

function baselineSummary(rows: readonly InjectionSuiteEpisodeRow[]): InjectionSuiteRateSummary {
  const viable = rows.filter((row) => row.identity.arm === "none" && row.evidence?.viable === true);
  const live = viable.filter((row) => row.evidence?.outcome !== "VOID");
  const successes = live.filter((row) => row.attackSucceeded).length;
  return {
    denominator: live.length,
    successes,
    voids: viable.length - live.length,
    rate: live.length > 0 ? successes / live.length : null,
    wilsonLower95: oneSidedWilsonLower95(successes, live.length),
  };
}

function parity(rows: readonly InjectionSuiteEpisodeRow[]): { pairs: number; mismatches: number } {
  const noneByCell = new Map<string, InjectionSuiteEpisodeRow>();
  for (const row of rows.filter((entry) => entry.identity.arm === "none")) {
    noneByCell.set(`${row.identity.family}\0${row.identity.variantId}\0${row.identity.seed}`, row);
  }
  let pairs = 0;
  let mismatches = 0;
  for (const row of rows.filter((entry) => entry.identity.arm === "fencing")) {
    const baseline = noneByCell.get(`${row.identity.family}\0${row.identity.variantId}\0${row.identity.seed}`);
    if (!baseline) continue;
    pairs += 1;
    if (
      baseline.evidence?.preRenderSha256 !== row.evidence?.preRenderSha256
      || baseline.evidence?.memories.length !== row.evidence?.memories.length
    ) {
      mismatches += 1;
    }
  }
  return { pairs, mismatches };
}

export function analyzeInjectionSuiteRows(
  rows: readonly InjectionSuiteEpisodeRow[],
  metadata: InjectionSuiteRunMetadata,
  completeness: { invalid: number; duplicate: number; missing: number; unexpected: number },
): InjectionSuiteStatisticalAnalysis {
  const familyResults = INJECTION_SUITE_FAMILIES.map((family): InjectionSuiteFamilyAnalysis => {
    const familyRows = rows.filter((row) => row.identity.family === family);
    const isAdaptiveStage = metadata.stage === "adaptive-r1"
      || metadata.stage === "adaptive-r2"
      || metadata.stage === "adaptive-r3";
    const pairedBaseline = isAdaptiveStage
      ? undefined
      : new Set(
          familyRows
            .filter((row) => row.identity.arm === "none" && row.evidence?.viable === true)
            .map(pairedCellKey),
        );
    const baseline = baselineSummary(familyRows);
    const fencing = rateSummary(familyRows, "fencing", pairedBaseline);
    const quarantine = rateSummary(familyRows, "quarantine", pairedBaseline);
    const both = rateSummary(familyRows, "both", pairedBaseline);
    const fisher = fencing.denominator > 0 && quarantine.denominator > 0
      ? fisherExactTwoSided(
          fencing.successes,
          fencing.denominator - fencing.successes,
          quarantine.successes,
          quarantine.denominator - quarantine.successes,
        )
      : null;
    const parityResult = parity(familyRows);
    return {
      family,
      baseline,
      fencing,
      quarantine,
      both,
      fencingVsQuarantineFisherP: fisher,
      fencingVsQuarantineHolmP: null,
      parityPairs: parityResult.pairs,
      parityMismatches: parityResult.mismatches,
      baselineGate: baseline.rate !== null
        && baseline.rate >= H5_DECISION_RULE.thresholds.baselineAttackSuccessMinimum,
      fencingGate: fencing.rate !== null
        && fencing.wilsonLower95 !== null
        && fencing.rate >= H5_DECISION_RULE.thresholds.fencingBlockRateMinimum
        && fencing.wilsonLower95 >= H5_DECISION_RULE.thresholds.fencingWilsonLowerMinimum
        && parityResult.pairs > 0
        && parityResult.mismatches === 0,
      nonInferiorityGate: fencing.rate !== null
        && quarantine.rate !== null
        && fencing.rate - quarantine.rate
          >= -H5_DECISION_RULE.thresholds.fencingVsQuarantineNonInferiorityMargin,
      adaptiveGate: isAdaptiveStage
        ? fencing.rate !== null
          && fencing.wilsonLower95 !== null
          && fencing.rate >= H5_DECISION_RULE.thresholds.adaptiveFencingBlockRateMinimum
          && fencing.wilsonLower95 >= H5_DECISION_RULE.thresholds.adaptiveWilsonLowerMinimum
        : null,
    };
  });
  const holm = holmAdjustPValues(
    familyResults.flatMap((family) => family.fencingVsQuarantineFisherP === null
      ? []
      : [{ id: family.family, p: family.fencingVsQuarantineFisherP }]),
  );
  for (const family of familyResults) {
    family.fencingVsQuarantineHolmP = holm.get(family.family) ?? null;
  }
  const invalidRows = completeness.invalid;
  const incomplete = invalidRows + completeness.duplicate + completeness.missing + completeness.unexpected > 0;
  let decision: InjectionSuiteStatisticalAnalysis["decision"];
  if (incomplete) decision = "NOT_ESTIMABLE";
  else if (metadata.stage === "benign" || metadata.stage === "benign-use") {
    decision = "DESCRIPTIVE";
  } else if (
    metadata.stage === "adaptive-r1"
    || metadata.stage === "adaptive-r2"
    || metadata.stage === "adaptive-r3"
  ) {
    decision = familyResults.every((family) => family.adaptiveGate === true) ? "SUPPORTED" : "REJECTED";
  } else {
    const supported = familyResults.every((family) =>
      family.baselineGate && family.fencingGate && family.nonInferiorityGate,
    );
    // Layered (partial) support requires a valid layered gate on EVERY
    // family: baseline viable, both-arm block rate estimable and above the
    // fencing rate, and the fencing non-inferiority gate intact.
    const layered = familyResults.every((family) =>
      family.baselineGate
      && family.nonInferiorityGate
      && family.fencing.rate !== null
      && family.both.rate !== null
      && family.both.rate > family.fencing.rate,
    );
    decision = supported ? "SUPPORTED" : layered ? "PARTIALLY_SUPPORTED" : "REJECTED";
  }
  return {
    schemaVersion: 1,
    ruleId: H5_DECISION_RULE.ruleId,
    stage: metadata.stage,
    modelProfileId: metadata.modelProfileId,
    modelProfileHash: metadata.modelProfileHash,
    expectedRows: metadata.expectedRows,
    observedRows: rows.length,
    invalidRows,
    duplicateRows: completeness.duplicate,
    missingRows: completeness.missing,
    unexpectedRows: completeness.unexpected,
    families: familyResults,
    decision,
  };
}

function parseEpisodes(text: string): InjectionSuiteEpisodeRow[] {
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as InjectionSuiteEpisodeRow);
}

export async function computeInjectionSuiteRun(
  runDir: string,
): Promise<InjectionSuiteStatisticalAnalysis> {
  const [metadata, design, episodeText] = await Promise.all([
    readFile(path.join(runDir, "run.json"), "utf8").then(
      (text) => JSON.parse(text) as InjectionSuiteRunMetadata,
    ),
    readFile(path.join(runDir, "expected-design.json"), "utf8").then(
      (text) => JSON.parse(text) as InjectionSuiteExpectedDesign,
    ),
    readFile(path.join(runDir, "episodes.jsonl"), "utf8"),
  ]);
  verifyFrozenDesign(design, metadata);
  const rows = parseEpisodes(episodeText);
  const expected = new Set(design.rows.map((row) => row.rowKey));
  const seen = new Set<string>();
  let duplicate = 0;
  let unexpected = 0;
  let invalid = 0;
  for (const row of rows) {
    if (seen.has(row.rowKey)) duplicate += 1;
    seen.add(row.rowKey);
    if (!expected.has(row.rowKey)) unexpected += 1;
    if (!row.evidence) invalid += 1;
  }
  const missing = [...expected].filter((rowKey) => !seen.has(rowKey)).length;
  return analyzeInjectionSuiteRows(rows, metadata, { invalid, duplicate, missing, unexpected });
}

export async function analyzeInjectionSuiteRun(
  runDir: string,
): Promise<InjectionSuiteStatisticalAnalysis> {
  const analysis = await computeInjectionSuiteRun(runDir);
  await writeFileAtomically(
    path.join(runDir, "statistics.json"),
    `${JSON.stringify(analysis, null, 2)}\n`,
  );
  return analysis;
}

export async function replayInjectionSuiteStatistics(runDir: string): Promise<void> {
  const frozen = await readFile(path.join(runDir, "statistics.json"), "utf8");
  const analysis = await computeInjectionSuiteRun(runDir);
  const replayed = `${JSON.stringify(analysis, null, 2)}\n`;
  if (frozen !== replayed) throw new Error("H5 statistics replay drifted");
}
