import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseConfig } from "@remnic/core";
import type { AttributionClass } from "../attribution.js";
import { createSeededRandom } from "../seeded-random.js";
import { pairedDeltaConfidenceInterval } from "../stats/bootstrap.js";
import { cohensD } from "../stats/effect-size.js";
import {
  type H2Decision,
  WRITE_VS_READ_RUNS_ENABLED,
  assertAttributionCalibration,
  classifyComputeMatch,
  diffArmConfigOverrides,
  evaluateH2Decision,
  h2FailureLabel,
  loadWriteVsReadAllowList,
  loadWriteVsReadArms,
  loadWriteVsReadDecisionRule,
  matchMemoryWorkTokens,
  parseMemoryWorkTokenLedgerRow,
  parseWriteVsReadArm,
  parseWriteVsReadDecisionRule,
  runWriteVsReadScaffoldCli,
  summarizePairedGain,
} from "./write-vs-read.js";

// @ts-expect-error "bogus" is not an H2 decision
const badDecision: H2Decision = "bogus";
void badDecision;

const CANDIDATE = [0.7, 0.75, 0.8, 0.85];
const BASELINE = [0.4, 0.45, 0.5, 0.55];

function pass(datasetId: string, relativeGain = 0.05) {
  return { datasetId, relativeGain, holmAdjustedP: 0.049, fixedTestsPass: true };
}

function armAt(arms: ReturnType<typeof loadWriteVsReadArms>, index: number) {
  const arm = arms[index];
  if (arm === undefined) {
    throw new Error(`missing frozen arm at index ${index}`);
  }
  return arm;
}

function ledgerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    item: "item-1",
    corpus: "locomo",
    dataSeed: 7,
    runSeed: 11,
    arm: "write-plus",
    stage: "extract",
    callId: "call-1",
    provider: "fixture",
    model: "fixture-model",
    promptTokens: 100,
    outputTokens: 20,
    cacheTokens: 0,
    timeMs: 12.5,
    state: "ok",
    error: null,
    tryCount: 1,
    ...overrides,
  };
}

test("fixtures freeze the four arms, the allow-list, and the decision rule", () => {
  const arms = loadWriteVsReadArms();
  assert.deepEqual(
    arms.map((arm) => arm.id),
    ["baseline", "write-plus", "read-plus", "write-read-plus"]
  );
  const allow = loadWriteVsReadAllowList();
  for (const arm of arms) {
    for (const key of [...allow.writeKeys, ...allow.readKeys, ...Object.getOwnPropertyNames(allow.heldConstant)]) {
      assert.equal(Object.hasOwn(arm.configOverrides, key), true, `${arm.id} ${key}`);
    }
    assert.equal(arm.matchesReleaseConfig, false);
  }
  const baseline = armAt(arms, 0);
  const writePlus = armAt(arms, 1);
  const readPlus = armAt(arms, 2);
  const both = armAt(arms, 3);
  assert.equal(baseline.configOverrides.qmdSearchStrategy, "lex");
  assert.equal(writePlus.configOverrides.qmdSearchStrategy, "lex");
  assert.equal(readPlus.configOverrides.qmdSearchStrategy, "hybrid");
  assert.equal(both.configOverrides.qmdSearchStrategy, "hybrid");
  assert.equal(baseline.configOverrides.extractionJudgeEnabled, false);
  assert.equal(writePlus.configOverrides.extractionJudgeEnabled, true);
  assert.equal(baseline.configOverrides.consolidateEveryN, 1000000);
  assert.equal(writePlus.configOverrides.consolidateEveryN, 2);
  assert.equal(baseline.configOverrides.semanticDedupCandidates, 0);
  assert.equal(writePlus.configOverrides.semanticDedupCandidates, 5);
  assert.equal(baseline.configOverrides.qmdMaxResults, 8);
  assert.equal(readPlus.configOverrides.qmdMaxResults, 16);
  assert.equal(baseline.configOverrides.recallPlannerMaxQmdResultsFull, 8);
  assert.equal(readPlus.configOverrides.recallPlannerMaxQmdResultsFull, 16);
  assert.equal(both.armCall, "all test flags on");
  assert.equal(both.allTestFlagsOn, true);
  assert.equal(baseline.allTestFlagsOn, false);
  assert.equal(baseline.configOverrides.trustScoreEnabled, false);
  assert.equal(writePlus.configOverrides.outcomeBoostEnabled, false);
  assert.equal(readPlus.configOverrides.recallMemoryWorthFilterEnabled, true);

  const rule = loadWriteVsReadDecisionRule();
  assert.equal(rule.ruleId, "h2-write-vs-read-decision-v1");
  assert.equal(rule.minRelativeGain, 0.05);
  assert.equal(rule.alpha, 0.05);
  assert.equal(rule.onePassOutcome, "REGIME-DEPENDENT");
  assert.equal(rule.supersededWinRule, "at-least-one-corpus");
  assert.equal(rule.controllingComment.endsWith("#issuecomment-4998197561"), true);
  assert.deepEqual(rule.requiredMainDatasets, ["locomo", "drift-gen"]);
  assert.deepEqual(rule.failureLabels, ["extraction_miss", "index_miss", "retrieval_miss", "use_miss", "unresolved"]);
});

