import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseConfig } from "../src/config.js";

test("evaluation harness config defaults off and derives store dir from memoryDir", () => {
  const memoryDir = "/tmp/engram-memory";
  const cfg = parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir,
  });

  assert.equal(cfg.evalHarnessEnabled, false);
  assert.equal(cfg.evalShadowModeEnabled, false);
  assert.equal(cfg.benchmarkBaselineSnapshotsEnabled, false);
  assert.equal(cfg.evalStoreDir, path.join(memoryDir, "state", "evals"));
  assert.equal(cfg.objectiveStateMemoryEnabled, false);
  assert.equal(cfg.objectiveStateSnapshotWritesEnabled, false);
  assert.equal(cfg.objectiveStateStoreDir, path.join(memoryDir, "state", "objective-state"));
  assert.equal(cfg.objectiveStateRecallEnabled, false);
  assert.equal(cfg.causalTrajectoryMemoryEnabled, false);
  assert.equal(cfg.causalTrajectoryStoreDir, path.join(memoryDir, "state", "causal-trajectories"));
  assert.equal(cfg.causalTrajectoryRecallEnabled, false);
  assert.equal(cfg.actionGraphRecallEnabled, false);
  assert.equal(cfg.trustZonesEnabled, false);
  assert.equal(cfg.quarantinePromotionEnabled, false);
  assert.equal(cfg.trustZoneStoreDir, path.join(memoryDir, "state", "trust-zones"));
  assert.equal(cfg.trustZoneRecallEnabled, false);
  assert.equal(cfg.memoryPoisoningDefenseEnabled, false);
  assert.equal(cfg.memoryRedTeamBenchEnabled, false);
  assert.equal(cfg.harmonicRetrievalEnabled, false);
  assert.equal(cfg.abstractionAnchorsEnabled, false);
  assert.equal(cfg.verifiedRecallEnabled, false);
  assert.equal(cfg.semanticRulePromotionEnabled, false);
  assert.equal(cfg.semanticRuleVerificationEnabled, false);
  assert.equal(cfg.creationMemoryEnabled, false);
  assert.equal(cfg.memoryUtilityLearningEnabled, false);
  assert.equal(cfg.promotionByOutcomeEnabled, false);
  assert.equal(cfg.commitmentLedgerEnabled, false);
  assert.equal(cfg.commitmentLifecycleEnabled, false);
  assert.equal(cfg.commitmentStaleDays, 14);
  assert.equal(cfg.resumeBundlesEnabled, false);
  assert.equal(cfg.workProductRecallEnabled, false);
  assert.equal(cfg.abstractionNodeStoreDir, path.join(memoryDir, "state", "abstraction-nodes"));
  assert.equal(cfg.commitmentLedgerDir, path.join(memoryDir, "state", "commitment-ledger"));
  assert.equal(cfg.resumeBundleDir, path.join(memoryDir, "state", "resume-bundles"));
  assert.equal(cfg.workProductLedgerDir, path.join(memoryDir, "state", "work-product-ledger"));
  assert.equal(cfg.recallPipeline.some((entry) => entry.id === "objective-state" && entry.enabled === false), true);
  assert.equal(cfg.recallPipeline.some((entry) => entry.id === "causal-trajectories" && entry.enabled === false), true);
  assert.equal(cfg.recallPipeline.some((entry) => entry.id === "trust-zones" && entry.enabled === false), true);
  assert.equal(cfg.recallPipeline.some((entry) => entry.id === "harmonic-retrieval" && entry.enabled === false), true);
  assert.equal(cfg.recallPipeline.some((entry) => entry.id === "verified-episodes" && entry.enabled === false), true);
  assert.equal(cfg.recallPipeline.some((entry) => entry.id === "verified-rules" && entry.enabled === false), true);
});

