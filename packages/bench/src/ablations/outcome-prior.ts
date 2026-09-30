/**
 * H1 outcome-prior scaffold (issue #1958).
 *
 * Loads the frozen arm fixtures and decision rule, and evaluates one paired
 * recall comparison with `packages/bench/src/stats/*`. `--gates` checks the
 * committed CI snapshot. This module does not draw epochs or write result
 * JSONL, and it refuses `--phase warm`, `--phase pilot`, and `--phase main`.
 *
 * TODO(#1958): the preregistered paired shuffle test and the Holm correction
 * across pick-stage weights are not implemented here. Callers pass a shuffle
 * p-value when they have one; a missing p-value stays not-estimable.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pairedDeltaConfidenceInterval, type BootstrapOptions } from "../stats/bootstrap.js";
import { cohensD } from "../stats/effect-size.js";
import { runOutcomePriorPreMainGates } from "./outcome-prior-gates.js";

export const OUTCOME_PRIOR_CLI_COMMAND = "remnic bench ablate outcome-prior";

const ARM_KEYS = Object.freeze([
  "schemaVersion",
  "id",
  "role",
  "outcomeBoostWeight",
  "retrieval",
  "configOverrides",
] as const);

const H1_OVERRIDE_KEYS = Object.freeze([
  "outcomeBoostEnabled",
  "outcomeBoostWeight",
  "recallMemoryWorthFilterEnabled",
  "trustScoreEnabled",
  "boostAccessCount",
  "reinforcementRecallBoostEnabled",
  "recencyWeight",
] as const);

const MEMORY_WORTH_OVERRIDE_KEYS = Object.freeze([
  "recallMemoryWorthFilterEnabled",
  "outcomeBoostEnabled",
  "outcomeBoostWeight",
] as const);

const PICK_WEIGHTS = Object.freeze([0.15, 0.3, 0.5] as const);
const H1_WEIGHTS = Object.freeze([0, 0.15, 0.3, 0.5] as const);
const REFUSED_PHASES = Object.freeze(["warm", "pilot", "main"] as const);

export type OutcomePriorArmRole = "h1-arm" | "memory-worth-base";

export interface OutcomePriorArm {
  schemaVersion: 1;
  id: string;
  role: OutcomePriorArmRole;
  outcomeBoostWeight: number;
  retrieval: { k: number; contextCapTokens: number };
  configOverrides: Record<string, number | boolean>;
}

export interface OutcomePriorDecisionRule {
  schemaVersion: 1;
  ruleId: string;
  controllingIssue: 1958;
  controllingComment: string;
  clock: {
    warmEpochs: [1, 8];
    pickEpochs: [9, 10];
    lockedEpochs: [11, 12];
    pickWeights: [0.15, 0.3, 0.5];
  };
  primaryMetric: "recall@k";
  h1b: "NOT RUN";
  thresholds: {
    minRelativeGain: 0.05;
    confidenceLevel: 0.95;
    ciLowerStrictlyAbove: 0;
    alpha: 0.05;
  };
  analysis: {
    bootstrapDraws: 10000;
    pairing: "user-data-seed-run-seed";
    interval: "paired-bootstrap-grouped-by-user";
    significance: "paired-shuffle";
    pickStageMultiplicity: "holm";
  };
}

export interface H1ComparisonInput {
  candidateRecall: readonly number[];
  baselineRecall: readonly number[];
  rule: OutcomePriorDecisionRule;
  pValue?: number;
  bootstrap?: BootstrapOptions;
}

export interface H1ComparisonResult {
  relativeGain: number | null;
  confidenceInterval: { lower: number; upper: number; level: number } | null;
  cohensD: number | null;
  decision: "supported" | "rejected" | "not-estimable";
  reasons: string[];
}

export interface OutcomePriorScaffoldCliResult {
  ok: boolean;
  exitCode: number;
  runsExecuted: 0;
  h1b: "NOT RUN";
  armIds: string[];
  ruleId: string;
  message: string;
  gates?: {
    smokeHash: string;
    warmStoreHash: string;
    repeated: boolean;
    armOrderInvariant: boolean;
    warmStoreImmutable: boolean;
  };
}

function fixtureDir(): string {
  const candidates = [
    path.resolve(import.meta.dirname, "../../fixtures/h1-outcome"),
    path.resolve(import.meta.dirname, "../fixtures/h1-outcome"),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "decision-rule.json"))) return candidate;
  }
  throw new Error("h1-outcome fixtures are not installed next to @remnic/bench");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function own(raw: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(raw, key) ? raw[key] : undefined;
}

function assertExactKeys(raw: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const names = Object.getOwnPropertyNames(raw);
  for (const name of names) {
    if (!(allowed as readonly string[]).includes(name)) {
      throw new Error(`${label} has unexpected key ${JSON.stringify(name)}`);
    }
  }
  for (const name of allowed) {
    if (!Object.hasOwn(raw, name)) {
      throw new Error(`${label} is missing key ${JSON.stringify(name)}`);
    }
  }
}

function assertUnitWeight(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite number in [0, 1]`);
  }
  return value;
}

function assertPositiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function parseOutcomePriorArm(raw: unknown): OutcomePriorArm {
  if (!isPlainObject(raw)) throw new Error("outcome-prior arm must be a plain object");
  assertExactKeys(raw, ARM_KEYS, "outcome-prior arm");
  if (own(raw, "schemaVersion") !== 1) throw new Error("outcome-prior arm schemaVersion must be 1");
  const id = own(raw, "id");
  if (typeof id !== "string" || id.length === 0) throw new Error("outcome-prior arm id must be a non-empty string");
  const role = own(raw, "role");
  if (role !== "h1-arm" && role !== "memory-worth-base") {
    throw new Error("outcome-prior arm role must be h1-arm or memory-worth-base");
  }
  const outcomeBoostWeight = assertUnitWeight(own(raw, "outcomeBoostWeight"), "outcomeBoostWeight");
  const retrievalRaw = own(raw, "retrieval");
  if (!isPlainObject(retrievalRaw)) throw new Error("outcome-prior arm retrieval must be a plain object");
  assertExactKeys(retrievalRaw, ["k", "contextCapTokens"], "outcome-prior arm retrieval");
  const retrieval = {
    k: assertPositiveInt(own(retrievalRaw, "k"), "retrieval.k"),
    contextCapTokens: assertPositiveInt(own(retrievalRaw, "contextCapTokens"), "retrieval.contextCapTokens"),
  };
  const overridesRaw = own(raw, "configOverrides");
  if (!isPlainObject(overridesRaw)) throw new Error("outcome-prior arm configOverrides must be a plain object");
  const allowed = role === "h1-arm" ? H1_OVERRIDE_KEYS : MEMORY_WORTH_OVERRIDE_KEYS;
  assertExactKeys(overridesRaw, allowed, "outcome-prior arm configOverrides");
  const configOverrides: Record<string, number | boolean> = {};
  for (const key of allowed) {
    const value = own(overridesRaw, key);
    if (typeof value !== "boolean" && typeof value !== "number") {
      throw new Error(`outcome-prior arm configOverrides.${key} must be a boolean or number`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`outcome-prior arm configOverrides.${key} must be finite`);
    }
    configOverrides[key] = value;
  }
  if (role === "h1-arm") {
    if (configOverrides.outcomeBoostEnabled !== true) {
      throw new Error("h1 arm must set outcomeBoostEnabled true");
    }
    if (configOverrides.outcomeBoostWeight !== outcomeBoostWeight) {
      throw new Error("h1 arm outcomeBoostWeight must match configOverrides.outcomeBoostWeight");
    }
    if (configOverrides.recallMemoryWorthFilterEnabled !== false) {
      throw new Error("h1 arm must force recallMemoryWorthFilterEnabled false");
    }
    if (configOverrides.trustScoreEnabled !== false) {
      throw new Error("h1 arm must force trustScoreEnabled false");
    }
    if (configOverrides.boostAccessCount !== false) {
      throw new Error("h1 arm must force boostAccessCount false");
    }
    if (configOverrides.reinforcementRecallBoostEnabled !== false) {
      throw new Error("h1 arm must force reinforcementRecallBoostEnabled false");
    }
    if (configOverrides.recencyWeight !== 0) {
      throw new Error("h1 arm must force recencyWeight 0");
    }
  } else {
    if (outcomeBoostWeight !== 0 || configOverrides.outcomeBoostWeight !== 0) {
      throw new Error("memory-worth base arm must keep outcomeBoostWeight at 0");
    }
    if (configOverrides.outcomeBoostEnabled !== false) {
      throw new Error("memory-worth base arm must set outcomeBoostEnabled false");
    }
    if (configOverrides.recallMemoryWorthFilterEnabled !== true) {
      throw new Error("memory-worth base arm must set recallMemoryWorthFilterEnabled true");
    }
  }
  return {
    schemaVersion: 1,
    id,
    role,
    outcomeBoostWeight,
    retrieval,
    configOverrides,
  };
}

function assertEpochPair(value: unknown, start: number, end: number, label: string): void {
  if (!Array.isArray(value) || value.length !== 2 || value[0] !== start || value[1] !== end) {
    throw new Error(`${label} must be [${start}, ${end}]`);
  }
}

export function parseOutcomePriorDecisionRule(raw: unknown): OutcomePriorDecisionRule {
  if (!isPlainObject(raw)) throw new Error("outcome-prior decision rule must be a plain object");
  assertExactKeys(
    raw,
    [
      "schemaVersion",
      "ruleId",
      "controllingIssue",
      "controllingComment",
      "clock",
      "primaryMetric",
      "h1b",
      "thresholds",
      "analysis",
    ],
    "outcome-prior decision rule",
  );
  if (own(raw, "schemaVersion") !== 1) throw new Error("decision rule schemaVersion must be 1");
  if (own(raw, "ruleId") !== "h1-outcome-prior-decision-v1") {
    throw new Error("decision rule id must be h1-outcome-prior-decision-v1");
  }
  if (own(raw, "controllingIssue") !== 1958) throw new Error("decision rule controllingIssue must be 1958");
  const controllingComment = own(raw, "controllingComment");
  if (
    controllingComment !==
    "https://github.com/joshuaswarren/remnic/issues/1958#issuecomment-4998194342"
  ) {
    throw new Error("decision rule controllingComment must cite comment 4998194342");
  }
  if (own(raw, "primaryMetric") !== "recall@k") throw new Error("decision rule primary metric must be recall@k");
  if (own(raw, "h1b") !== "NOT RUN") throw new Error("decision rule h1b must be NOT RUN");
  const clockRaw = own(raw, "clock");
  if (!isPlainObject(clockRaw)) throw new Error("decision rule clock must be a plain object");
  assertExactKeys(clockRaw, ["warmEpochs", "pickEpochs", "lockedEpochs", "pickWeights"], "decision rule clock");
  const pickWeights = own(clockRaw, "pickWeights");
  if (!Array.isArray(pickWeights) || !sameNumbers(pickWeights, PICK_WEIGHTS)) {
    throw new Error("decision rule pickWeights must be 0.15, 0.30, 0.50");
  }
  const thresholdsRaw = own(raw, "thresholds");
  if (!isPlainObject(thresholdsRaw)) throw new Error("decision rule thresholds must be a plain object");
  assertExactKeys(
    thresholdsRaw,
    ["minRelativeGain", "confidenceLevel", "ciLowerStrictlyAbove", "alpha"],
    "decision rule thresholds",
  );
  if (own(thresholdsRaw, "minRelativeGain") !== 0.05) throw new Error("minRelativeGain must be 0.05");
  if (own(thresholdsRaw, "confidenceLevel") !== 0.95) throw new Error("confidenceLevel must be 0.95");
  if (own(thresholdsRaw, "ciLowerStrictlyAbove") !== 0) throw new Error("ciLowerStrictlyAbove must be 0");
  if (own(thresholdsRaw, "alpha") !== 0.05) throw new Error("alpha must be 0.05");
  const analysisRaw = own(raw, "analysis");
  if (!isPlainObject(analysisRaw)) throw new Error("decision rule analysis must be a plain object");
  assertExactKeys(
    analysisRaw,
    ["bootstrapDraws", "pairing", "interval", "significance", "pickStageMultiplicity"],
    "decision rule analysis",
  );
  if (own(analysisRaw, "bootstrapDraws") !== 10000) throw new Error("bootstrapDraws must be 10000");
  if (own(analysisRaw, "pairing") !== "user-data-seed-run-seed") {
    throw new Error("pairing must be user-data-seed-run-seed");
  }
  if (own(analysisRaw, "interval") !== "paired-bootstrap-grouped-by-user") {
    throw new Error("interval must be paired-bootstrap-grouped-by-user");
  }
  if (own(analysisRaw, "significance") !== "paired-shuffle") throw new Error("significance must be paired-shuffle");
  if (own(analysisRaw, "pickStageMultiplicity") !== "holm") throw new Error("pickStageMultiplicity must be holm");
  return {
    schemaVersion: 1,
    ruleId: "h1-outcome-prior-decision-v1",
    controllingIssue: 1958,
    controllingComment,
    clock: {
      warmEpochs: (assertEpochPair(own(clockRaw, "warmEpochs"), 1, 8, "warmEpochs"), [1, 8] as const),
      pickEpochs: (assertEpochPair(own(clockRaw, "pickEpochs"), 9, 10, "pickEpochs"), [9, 10] as const),
      lockedEpochs: (assertEpochPair(own(clockRaw, "lockedEpochs"), 11, 12, "lockedEpochs"), [11, 12] as const),
      pickWeights: [0.15, 0.3, 0.5],
    },
    primaryMetric: "recall@k",
    h1b: "NOT RUN",
    thresholds: {
      minRelativeGain: 0.05,
      confidenceLevel: 0.95,
      ciLowerStrictlyAbove: 0,
      alpha: 0.05,
    },
    analysis: {
      bootstrapDraws: 10000,
      pairing: "user-data-seed-run-seed",
      interval: "paired-bootstrap-grouped-by-user",
      significance: "paired-shuffle",
      pickStageMultiplicity: "holm",
    },
  };
}

export function loadOutcomePriorDecisionRule(): OutcomePriorDecisionRule {
  const filePath = path.join(fixtureDir(), "decision-rule.json");
  return parseOutcomePriorDecisionRule(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
}

export function loadOutcomePriorArms(): OutcomePriorArm[] {
  const dir = path.join(fixtureDir(), "arms");
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const arms = names.map((name) =>
    parseOutcomePriorArm(JSON.parse(readFileSync(path.join(dir, name), "utf8")) as unknown),
  );
  if (arms.length === 0) throw new Error("outcome-prior arm directory is empty");
  const ids = new Set<string>();
  const h1Weights: number[] = [];
  const first = arms[0]!;
  let memoryWorthCount = 0;
  for (const arm of arms) {
    if (ids.has(arm.id)) throw new Error(`duplicate outcome-prior arm id ${arm.id}`);
    ids.add(arm.id);
    if (arm.retrieval.k !== first.retrieval.k || arm.retrieval.contextCapTokens !== first.retrieval.contextCapTokens) {
      throw new Error("outcome-prior arms must share one retrieval budget");
    }
    if (arm.role === "h1-arm") h1Weights.push(arm.outcomeBoostWeight);
    else memoryWorthCount += 1;
  }
  h1Weights.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (!sameNumbers(h1Weights, H1_WEIGHTS)) {
    throw new Error("h1 arms must be exactly weights 0, 0.15, 0.30, and 0.50");
  }
  if (memoryWorthCount !== 1) throw new Error("outcome-prior fixtures must include one memory-worth base arm");
  return arms;
}

function mean(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

export function evaluateH1Decision(input: H1ComparisonInput): H1ComparisonResult {
  const reasons: string[] = [];
  const candidate = input.candidateRecall;
  const baseline = input.baselineRecall;
  const estimable =
    candidate.length > 0 &&
    candidate.length === baseline.length &&
    candidate.every((value) => Number.isFinite(value)) &&
    baseline.every((value) => Number.isFinite(value)) &&
    mean(baseline) > 0;
  if (!estimable) {
    return {
      relativeGain: null,
      confidenceInterval: null,
      cohensD: null,
      decision: "not-estimable",
      reasons: ["paired recall arrays are empty, mismatched, non-finite, or the baseline mean is not positive"],
    };
  }
  const relativeGain = (mean(candidate) - mean(baseline)) / mean(baseline);
  const confidenceInterval = pairedDeltaConfidenceInterval(
    [...candidate],
    [...baseline],
    input.bootstrap ?? { iterations: input.rule.analysis.bootstrapDraws, level: input.rule.thresholds.confidenceLevel },
  );
  const effect = cohensD([...candidate], [...baseline]);
  if (!(relativeGain >= input.rule.thresholds.minRelativeGain)) {
    reasons.push("relative gain is below 5%");
  }
  if (!(confidenceInterval.lower > input.rule.thresholds.ciLowerStrictlyAbove)) {
    reasons.push("95% interval does not stay strictly above 0");
  }
  const pValue = input.pValue;
  const pReady = typeof pValue === "number" && Number.isFinite(pValue) && pValue >= 0 && pValue <= 1;
  if (!pReady) reasons.push("paired shuffle p-value is missing");
  else if (!(pValue < input.rule.thresholds.alpha)) reasons.push("paired shuffle p-value is not below 0.05");
  if (!pReady && reasons.length === 1) {
    return { relativeGain, confidenceInterval, cohensD: effect, decision: "not-estimable", reasons };
  }
  if (reasons.length > 0) {
    return { relativeGain, confidenceInterval, cohensD: effect, decision: "rejected", reasons };
  }
  return { relativeGain, confidenceInterval, cohensD: effect, decision: "supported", reasons };
}

function refusedPhase(argv: readonly string[]): (typeof REFUSED_PHASES)[number] | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--phase") {
      const value = argv[index + 1];
      if (value === "warm" || value === "pilot" || value === "main") return value;
    }
    if (token.startsWith("--phase=")) {
      const value = token.slice("--phase=".length);
      if (value === "warm" || value === "pilot" || value === "main") return value;
    }
  }
  return undefined;
}

function wantsPreMainGates(argv: readonly string[]): boolean {
  return argv.includes("--gates");
}

export async function runOutcomePriorScaffoldCli(
  argv: readonly string[],
): Promise<OutcomePriorScaffoldCliResult> {
  const phase = refusedPhase(argv);
  if (phase) {
    return {
      ok: false,
      exitCode: 2,
      runsExecuted: 0,
      h1b: "NOT RUN",
      armIds: [],
      ruleId: "",
      message: `refusing phase ${phase}: scaffolding only — no experiment runs`,
    };
  }
  const arms = loadOutcomePriorArms();
  const rule = loadOutcomePriorDecisionRule();
  if (!wantsPreMainGates(argv)) {
    return {
      ok: true,
      exitCode: 0,
      runsExecuted: 0,
      h1b: rule.h1b,
      armIds: arms.map((arm) => arm.id),
      ruleId: rule.ruleId,
      message: "scaffolding only — no experiment runs",
    };
  }
  const gates = await runOutcomePriorPreMainGates(arms);
  return {
    ok: gates.ok,
    exitCode: gates.ok ? 0 : 1,
    runsExecuted: 0,
    h1b: rule.h1b,
    armIds: arms.map((arm) => arm.id),
    ruleId: rule.ruleId,
    message: gates.ok
      ? "pre-main gates passed — no experiment runs"
      : `pre-main gates failed: ${gates.reasons.join("; ")}`,
    gates: {
      smokeHash: gates.smokeHash,
      warmStoreHash: gates.warmStoreHash,
      repeated: gates.repeated,
      armOrderInvariant: gates.armOrderInvariant,
      warmStoreImmutable: gates.warmStoreImmutable,
    },
  };
}