test("semanticMerge is the nested block parseConfig reads", () => {
  const arms = loadWriteVsReadArms();
  const baseline = armAt(arms, 0).configOverrides;
  const writePlus = armAt(arms, 1).configOverrides;
  const readPlus = armAt(arms, 2).configOverrides;
  assert.equal(Object.hasOwn(writePlus, "semanticMerge.enabled"), false);
  assert.equal(parseConfig(baseline).semanticMerge.enabled, false);
  assert.equal(parseConfig(readPlus).semanticMerge.enabled, false);
  assert.equal(parseConfig(writePlus).semanticMerge.enabled, true);
  assert.equal(parseConfig(armAt(arms, 3).configOverrides).semanticMerge.enabled, true);
});

test("arm parsing rejects a missing key, an extra key, and a padded strategy", () => {
  const allow = loadWriteVsReadAllowList();
  assert.throws(() => parseWriteVsReadArm({ schemaVersion: 1 }, allow), /missing key/);
  const raw = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, "../../fixtures/h2-write-vs-read/arms/baseline.json"), "utf8")
  ) as { configOverrides: Record<string, unknown> };
  assert.throws(
    () => parseWriteVsReadArm({ ...raw, configOverrides: { ...raw.configOverrides, notAKey: 1 } }, allow),
    /unexpected key/
  );
  assert.throws(
    () =>
      parseWriteVsReadArm({ ...raw, configOverrides: { ...raw.configOverrides, qmdSearchStrategy: " lex" } }, allow),
    /lex or hybrid/
  );
});

test("a drifted decision-rule bar is rejected instead of defaulted", () => {
  const raw = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, "../../fixtures/h2-write-vs-read/decision-rule.json"), "utf8")
  ) as { minRelativeGain: number };
  raw.minRelativeGain = 0.04;
  assert.throws(() => parseWriteVsReadDecisionRule(raw), /minRelativeGain must be 0.05/);
});

test("arm diffs stay inside the allow-list and reject held drift", () => {
  const allow = loadWriteVsReadAllowList();
  const arms = loadWriteVsReadArms();
  const baseline = armAt(arms, 0).configOverrides;
  const writePlus = armAt(arms, 1).configOverrides;
  const readPlus = armAt(arms, 2).configOverrides;
  const writeDiff = diffArmConfigOverrides(baseline, writePlus, allow);
  const readDiff = diffArmConfigOverrides(baseline, readPlus, allow);
  assert.deepEqual(
    writeDiff,
    [...allow.writeKeys].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  );
  assert.deepEqual(
    readDiff,
    [...allow.readKeys].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  );
  for (const key of Object.getOwnPropertyNames(allow.heldConstant)) {
    assert.equal(writeDiff.includes(key), false);
    assert.equal(readDiff.includes(key), false);
  }
  assert.throws(
    () => diffArmConfigOverrides({ ...baseline, extraFlag: 1 }, { ...writePlus, extraFlag: 2 }, allow),
    /outside the allow-list/
  );
  assert.throws(
    () => diffArmConfigOverrides(baseline, { ...baseline, trustScoreEnabled: true }, allow),
    /held-constant/
  );
});