test("evaluation harness config respects explicit flags and custom store dir", () => {
  const cfg = parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir: "/tmp/engram-memory",
    evalHarnessEnabled: true,
    evalShadowModeEnabled: true,
    benchmarkBaselineSnapshotsEnabled: true,
    evalStoreDir: "/tmp/custom-evals",
    objectiveStateMemoryEnabled: true,
    objectiveStateSnapshotWritesEnabled: true,
    objectiveStateStoreDir: "/tmp/objective-state-store",
    objectiveStateRecallEnabled: true,
    causalTrajectoryMemoryEnabled: true,
    causalTrajectoryStoreDir: "/tmp/causal-trajectory-store",
    causalTrajectoryRecallEnabled: true,
    actionGraphRecallEnabled: true,
    trustZonesEnabled: true,
    quarantinePromotionEnabled: true,
    trustZoneStoreDir: "/tmp/trust-zones-store",
    trustZoneRecallEnabled: true,
    memoryPoisoningDefenseEnabled: true,
    memoryRedTeamBenchEnabled: true,
    harmonicRetrievalEnabled: true,
    abstractionAnchorsEnabled: true,
    verifiedRecallEnabled: true,
    semanticRulePromotionEnabled: true,
    semanticRuleVerificationEnabled: true,
    creationMemoryEnabled: true,
    memoryUtilityLearningEnabled: true,
    promotionByOutcomeEnabled: true,
    commitmentLedgerEnabled: true,
    commitmentLifecycleEnabled: true,
    commitmentStaleDays: 21,
    commitmentLedgerDir: "/tmp/custom-commitments",
    resumeBundlesEnabled: true,
    resumeBundleDir: "/tmp/custom-resume-bundles",
    workProductRecallEnabled: true,
    workProductLedgerDir: "/tmp/custom-work-products",
    abstractionNodeStoreDir: "/tmp/abstraction-node-store",
  });

  assert.equal(cfg.evalHarnessEnabled, true);
  assert.equal(cfg.evalShadowModeEnabled, true);
  assert.equal(cfg.benchmarkBaselineSnapshotsEnabled, true);
  assert.equal(cfg.evalStoreDir, "/tmp/custom-evals");
  assert.equal(cfg.objectiveStateMemoryEnabled, true);
  assert.equal(cfg.objectiveStateSnapshotWritesEnabled, true);
  assert.equal(cfg.objectiveStateStoreDir, "/tmp/objective-state-store");
  assert.equal(cfg.objectiveStateRecallEnabled, true);
  assert.equal(cfg.causalTrajectoryMemoryEnabled, true);
  assert.equal(cfg.causalTrajectoryStoreDir, "/tmp/causal-trajectory-store");
  assert.equal(cfg.causalTrajectoryRecallEnabled, true);
  assert.equal(cfg.actionGraphRecallEnabled, true);
  assert.equal(cfg.trustZonesEnabled, true);
  assert.equal(cfg.quarantinePromotionEnabled, true);
  assert.equal(cfg.trustZoneStoreDir, "/tmp/trust-zones-store");
  assert.equal(cfg.trustZoneRecallEnabled, true);
  assert.equal(cfg.memoryPoisoningDefenseEnabled, true);
  assert.equal(cfg.memoryRedTeamBenchEnabled, true);
  assert.equal(cfg.harmonicRetrievalEnabled, true);
  assert.equal(cfg.abstractionAnchorsEnabled, true);
  assert.equal(cfg.verifiedRecallEnabled, true);
  assert.equal(cfg.semanticRulePromotionEnabled, true);
  assert.equal(cfg.semanticRuleVerificationEnabled, true);
  assert.equal(cfg.creationMemoryEnabled, true);
  assert.equal(cfg.memoryUtilityLearningEnabled, true);
  assert.equal(cfg.promotionByOutcomeEnabled, true);
  assert.equal(cfg.commitmentLedgerEnabled, true);
  assert.equal(cfg.commitmentLifecycleEnabled, true);
  assert.equal(cfg.commitmentStaleDays, 21);
  assert.equal(cfg.commitmentLedgerDir, "/tmp/custom-commitments");
  assert.equal(cfg.resumeBundlesEnabled, true);
  assert.equal(cfg.resumeBundleDir, "/tmp/custom-resume-bundles");
  assert.equal(cfg.workProductRecallEnabled, true);
  assert.equal(cfg.abstractionNodeStoreDir, "/tmp/abstraction-node-store");
  assert.equal(cfg.workProductLedgerDir, "/tmp/custom-work-products");
  assert.equal(cfg.recallPipeline.some((entry) => entry.id === "harmonic-retrieval" && entry.enabled === true), true);
  assert.equal(cfg.recallPipeline.some((entry) => entry.id === "verified-episodes" && entry.enabled === true), true);
  assert.equal(cfg.recallPipeline.some((entry) => entry.id === "verified-rules" && entry.enabled === true), true);
});
