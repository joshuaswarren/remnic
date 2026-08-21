import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

test("parseConfig sets cold QMD tier defaults", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(cfg.qmdColdTierEnabled, false);
  assert.equal(cfg.qmdColdCollection, "openclaw-engram-cold");
  assert.equal(cfg.qmdColdMaxResults, 8);
  assert.equal(cfg.qmdTierMigrationEnabled, false);
  assert.equal(cfg.qmdTierDemotionMinAgeDays, 14);
  assert.equal(cfg.qmdTierDemotionValueThreshold, 0.35);
  assert.equal(cfg.qmdTierPromotionValueThreshold, 0.7);
  assert.equal(cfg.qmdTierParityGraphEnabled, true);
  assert.equal(cfg.qmdTierParityHiMemEnabled, true);
  assert.equal(cfg.qmdTierAutoBackfillEnabled, false);
  assert.equal(cfg.cronRecallMode, "all");
  assert.deepEqual(cfg.cronRecallAllowlist, []);
  assert.equal(cfg.cronRecallPolicyEnabled, true);
  assert.equal(cfg.cronRecallNormalizedQueryMaxChars, 480);
  assert.equal(cfg.cronRecallInstructionHeavyTokenCap, 36);
  assert.equal(cfg.cronConversationRecallMode, "auto");
});

test("parseConfig preserves explicit cold QMD settings including zero", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    qmdColdTierEnabled: true,
    qmdColdCollection: "engram-cold-custom",
    qmdColdMaxResults: 0,
    qmdTierMigrationEnabled: true,
    qmdTierDemotionMinAgeDays: 0,
    qmdTierDemotionValueThreshold: 0,
    qmdTierPromotionValueThreshold: 0,
    qmdTierParityGraphEnabled: false,
    qmdTierParityHiMemEnabled: false,
    qmdTierAutoBackfillEnabled: true,
  });
  assert.equal(cfg.qmdColdTierEnabled, true);
  assert.equal(cfg.qmdColdCollection, "engram-cold-custom");
  assert.equal(cfg.qmdColdMaxResults, 0);
  assert.equal(cfg.qmdTierMigrationEnabled, true);
  assert.equal(cfg.qmdTierDemotionMinAgeDays, 0);
  assert.equal(cfg.qmdTierDemotionValueThreshold, 0);
  assert.equal(cfg.qmdTierPromotionValueThreshold, 0);
  assert.equal(cfg.qmdTierParityGraphEnabled, false);
  assert.equal(cfg.qmdTierParityHiMemEnabled, false);
  assert.equal(cfg.qmdTierAutoBackfillEnabled, true);
});

test("parseConfig supports cron recall allowlist mode", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    cronRecallMode: "allowlist",
    cronRecallAllowlist: ["agent:main:cron:*", "agent:generalist:cron:engram-*"],
    cronRecallPolicyEnabled: false,
    cronRecallNormalizedQueryMaxChars: 256,
    cronRecallInstructionHeavyTokenCap: 18,
    cronConversationRecallMode: "never",
  });
  assert.equal(cfg.cronRecallMode, "allowlist");
  assert.deepEqual(cfg.cronRecallAllowlist, [
    "agent:main:cron:*",
    "agent:generalist:cron:engram-*",
  ]);
  assert.equal(cfg.cronRecallPolicyEnabled, false);
  assert.equal(cfg.cronRecallNormalizedQueryMaxChars, 256);
  assert.equal(cfg.cronRecallInstructionHeavyTokenCap, 18);
  assert.equal(cfg.cronConversationRecallMode, "never");
});