test("the compute matcher accepts 9.9% and labels 10.1% UNMATCHED", () => {
  assert.equal(classifyComputeMatch(0.099), "matched");
  assert.equal(classifyComputeMatch(0.1), "matched");
  assert.equal(classifyComputeMatch(0.101), "UNMATCHED");
  const within = matchMemoryWorkTokens(901, 1000);
  assert.equal(within.label, "matched");
  assert.ok(Math.abs(within.relativeGap - 0.099) < 1e-12);
  const over = matchMemoryWorkTokens(899, 1000);
  assert.equal(over.label, "UNMATCHED");
  assert.ok(Math.abs(over.relativeGap - 0.101) < 1e-12);
  assert.equal(matchMemoryWorkTokens(0, 0).label, "matched");
  assert.equal(matchMemoryWorkTokens(0, 10).label, "UNMATCHED");
  assert.equal(over.relativeGap, 0.101);
  assert.throws(() => classifyComputeMatch(Number.NaN), /finite/);
  assert.throws(() => classifyComputeMatch(Number.POSITIVE_INFINITY), /finite/);
  assert.throws(() => matchMemoryWorkTokens(-1, 10), />= 0/);
  assert.throws(() => classifyComputeMatch(-0), /finite/);
});

test("evaluateH2Decision follows the both-dataset rule", () => {
  const rule = loadWriteVsReadDecisionRule();
  assert.equal(evaluateH2Decision([pass("locomo"), pass("drift-gen", 0.06)], rule), "SUPPORTED");
  assert.equal(evaluateH2Decision([pass("locomo"), pass("drift-gen", 0.01)], rule), "REGIME-DEPENDENT");
  assert.equal(evaluateH2Decision([pass("locomo", 0.01), pass("drift-gen", 0.01)], rule), "NOT-SUPPORTED");
  assert.equal(
    evaluateH2Decision(
      [
        { datasetId: "locomo", relativeGain: 0, holmAdjustedP: 0.01, fixedTestsPass: true },
        { datasetId: "drift-gen", relativeGain: -0.02, holmAdjustedP: 0.01, fixedTestsPass: true },
      ],
      rule
    ),
    "REJECTED"
  );
  assert.equal(
    evaluateH2Decision(
      [
        { datasetId: "locomo", relativeGain: 0.06, holmAdjustedP: 0.05, fixedTestsPass: true },
        { datasetId: "drift-gen", relativeGain: 0.06, holmAdjustedP: 0.05, fixedTestsPass: true },
      ],
      rule
    ),
    "NOT-SUPPORTED"
  );
  assert.throws(() => evaluateH2Decision([pass("locomo"), pass("longmemeval")], rule), /outside the main family/);
});

test("the calibration gate refuses 0.89 and a missing accuracy", () => {
  assert.throws(() => assertAttributionCalibration(0.89), /below 0.90/);
  assert.throws(() => assertAttributionCalibration(undefined), /missing/);
  assert.throws(() => assertAttributionCalibration(null), /missing/);
  assert.throws(() => assertAttributionCalibration(Number.NaN), /finite/);
  assert.throws(() => assertAttributionCalibration(89), /\[0, 1\]/);
  assert.throws(() => assertAttributionCalibration(1.01), /\[0, 1\]/);
  assert.doesNotThrow(() => assertAttributionCalibration(0.9));
  assert.doesNotThrow(() => assertAttributionCalibration(1));
});

test("failure labels map unattributed to unresolved and keep the miss names", () => {
  assert.equal(h2FailureLabel("unattributed"), "unresolved");
  const misses: AttributionClass[] = ["extraction_miss", "index_miss", "retrieval_miss", "use_miss"];
  for (const miss of misses) assert.equal(h2FailureLabel(miss), miss);
});

test("summarizePairedGain reuses bench stats", () => {
  const summary = summarizePairedGain(CANDIDATE, BASELINE, { iterations: 200, seed: 1959, level: 0.95 });
  const directInterval = pairedDeltaConfidenceInterval([...CANDIDATE], [...BASELINE], {
    iterations: 200,
    level: 0.95,
    random: createSeededRandom(1959),
  });
  assert.deepEqual(summary.confidenceInterval, directInterval);
  assert.equal(summary.cohensD, cohensD([...CANDIDATE], [...BASELINE]));
});

