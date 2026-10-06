/**
 * H2 write-vs-read scaffold (issue #1959).
 *
 * Loads the frozen arm fixtures, key allow-list, and decision rule. The
 * token-ledger matcher and `evaluateH2Decision` are pure. This module does
 * not draw a bootstrap, run a permutation test, or write a result file.
 * `WRITE_VS_READ_RUNS_ENABLED` stays false. `--phase warm`, `--phase pilot`,
 * and `--phase main` are refused, as are `--seeds` and `--corpus`. Any other
 * flag, a repeated flag, or a phase outside that set is rejected.
 * `runWriteVsReadScaffoldCli` stays synchronous and runs nothing.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { AttributionClass } from "../attribution.js";
import { createSeededRandom } from "../seeded-random.js";
import { type BootstrapOptions, pairedDeltaConfidenceInterval } from "../stats/bootstrap.js";
import { cohensD } from "../stats/effect-size.js";

export const WRITE_VS_READ_RUNS_ENABLED = false;
export const WRITE_VS_READ_CLI_COMMAND = "remnic bench ablate write-vs-read";

const ARM_FILES = Object.freeze([
  "baseline.json",
  "write-plus.json",
  "read-plus.json",
  "write-read-plus.json",
] as const);

const ARM_IDS = Object.freeze(["baseline", "write-plus", "read-plus", "write-read-plus"] as const);

const WRITE_KEYS = Object.freeze([
  "consolidateEveryN",
  "entityAliasesEnabled",
  "extractionJudgeEnabled",
  "semanticDedupCandidates",
  "semanticDedupEnabled",
  "semanticMerge",
] as const);

const READ_KEYS = Object.freeze([
  "qmdMaxResults",
  "qmdSearchStrategy",
  "queryExpansionEnabled",
  "queryExpansionMaxQueries",
  "recallMmrEnabled",
  "recallPlannerMaxQmdResultsFull",
  "rerankEnabled",
] as const);

const HELD_CONSTANT = Object.freeze({
  boostAccessCount: true,
  extractionJudgeBatchSize: 20,
  extractionJudgeShadow: false,
  maxMemoryTokens: 2000,
  outcomeBoostEnabled: false,
  outcomeBoostWeight: 0,
  queryExpansionMinTokenLen: 3,
  recallMemoryWorthFilterEnabled: true,
  recallMmrLambda: 0.7,
  recallMmrTopN: 40,
  recencyWeight: 0.2,
  reinforcementRecallBoostEnabled: false,
  rerankMaxCandidates: 20,
  semanticDedupThreshold: 0.92,
  trustScoreEnabled: false,
});

const SEMANTIC_MERGE_OFF = Object.freeze({ enabled: false });
const SEMANTIC_MERGE_ON = Object.freeze({ enabled: true });

const LOW_WRITE = Object.freeze({
  consolidateEveryN: 1000000,
  entityAliasesEnabled: false,
  extractionJudgeEnabled: false,
  semanticDedupCandidates: 0,
  semanticDedupEnabled: false,
  semanticMerge: SEMANTIC_MERGE_OFF,
});

const RAISED_WRITE = Object.freeze({
  consolidateEveryN: 2,
  entityAliasesEnabled: true,
  extractionJudgeEnabled: true,
  semanticDedupCandidates: 5,
  semanticDedupEnabled: true,
  semanticMerge: SEMANTIC_MERGE_ON,
});

const LOW_READ = Object.freeze({
  qmdMaxResults: 8,
  qmdSearchStrategy: "lex",
  queryExpansionEnabled: false,
  queryExpansionMaxQueries: 0,
  recallMmrEnabled: false,
  recallPlannerMaxQmdResultsFull: 8,
  rerankEnabled: false,
});

const RAISED_READ = Object.freeze({
  qmdMaxResults: 16,
  qmdSearchStrategy: "hybrid",
  queryExpansionEnabled: true,
  queryExpansionMaxQueries: 4,
  recallMmrEnabled: true,
  recallPlannerMaxQmdResultsFull: 16,
  rerankEnabled: true,
});

const FAILURE_LABELS = Object.freeze([
  "extraction_miss",
  "index_miss",
  "retrieval_miss",
  "use_miss",
  "unresolved",
] as const);

const LEDGER_STAGES = Object.freeze([
  "extract",
  "judge",
  "dedup",
  "novelty",
  "merge",
  "entity",
  "query-rewrite",
  "rerank",
  "model-led-search",
] as const);

const LEDGER_STATES = Object.freeze(["ok", "failed"] as const);
const REFUSED_PHASES = Object.freeze(["warm", "pilot", "main"] as const);
const SUMMARY_KEYS = Object.freeze(["datasetId", "relativeGain", "holmAdjustedP", "fixedTestsPass"] as const);
const CONTROLLING_COMMENT = "https://github.com/joshuaswarren/remnic/issues/1959#issuecomment-4998197561";

export type WriteVsReadArmId = (typeof ARM_IDS)[number];
export type H2FailureLabel = (typeof FAILURE_LABELS)[number];
export type LedgerStage = (typeof LEDGER_STAGES)[number];
export type H2Decision = "SUPPORTED" | "REGIME-DEPENDENT" | "REJECTED" | "NOT-SUPPORTED";
export type ComputeMatchLabel = "matched" | "UNMATCHED";

// @ts-expect-error "bogus" is not an H2 decision
const h2DecisionPin: H2Decision = "bogus";
void h2DecisionPin;

export interface WriteVsReadAllowList {
  schemaVersion: 1;
  writeKeys: readonly string[];
  readKeys: readonly string[];
  heldConstant: Readonly<Record<string, boolean | number>>;
}

export interface WriteVsReadArm {
  schemaVersion: 1;
  id: WriteVsReadArmId;
  role: WriteVsReadArmId;
  armCall: string;
  allTestFlagsOn: boolean;
  matchesReleaseConfig: false;
  configOverrides: Record<string, ConfigValue>;
}

export interface WriteVsReadDecisionRule {
  schemaVersion: 1;
  ruleId: "h2-write-vs-read-decision-v1";
  controllingIssue: 1959;
  controllingComment: string;
  primaryComparison: "write-plus-vs-read-plus";
  sideTests: readonly string[];
  requiredMainDatasets: readonly ["locomo", "drift-gen"];
  laterChecks: readonly string[];
  onePassOutcome: "REGIME-DEPENDENT";
  minRelativeGain: 0.05;
  alpha: 0.05;
  correction: "holm";
  computeMatchTolerance: 0.1;
  unmatchedLabel: "UNMATCHED";
  bootstrapDraws: 10000;
  pairingKeys: readonly string[];
  groupBootstrapBy: "generated-chat";
  effectSizes: readonly string[];
  failureLabels: readonly H2FailureLabel[];
  calibrationMinAccuracy: 0.9;
  supersededWinRule: "at-least-one-corpus";
}

export interface H2DatasetSummary {
  datasetId: string;
  relativeGain: number;
  holmAdjustedP: number;
  fixedTestsPass: boolean;
}

export interface MemoryWorkTokenLedgerRow {
  item: string;
  corpus: string;
  dataSeed: number;
  runSeed: number;
  arm: string;
  stage: LedgerStage;
  callId: string;
  provider: string;
  model: string;
  promptTokens: number;
  outputTokens: number;
  cacheTokens: number;
  timeMs: number;
  state: "ok" | "failed";
  error: string | null;
  tryCount: number;
}

export interface ComputeMatch {
  relativeGap: number;
  label: ComputeMatchLabel;
}

export interface PairedGainSummary {
  confidenceInterval: { lower: number; upper: number; level: number };
  cohensD: number;
}

export interface WriteVsReadScaffoldCliResult {
  ok: boolean;
  exitCode: number;
  runsExecuted: 0;
  armIds: string[];
  arms: WriteVsReadArm[] | null;
  ruleId: string;
  decisionRule: WriteVsReadDecisionRule | null;
  allowList: {
    writeKeys: string[];
    readKeys: string[];
    heldKeys: string[];
    heldConstant: Record<string, boolean | number>;
  } | null;
  runsEnabled: boolean;
  message: string;
}

type ConfigValue = boolean | number | string | { readonly enabled: boolean };

function fixtureDir(): string {
  const candidates = [
    path.resolve(import.meta.dirname, "../../fixtures/h2-write-vs-read"),
    path.resolve(import.meta.dirname, "../fixtures/h2-write-vs-read"),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "decision-rule.json"))) return candidate;
  }
  throw new Error("h2-write-vs-read fixtures are not installed next to @remnic/bench");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function own(raw: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(raw, key) ? raw[key] : undefined;
}

function sameConfigValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftNames = Object.getOwnPropertyNames(left).sort(compareStrings);
  const rightNames = Object.getOwnPropertyNames(right).sort(compareStrings);
  if (leftNames.length !== rightNames.length) return false;
  for (let index = 0; index < leftNames.length; index += 1) {
    const leftName = leftNames[index];
    const rightName = rightNames[index];
    if (leftName === undefined || leftName !== rightName) return false;
    if (!sameConfigValue(own(left, leftName), own(right, leftName))) return false;
  }
  return true;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
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

function assertStringList(value: unknown, expected: readonly string[], label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  if (!sameStrings(value, expected)) {
    throw new Error(`${label} does not match the frozen list`);
  }
  return [...expected];
}

function assertExactText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty string with no surrounding whitespace`);
  }
  return value;
}

function assertFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function assertIntegerAtLeast(value: unknown, label: string, minimum: number): number {
  const number = assertFiniteNumber(value, label);
  if (!Number.isInteger(number) || number < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
  return number;
}

function runsAreDisabled(): boolean {
  const enabled: boolean = WRITE_VS_READ_RUNS_ENABLED;
  return enabled === false;
}

function profileFor(role: WriteVsReadArmId): Record<string, ConfigValue> {
  const write = role === "write-plus" || role === "write-read-plus" ? RAISED_WRITE : LOW_WRITE;
  const read = role === "read-plus" || role === "write-read-plus" ? RAISED_READ : LOW_READ;
  return { ...write, ...read, ...HELD_CONSTANT };
}

function overrideKeys(allow: WriteVsReadAllowList): string[] {
  return [...allow.writeKeys, ...allow.readKeys, ...Object.getOwnPropertyNames(allow.heldConstant)];
}

export function parseWriteVsReadAllowList(raw: unknown): WriteVsReadAllowList {
  if (!isPlainObject(raw)) throw new Error("write-vs-read allow-list must be a plain object");
  assertExactKeys(raw, ["schemaVersion", "writeKeys", "readKeys", "heldConstant"], "write-vs-read allow-list");
  if (own(raw, "schemaVersion") !== 1) throw new Error("allow-list schemaVersion must be 1");
  const writeKeys = assertStringList(own(raw, "writeKeys"), WRITE_KEYS, "writeKeys");
  const readKeys = assertStringList(own(raw, "readKeys"), READ_KEYS, "readKeys");
  const heldRaw = own(raw, "heldConstant");
  if (!isPlainObject(heldRaw)) throw new Error("heldConstant must be a plain object");
  assertExactKeys(heldRaw, Object.getOwnPropertyNames(HELD_CONSTANT), "heldConstant");
  const heldConstant: Record<string, boolean | number> = {};
  for (const key of Object.getOwnPropertyNames(HELD_CONSTANT)) {
    const expected = HELD_CONSTANT[key as keyof typeof HELD_CONSTANT];
    const value = own(heldRaw, key);
    if (typeof expected === "boolean") {
      if (value !== expected) throw new Error(`heldConstant.${key} must be ${expected}`);
      heldConstant[key] = expected;
      continue;
    }
    const number = assertFiniteNumber(value, `heldConstant.${key}`);
    if (!Object.is(number, expected)) throw new Error(`heldConstant.${key} must be ${expected}`);
    heldConstant[key] = number;
  }
  return { schemaVersion: 1, writeKeys, readKeys, heldConstant };
}

export function parseWriteVsReadArm(raw: unknown, allow: WriteVsReadAllowList): WriteVsReadArm {
  if (!isPlainObject(raw)) throw new Error("write-vs-read arm must be a plain object");
  assertExactKeys(
    raw,
    ["schemaVersion", "id", "role", "armCall", "allTestFlagsOn", "matchesReleaseConfig", "configOverrides"],
    "write-vs-read arm"
  );
  if (own(raw, "schemaVersion") !== 1) throw new Error("write-vs-read arm schemaVersion must be 1");
  const id = own(raw, "id");
  if (!(ARM_IDS as readonly string[]).includes(typeof id === "string" ? id : "")) {
    throw new Error("write-vs-read arm id must be baseline, write-plus, read-plus, or write-read-plus");
  }
  const role = own(raw, "role");
  if (role !== id) throw new Error("write-vs-read arm role must equal id");
  const armId = id as WriteVsReadArmId;
  const armCall = own(raw, "armCall");
  const expectedCall = armId === "write-read-plus" ? "all test flags on" : armId;
  if (armCall !== expectedCall) throw new Error(`armCall must be ${JSON.stringify(expectedCall)}`);
  const allTestFlagsOn = own(raw, "allTestFlagsOn");
  if (typeof allTestFlagsOn !== "boolean" || allTestFlagsOn !== (armId === "write-read-plus")) {
    throw new Error("allTestFlagsOn must be true only on write-read-plus");
  }
  if (own(raw, "matchesReleaseConfig") !== false) {
    throw new Error("matchesReleaseConfig must be false");
  }
  const overridesRaw = own(raw, "configOverrides");
  if (!isPlainObject(overridesRaw)) throw new Error("configOverrides must be a plain object");
  const allowed = overrideKeys(allow);
  assertExactKeys(overridesRaw, allowed, "configOverrides");
  const expected = profileFor(armId);
  const configOverrides: Record<string, ConfigValue> = {};
  for (const key of allowed) {
    if (!Object.hasOwn(expected, key)) throw new Error(`unclassified config key ${JSON.stringify(key)}`);
    const wanted = expected[key];
    const value = own(overridesRaw, key);
    if (isPlainObject(wanted)) {
      if (!isPlainObject(value)) throw new Error(`configOverrides.${key} must be an object`);
      assertExactKeys(value, ["enabled"], `configOverrides.${key}`);
      const enabled = own(value, "enabled");
      if (typeof enabled !== "boolean") {
        throw new Error(`configOverrides.${key}.enabled must be a boolean`);
      }
      const parsed = { enabled };
      if (!sameConfigValue(parsed, wanted)) {
        throw new Error(`configOverrides.${key} must be ${JSON.stringify(wanted)} on ${armId}`);
      }
      configOverrides[key] = parsed;
      continue;
    }
    if (typeof wanted === "boolean") {
      if (typeof value !== "boolean") throw new Error(`configOverrides.${key} must be a boolean`);
    } else if (typeof wanted === "string") {
      if (value !== "lex" && value !== "hybrid") {
        throw new Error(`configOverrides.${key} must be lex or hybrid`);
      }
    } else if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error(`configOverrides.${key} must be a finite number`);
    } else if (Number.isInteger(wanted) && !Number.isInteger(value)) {
      throw new Error(`configOverrides.${key} must be an integer`);
    }
    if (!sameConfigValue(value, wanted)) {
      throw new Error(`configOverrides.${key} must be ${JSON.stringify(wanted)} on ${armId}`);
    }
    configOverrides[key] = value as ConfigValue;
  }
  return {
    schemaVersion: 1,
    id: armId,
    role: armId,
    armCall: expectedCall,
    allTestFlagsOn,
    matchesReleaseConfig: false,
    configOverrides,
  };
}

export function parseWriteVsReadDecisionRule(raw: unknown): WriteVsReadDecisionRule {
  if (!isPlainObject(raw)) throw new Error("write-vs-read decision rule must be a plain object");
  assertExactKeys(
    raw,
    [
      "schemaVersion",
      "ruleId",
      "controllingIssue",
      "controllingComment",
      "primaryComparison",
      "sideTests",
      "requiredMainDatasets",
      "laterChecks",
      "onePassOutcome",
      "minRelativeGain",
      "alpha",
      "correction",
      "computeMatchTolerance",
      "unmatchedLabel",
      "bootstrapDraws",
      "pairingKeys",
      "groupBootstrapBy",
      "effectSizes",
      "failureLabels",
      "calibrationMinAccuracy",
      "supersededWinRule",
    ],
    "write-vs-read decision rule"
  );
  if (own(raw, "schemaVersion") !== 1) throw new Error("decision rule schemaVersion must be 1");
  if (own(raw, "ruleId") !== "h2-write-vs-read-decision-v1") {
    throw new Error("decision rule id must be h2-write-vs-read-decision-v1");
  }
  if (own(raw, "controllingIssue") !== 1959) throw new Error("decision rule controllingIssue must be 1959");
  if (own(raw, "controllingComment") !== CONTROLLING_COMMENT) {
    throw new Error("decision rule controllingComment must cite comment 4998197561");
  }
  if (own(raw, "primaryComparison") !== "write-plus-vs-read-plus") {
    throw new Error("primaryComparison must be write-plus-vs-read-plus");
  }
  if (own(raw, "onePassOutcome") !== "REGIME-DEPENDENT") {
    throw new Error("onePassOutcome must be REGIME-DEPENDENT");
  }
  if (own(raw, "minRelativeGain") !== 0.05) throw new Error("minRelativeGain must be 0.05");
  if (own(raw, "alpha") !== 0.05) throw new Error("alpha must be 0.05");
  if (own(raw, "correction") !== "holm") throw new Error("correction must be holm");
  if (own(raw, "computeMatchTolerance") !== 0.1) throw new Error("computeMatchTolerance must be 0.10");
  if (own(raw, "unmatchedLabel") !== "UNMATCHED") throw new Error("unmatchedLabel must be UNMATCHED");
  if (own(raw, "bootstrapDraws") !== 10000) throw new Error("bootstrapDraws must be 10000");
  if (own(raw, "groupBootstrapBy") !== "generated-chat") {
    throw new Error("groupBootstrapBy must be generated-chat");
  }
  if (own(raw, "calibrationMinAccuracy") !== 0.9) throw new Error("calibrationMinAccuracy must be 0.90");
  if (own(raw, "supersededWinRule") !== "at-least-one-corpus") {
    throw new Error("supersededWinRule must be at-least-one-corpus");
  }
  return {
    schemaVersion: 1,
    ruleId: "h2-write-vs-read-decision-v1",
    controllingIssue: 1959,
    controllingComment: CONTROLLING_COMMENT,
    primaryComparison: "write-plus-vs-read-plus",
    sideTests: assertStringList(
      own(raw, "sideTests"),
      ["baseline", "write-read-plus", "stage-knockouts", "write-read-interaction"],
      "sideTests"
    ),
    requiredMainDatasets: assertStringList(
      own(raw, "requiredMainDatasets"),
      ["locomo", "drift-gen"],
      "requiredMainDatasets"
    ) as ["locomo", "drift-gen"],
    laterChecks: assertStringList(own(raw, "laterChecks"), ["longmemeval", "minteval", "memfail"], "laterChecks"),
    onePassOutcome: "REGIME-DEPENDENT",
    minRelativeGain: 0.05,
    alpha: 0.05,
    correction: "holm",
    computeMatchTolerance: 0.1,
    unmatchedLabel: "UNMATCHED",
    bootstrapDraws: 10000,
    pairingKeys: assertStringList(own(raw, "pairingKeys"), ["corpus", "data-seed", "run-seed"], "pairingKeys"),
    groupBootstrapBy: "generated-chat",
    effectSizes: assertStringList(own(raw, "effectSizes"), ["relative-delta", "cliffs-delta"], "effectSizes"),
    failureLabels: assertStringList(own(raw, "failureLabels"), FAILURE_LABELS, "failureLabels") as H2FailureLabel[],
    calibrationMinAccuracy: 0.9,
    supersededWinRule: "at-least-one-corpus",
  };
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

export function loadWriteVsReadAllowList(): WriteVsReadAllowList {
  return parseWriteVsReadAllowList(readJson(path.join(fixtureDir(), "write-read-key-allowlist.json")));
}

export function loadWriteVsReadDecisionRule(): WriteVsReadDecisionRule {
  return parseWriteVsReadDecisionRule(readJson(path.join(fixtureDir(), "decision-rule.json")));
}

function assertFactorial(arms: readonly WriteVsReadArm[], allow: WriteVsReadAllowList): void {
  const byId = new Map(arms.map((arm) => [arm.id, arm]));
  const baseline = byId.get("baseline");
  const writePlus = byId.get("write-plus");
  const readPlus = byId.get("read-plus");
  const both = byId.get("write-read-plus");
  if (!baseline || !writePlus || !readPlus || !both) throw new Error("write-vs-read arms are incomplete");
  for (const key of allow.writeKeys) {
    if (sameConfigValue(baseline.configOverrides[key], writePlus.configOverrides[key])) {
      throw new Error(`write key ${key} does not differ between baseline and write-plus`);
    }
    if (!sameConfigValue(baseline.configOverrides[key], readPlus.configOverrides[key])) {
      throw new Error(`write key ${key} differs between baseline and read-plus`);
    }
    if (!sameConfigValue(writePlus.configOverrides[key], both.configOverrides[key])) {
      throw new Error(`write key ${key} differs between write-plus and write-read-plus`);
    }
  }
  for (const key of allow.readKeys) {
    if (sameConfigValue(baseline.configOverrides[key], readPlus.configOverrides[key])) {
      throw new Error(`read key ${key} does not differ between baseline and read-plus`);
    }
    if (!sameConfigValue(baseline.configOverrides[key], writePlus.configOverrides[key])) {
      throw new Error(`read key ${key} differs between baseline and write-plus`);
    }
    if (!sameConfigValue(readPlus.configOverrides[key], both.configOverrides[key])) {
      throw new Error(`read key ${key} differs between read-plus and write-read-plus`);
    }
  }
  for (const key of Object.getOwnPropertyNames(allow.heldConstant)) {
    const expected = allow.heldConstant[key];
    for (const arm of arms) {
      if (!sameConfigValue(arm.configOverrides[key], expected)) {
        throw new Error(`held key ${key} drifted on ${arm.id}`);
      }
    }
  }
}

export function loadWriteVsReadArms(): WriteVsReadArm[] {
  const allow = loadWriteVsReadAllowList();
  const dir = path.join(fixtureDir(), "arms");
  const found = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort(compareStrings);
  const expected = [...ARM_FILES].sort(compareStrings);
  if (!sameStrings(found, expected)) {
    throw new Error("write-vs-read arm directory must contain exactly the four frozen arm files");
  }
  const arms = ARM_FILES.map((name) => parseWriteVsReadArm(readJson(path.join(dir, name)), allow));
  assertFactorial(arms, allow);
  return arms;
}

function allowMembership(allow: WriteVsReadAllowList): {
  mutable: Set<string>;
  held: Set<string>;
} {
  const held = new Set(Object.getOwnPropertyNames(allow.heldConstant));
  const mutable = new Set<string>([...allow.writeKeys, ...allow.readKeys]);
  return { mutable, held };
}

export function diffArmConfigOverrides(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  allow: WriteVsReadAllowList
): string[] {
  const { mutable, held } = allowMembership(allow);
  const names = new Set<string>([...Object.getOwnPropertyNames(left), ...Object.getOwnPropertyNames(right)]);
  const differing: string[] = [];
  for (const key of names) {
    const leftHas = Object.hasOwn(left, key);
    const rightHas = Object.hasOwn(right, key);
    const leftValue = leftHas ? left[key] : undefined;
    const rightValue = rightHas ? right[key] : undefined;
    if (leftHas && rightHas && sameConfigValue(leftValue, rightValue)) continue;
    if (held.has(key)) {
      throw new Error(`held-constant key ${JSON.stringify(key)} differs`);
    }
    if (!mutable.has(key)) {
      throw new Error(`key ${JSON.stringify(key)} differs outside the allow-list`);
    }
    differing.push(key);
  }
  differing.sort(compareStrings);
  return differing;
}

const LEDGER_KEYS = Object.freeze([
  "item",
  "corpus",
  "dataSeed",
  "runSeed",
  "arm",
  "stage",
  "callId",
  "provider",
  "model",
  "promptTokens",
  "outputTokens",
  "cacheTokens",
  "timeMs",
  "state",
  "error",
  "tryCount",
] as const);

export function parseMemoryWorkTokenLedgerRow(raw: unknown): MemoryWorkTokenLedgerRow {
  if (!isPlainObject(raw)) throw new Error("token ledger row must be a plain object");
  assertExactKeys(raw, LEDGER_KEYS, "token ledger row");
  const stage = own(raw, "stage");
  if (!(LEDGER_STAGES as readonly string[]).includes(typeof stage === "string" ? stage : "")) {
    throw new Error("token ledger stage is not in the memory-work list");
  }
  const state = own(raw, "state");
  if (!(LEDGER_STATES as readonly string[]).includes(typeof state === "string" ? state : "")) {
    throw new Error("token ledger state must be ok or failed");
  }
  const error = own(raw, "error");
  if (state === "ok") {
    if (error !== null) throw new Error("token ledger error must be null when state is ok");
  } else if (typeof error !== "string" || error.length === 0 || error !== error.trim()) {
    throw new Error("token ledger error must be a non-empty string when state is failed");
  }
  const timeMs = assertFiniteNumber(own(raw, "timeMs"), "timeMs");
  if (timeMs < 0) throw new Error("timeMs must be >= 0");
  return {
    item: assertExactText(own(raw, "item"), "item"),
    corpus: assertExactText(own(raw, "corpus"), "corpus"),
    dataSeed: assertIntegerAtLeast(own(raw, "dataSeed"), "dataSeed", 0),
    runSeed: assertIntegerAtLeast(own(raw, "runSeed"), "runSeed", 0),
    arm: assertExactText(own(raw, "arm"), "arm"),
    stage: stage as LedgerStage,
    callId: assertExactText(own(raw, "callId"), "callId"),
    provider: assertExactText(own(raw, "provider"), "provider"),
    model: assertExactText(own(raw, "model"), "model"),
    promptTokens: assertIntegerAtLeast(own(raw, "promptTokens"), "promptTokens", 0),
    outputTokens: assertIntegerAtLeast(own(raw, "outputTokens"), "outputTokens", 0),
    cacheTokens: assertIntegerAtLeast(own(raw, "cacheTokens"), "cacheTokens", 0),
    timeMs,
    state: state as "ok" | "failed",
    error: state === "ok" ? null : (error as string),
    tryCount: assertIntegerAtLeast(own(raw, "tryCount"), "tryCount", 1),
  };
}

export function classifyComputeMatch(relativeGap: number, tolerance = 0.1): ComputeMatchLabel {
  const gap = assertFiniteNumber(relativeGap, "compute-match gap");
  const limit = assertFiniteNumber(tolerance, "compute-match tolerance");
  if (gap < 0 || limit < 0) throw new Error("compute-match gap and tolerance must be >= 0");
  return gap <= limit ? "matched" : "UNMATCHED";
}

export function matchMemoryWorkTokens(left: number, right: number, tolerance = 0.1): ComputeMatch {
  const leftTokens = assertFiniteNumber(left, "left memory-work tokens");
  const rightTokens = assertFiniteNumber(right, "right memory-work tokens");
  if (leftTokens < 0 || rightTokens < 0) {
    throw new Error("memory-work tokens must be >= 0");
  }
  if (leftTokens === 0 && rightTokens === 0) {
    return { relativeGap: 0, label: classifyComputeMatch(0, tolerance) };
  }
  const scale = Math.max(leftTokens, rightTokens);
  const relativeGap = Math.abs(leftTokens - rightTokens) / scale;
  return { relativeGap, label: classifyComputeMatch(relativeGap, tolerance) };
}

function parseSummary(raw: unknown): H2DatasetSummary {
  if (!isPlainObject(raw)) throw new Error("dataset summary must be a plain object");
  assertExactKeys(raw, SUMMARY_KEYS, "dataset summary");
  const datasetId = assertExactText(own(raw, "datasetId"), "datasetId");
  const relativeGain = assertFiniteNumber(own(raw, "relativeGain"), "relativeGain");
  const holmAdjustedP = assertFiniteNumber(own(raw, "holmAdjustedP"), "holmAdjustedP");
  if (holmAdjustedP < 0 || holmAdjustedP > 1) throw new Error("holmAdjustedP must be in [0, 1]");
  const fixedTestsPass = own(raw, "fixedTestsPass");
  if (typeof fixedTestsPass !== "boolean") throw new Error("fixedTestsPass must be a boolean");
  return { datasetId, relativeGain, holmAdjustedP, fixedTestsPass };
}

function summaryPasses(summary: H2DatasetSummary, rule: WriteVsReadDecisionRule): boolean {
  return (
    summary.relativeGain >= rule.minRelativeGain &&
    summary.holmAdjustedP < rule.alpha &&
    summary.fixedTestsPass === true
  );
}

export function evaluateH2Decision(summaries: readonly unknown[], rule: WriteVsReadDecisionRule): H2Decision {
  if (!Array.isArray(summaries)) throw new Error("dataset summaries must be an array");
  const required = rule.requiredMainDatasets;
  const byId = new Map<string, H2DatasetSummary>();
  for (const raw of summaries) {
    const summary = parseSummary(raw);
    if (!(required as readonly string[]).includes(summary.datasetId)) {
      throw new Error(`dataset ${JSON.stringify(summary.datasetId)} is outside the main family`);
    }
    if (byId.has(summary.datasetId)) throw new Error(`duplicate dataset ${summary.datasetId}`);
    byId.set(summary.datasetId, summary);
  }
  for (const datasetId of required) {
    if (!byId.has(datasetId)) throw new Error(`missing main dataset ${datasetId}`);
  }
  let passCount = 0;
  let nonPositive = 0;
  for (const datasetId of required) {
    const summary = byId.get(datasetId);
    if (!summary) throw new Error(`missing main dataset ${datasetId}`);
    if (summaryPasses(summary, rule)) passCount += 1;
    if (summary.relativeGain <= 0) nonPositive += 1;
  }
  if (passCount === required.length) return "SUPPORTED";
  if (passCount === 1) return rule.onePassOutcome;
  if (nonPositive === required.length) return "REJECTED";
  return "NOT-SUPPORTED";
}

export function assertAttributionCalibration(accuracy: unknown, minimum = 0.9): void {
  const floor = assertFiniteNumber(minimum, "calibration minimum");
  if (floor < 0 || floor > 1) throw new Error("calibration minimum must be in [0, 1]");
  if (accuracy === undefined || accuracy === null) {
    throw new Error("attribution calibration accuracy is missing");
  }
  const value = assertFiniteNumber(accuracy, "attribution calibration accuracy");
  if (value < 0 || value > 1) {
    throw new Error("attribution calibration accuracy must be in [0, 1]");
  }
  if (value < floor) {
    throw new Error("attribution calibration accuracy is below 0.90");
  }
}

export function h2FailureLabel(label: AttributionClass): H2FailureLabel {
  switch (label) {
    case "extraction_miss":
    case "index_miss":
    case "retrieval_miss":
    case "use_miss":
      return label;
    case "unattributed":
      return "unresolved";
    default: {
      const neverLabel: never = label;
      throw new Error(`unknown attribution class ${String(neverLabel)}`);
    }
  }
}

export function summarizePairedGain(
  candidate: readonly number[],
  baseline: readonly number[],
  options: { iterations: number; seed: number; level?: number }
): PairedGainSummary {
  const bootstrap: BootstrapOptions = {
    iterations: options.iterations,
    level: options.level,
    random: createSeededRandom(options.seed),
  };
  return {
    confidenceInterval: pairedDeltaConfidenceInterval([...candidate], [...baseline], bootstrap),
    cohensD: cohensD([...candidate], [...baseline]),
  };
}

function emptyResult(exitCode: number, message: string, runsEnabled: boolean): WriteVsReadScaffoldCliResult {
  return {
    ok: false,
    exitCode,
    runsExecuted: 0,
    armIds: [],
    arms: null,
    ruleId: "",
    decisionRule: null,
    allowList: null,
    runsEnabled,
    message,
  };
}

function classifyScaffoldArgv(
  argv: readonly string[]
): { kind: "invalid"; message: string } | { kind: "refused"; message: string } | { kind: "list" } {
  let phase: string | undefined;
  let seeds = false;
  let corpus = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--phase" || token.startsWith("--phase=")) {
      if (phase !== undefined) return { kind: "invalid", message: "duplicate --phase" };
      const attached = token.startsWith("--phase=");
      const value = attached ? token.slice("--phase=".length) : argv[index + 1];
      if (!attached) index += 1;
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        return { kind: "invalid", message: "--phase requires warm, pilot, or main" };
      }
      if (!(REFUSED_PHASES as readonly string[]).includes(value)) {
        return { kind: "invalid", message: `invalid phase ${value}` };
      }
      phase = value;
      continue;
    }
    if (token === "--seeds" || token.startsWith("--seeds=")) {
      if (seeds) return { kind: "invalid", message: "duplicate --seeds" };
      seeds = true;
      if (token === "--seeds") {
        const value = argv[index + 1];
        if (value !== undefined && !value.startsWith("--")) index += 1;
      }
      continue;
    }
    if (token === "--corpus" || token.startsWith("--corpus=")) {
      if (corpus) return { kind: "invalid", message: "duplicate --corpus" };
      corpus = true;
      if (token === "--corpus") {
        const value = argv[index + 1];
        if (value !== undefined && !value.startsWith("--")) index += 1;
      }
      continue;
    }
    return { kind: "invalid", message: `unknown argument ${token}` };
  }
  if (phase !== undefined) {
    return {
      kind: "refused",
      message: `refusing phase ${phase}: scaffolding only — no experiment runs. This phase is deferred to a follow-up.`,
    };
  }
  if (seeds) {
    return {
      kind: "refused",
      message: "refusing --seeds: scaffolding only — no experiment runs. This flag is deferred to a follow-up.",
    };
  }
  if (corpus) {
    return {
      kind: "refused",
      message: "refusing --corpus: scaffolding only — no experiment runs. This flag is deferred to a follow-up.",
    };
  }
  return { kind: "list" };
}

export function runWriteVsReadScaffoldCli(argv: readonly string[]): WriteVsReadScaffoldCliResult {
  if (!runsAreDisabled()) {
    return emptyResult(2, "WRITE_VS_READ_RUNS_ENABLED must stay false. Scaffolding only — no experiment runs.", true);
  }
  const parsed = classifyScaffoldArgv(argv);
  if (parsed.kind === "invalid" || parsed.kind === "refused") {
    return emptyResult(2, parsed.message, false);
  }
  const arms = loadWriteVsReadArms();
  const rule = loadWriteVsReadDecisionRule();
  const allow = loadWriteVsReadAllowList();
  const heldConstant: Record<string, boolean | number> = {};
  for (const key of Object.getOwnPropertyNames(allow.heldConstant).sort(compareStrings)) {
    if (!Object.hasOwn(allow.heldConstant, key)) continue;
    const value = allow.heldConstant[key];
    if (value === undefined) throw new Error(`held constant ${key} is missing`);
    heldConstant[key] = value;
  }
  return {
    ok: true,
    exitCode: 0,
    runsExecuted: 0,
    armIds: arms.map((arm) => arm.id),
    arms,
    ruleId: rule.ruleId,
    decisionRule: rule,
    allowList: {
      writeKeys: [...allow.writeKeys],
      readKeys: [...allow.readKeys],
      heldKeys: Object.getOwnPropertyNames(heldConstant),
      heldConstant,
    },
    runsEnabled: false,
    message: "scaffolding only — no experiment runs",
  };
}
