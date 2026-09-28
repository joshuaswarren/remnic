import assert from "node:assert/strict";
import test from "node:test";
import { pairedDeltaConfidenceInterval } from "../stats/bootstrap.js";
import { cohensD } from "../stats/effect-size.js";
import {
  evaluateH1Decision,
  loadOutcomePriorArms,
  loadOutcomePriorDecisionRule,
  parseOutcomePriorArm,
  runOutcomePriorScaffoldCli,
} from "./outcome-prior.js";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const CANDIDATE = [0.7, 0.75, 0.8, 0.85, 0.9, 0.72, 0.78, 0.88];
const BASELINE = [0.4, 0.45, 0.5, 0.55, 0.42, 0.48, 0.52, 0.44];

test("fixtures freeze the H1 arms and the locked decision rule", () => {
  const arms = loadOutcomePriorArms();
  assert.deepEqual(
    arms.map((arm) => arm.id),
    ["h1-w0", "h1-w015", "h1-w030", "h1-w050", "memory-worth-base"],
  );
  const weights = arms.filter((arm) => arm.role === "h1-arm").map((arm) => arm.outcomeBoostWeight);
  assert.deepEqual(weights, [0, 0.15, 0.3, 0.5]);
  for (const arm of arms) {
    assert.equal(arm.retrieval.k, 10);
    assert.equal(arm.retrieval.contextCapTokens, 2000);
  }
  for (const arm of arms.filter((item) => item.role === "h1-arm")) {
    assert.equal(arm.configOverrides.outcomeBoostEnabled, true);
    assert.equal(arm.configOverrides.recallMemoryWorthFilterEnabled, false);
    assert.equal(arm.configOverrides.trustScoreEnabled, false);
    assert.equal(arm.configOverrides.boostAccessCount, false);
    assert.equal(arm.configOverrides.reinforcementRecallBoostEnabled, false);
    assert.equal(arm.configOverrides.recencyWeight, 0);
  }
  const base = arms.find((arm) => arm.id === "memory-worth-base");
  assert.ok(base);
  assert.equal(base.configOverrides.recallMemoryWorthFilterEnabled, true);
  assert.equal(base.configOverrides.outcomeBoostEnabled, false);
  assert.equal(Object.hasOwn(base.configOverrides, "trustScoreEnabled"), false);
  assert.equal(Object.hasOwn(base.configOverrides, "recencyWeight"), false);

  const rule = loadOutcomePriorDecisionRule();
  assert.equal(rule.h1b, "NOT RUN");
  assert.equal(rule.primaryMetric, "recall@k");
  assert.equal(rule.thresholds.minRelativeGain, 0.05);
  assert.equal(rule.thresholds.alpha, 0.05);
  assert.deepEqual(rule.clock.lockedEpochs, [11, 12]);
  assert.deepEqual(rule.clock.pickWeights, [0.15, 0.3, 0.5]);
  assert.equal(rule.controllingComment.endsWith("#issuecomment-4998194342"), true);
});

test("a memory-worth arm cannot smuggle H1 isolation flags", () => {
  assert.throws(
    () =>
      parseOutcomePriorArm({
        schemaVersion: 1,
        id: "memory-worth-base",
        role: "memory-worth-base",
        outcomeBoostWeight: 0,
        retrieval: { k: 10, contextCapTokens: 2000 },
        configOverrides: {
          recallMemoryWorthFilterEnabled: true,
          outcomeBoostEnabled: false,
          outcomeBoostWeight: 0,
          trustScoreEnabled: false,
        },
      }),
    /unexpected key/,
  );
});

test("evaluateH1Decision reuses bench stats and withholds a verdict without a shuffle p-value", () => {
  const rule = loadOutcomePriorDecisionRule();
  const bootstrap = { iterations: 200, level: 0.95 as const, random: mulberry32(1958) };
  const directInterval = pairedDeltaConfidenceInterval([...CANDIDATE], [...BASELINE], {
    iterations: 200,
    level: 0.95,
    random: mulberry32(1958),
  });
  const directEffect = cohensD([...CANDIDATE], [...BASELINE]);
  const supported = evaluateH1Decision({
    candidateRecall: CANDIDATE,
    baselineRecall: BASELINE,
    rule,
    pValue: 0.01,
    bootstrap,
  });
  assert.equal(supported.decision, "supported");
  assert.ok(supported.relativeGain !== null && supported.relativeGain >= 0.05);
  assert.deepEqual(supported.confidenceInterval, directInterval);
  assert.equal(supported.cohensD, directEffect);
  assert.equal(Number.isFinite(directEffect), true);

  const missingP = evaluateH1Decision({
    candidateRecall: CANDIDATE,
    baselineRecall: BASELINE,
    rule,
    bootstrap: { iterations: 200, level: 0.95, random: mulberry32(1958) },
  });
  assert.equal(missingP.decision, "not-estimable");

  const flat = evaluateH1Decision({
    candidateRecall: BASELINE,
    baselineRecall: BASELINE,
    rule,
    pValue: 0.01,
    bootstrap: { iterations: 50, level: 0.95, random: mulberry32(7) },
  });
  assert.equal(flat.decision, "rejected");
  assert.equal(flat.relativeGain, 0);

  const zeroBaseline = evaluateH1Decision({
    candidateRecall: [1, 1],
    baselineRecall: [0, 0],
    rule,
    pValue: 0.01,
  });
  assert.equal(zeroBaseline.decision, "not-estimable");
  assert.equal(zeroBaseline.confidenceInterval, null);
});

test("scaffold CLI refuses experiment phases and does not run", () => {
  for (const argv of [["--phase", "warm"], ["--phase", "pilot"], ["--phase=main"]] as const) {
    const refused = runOutcomePriorScaffoldCli(argv);
    assert.equal(refused.ok, false);
    assert.equal(refused.exitCode, 2);
    assert.equal(refused.runsExecuted, 0);
    assert.equal(refused.h1b, "NOT RUN");
    assert.deepEqual(refused.armIds, []);
  }
  const listed = runOutcomePriorScaffoldCli([]);
  assert.equal(listed.ok, true);
  assert.equal(listed.exitCode, 0);
  assert.equal(listed.runsExecuted, 0);
  assert.equal(listed.h1b, "NOT RUN");
  assert.equal(listed.ruleId, "h1-outcome-prior-decision-v1");
  assert.deepEqual(listed.armIds, ["h1-w0", "h1-w015", "h1-w030", "h1-w050", "memory-worth-base"]);
  assert.match(listed.message, /scaffolding only/);
});