test("a ledger row is accepted only when every field is valid", () => {
  const row = parseMemoryWorkTokenLedgerRow(ledgerRow());
  assert.equal(row.stage, "extract");
  assert.equal(row.tryCount, 1);
  assert.equal(row.error, null);
  assert.throws(() => parseMemoryWorkTokenLedgerRow(ledgerRow({ tryCount: 1.5 })), /tryCount/);
  assert.throws(() => parseMemoryWorkTokenLedgerRow(ledgerRow({ tryCount: 0 })), /tryCount/);
});

test("scaffold CLI refuses experiment phases and runs nothing", () => {
  assert.equal(WRITE_VS_READ_RUNS_ENABLED, false);
  for (const argv of [["--phase", "warm"], ["--phase", "pilot"], ["--phase=main"]] as const) {
    const refused = runWriteVsReadScaffoldCli(argv);
    assert.equal(refused instanceof Promise, false);
    assert.equal(refused.ok, false);
    assert.equal(refused.exitCode, 2);
    assert.equal(refused.runsExecuted, 0);
    assert.deepEqual(refused.armIds, []);
    assert.equal(refused.arms, null);
    assert.equal(refused.decisionRule, null);
    assert.match(refused.message, /deferred to a follow-up/);
  }
  for (const argv of [["--seeds"], ["--seeds=5"], ["--corpus"], ["--corpus=locomo"]]) {
    const refused = runWriteVsReadScaffoldCli(argv);
    assert.equal(refused.ok, false, argv.join(" "));
    assert.equal(refused.exitCode, 2);
    assert.equal(refused.runsExecuted, 0);
    assert.deepEqual(refused.armIds, []);
    assert.equal(refused.arms, null);
    assert.match(refused.message, /deferred to a follow-up/);
  }
  for (const argv of [
    ["--phase", "staging"],
    ["--phase"],
    ["--phase="],
    ["--phase", " warm"],
    ["--phase", "WARM"],
    ["--bogus"],
  ]) {
    const rejected = runWriteVsReadScaffoldCli(argv);
    assert.equal(rejected.ok, false, argv.join(" "));
    assert.equal(rejected.exitCode, 2);
    assert.equal(rejected.runsExecuted, 0);
    assert.equal(rejected.message.includes("deferred to a follow-up"), false);
  }
  const listed = runWriteVsReadScaffoldCli([]);
  assert.equal(listed instanceof Promise, false);
  assert.equal(listed.ok, true);
  assert.equal(listed.exitCode, 0);
  assert.equal(listed.runsExecuted, 0);
  assert.equal(listed.runsEnabled, false);
  assert.equal(listed.ruleId, "h2-write-vs-read-decision-v1");
  assert.deepEqual(listed.armIds, ["baseline", "write-plus", "read-plus", "write-read-plus"]);
  if (!listed.arms || !listed.decisionRule || !listed.allowList) {
    throw new Error("list result omitted the frozen arms, decision rule, or allow-list");
  }
  assert.deepEqual(
    listed.arms.map((arm) => arm.id),
    listed.armIds
  );
  assert.equal(listed.arms[0]?.configOverrides.extractionJudgeEnabled, false);
  assert.equal(listed.arms[1]?.configOverrides.extractionJudgeEnabled, true);
  assert.deepEqual(listed.arms[1]?.configOverrides.semanticMerge, { enabled: true });
  assert.equal(listed.decisionRule.minRelativeGain, 0.05);
  assert.equal(listed.decisionRule.alpha, 0.05);
  assert.deepEqual(listed.decisionRule.requiredMainDatasets, ["locomo", "drift-gen"]);
  assert.equal(listed.allowList.heldConstant.trustScoreEnabled, false);
  assert.equal(listed.allowList.heldConstant.semanticDedupThreshold, 0.92);
  assert.match(listed.message, /scaffolding only/);
  const source = readFileSync(new URL("./write-vs-read.ts", import.meta.url), "utf8");
  assert.equal(source.includes("writeFile"), false);
  assert.equal(source.includes("appendFile"), false);
  assert.equal(source.includes(".jsonl"), false);
  const cli = readFileSync(path.resolve(import.meta.dirname, "../../../../packages/remnic-cli/src/index.ts"), "utf8");
  assert.equal(cli.includes('rest[1] === "write-vs-read"'), true);
  assert.equal(cli.includes("runWriteVsReadScaffoldCli"), true);
});
