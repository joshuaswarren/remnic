import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

test("parseConfig sets lifecycle policy defaults with policy enabled (#686 PR 3/6)", () => {
  // Default flipped to true since #686 PR 3/6 — the year-2 retention
  // story (hot↔cold tier migration) ships on by default for every
  // install rather than gated behind an opt-in flag.
  const cfg = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(cfg.lifecyclePolicyEnabled, true);
  assert.equal(cfg.lifecycleFilterStaleEnabled, false);
  assert.equal(cfg.lifecyclePromoteHeatThreshold, 0.55);
  assert.equal(cfg.lifecycleStaleDecayThreshold, 0.65);
  assert.equal(cfg.lifecycleArchiveDecayThreshold, 0.85);
  assert.deepEqual(cfg.lifecycleProtectedCategories, ["decision", "principle", "commitment", "preference", "procedure"]);
  // lifecycleMetricsEnabled mirrors lifecyclePolicyEnabled when not
  // explicitly set, so the flip carries through here.
  assert.equal(cfg.lifecycleMetricsEnabled, true);
});

test("parseConfig honors explicit lifecyclePolicyEnabled: false opt-out", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test", lifecyclePolicyEnabled: false });
  assert.equal(cfg.lifecyclePolicyEnabled, false);
  // lifecycleMetricsEnabled mirrors when not explicitly set.
  assert.equal(cfg.lifecycleMetricsEnabled, false);
});

test("parseConfig coerces boolean-like strings for lifecyclePolicyEnabled", () => {
  // CLAUDE.md gotcha #36: string `"false"` is truthy in JS, so the
  // strict `typeof === "boolean"` check would silently re-enable the
  // policy when operators pass `--config lifecyclePolicyEnabled=false`.
  for (const falsey of ["false", "0", "no", "off", "False", " FALSE ", 0]) {
    const cfg = parseConfig({ openaiApiKey: "sk-test", lifecyclePolicyEnabled: falsey });
    assert.equal(cfg.lifecyclePolicyEnabled, false, `expected ${JSON.stringify(falsey)} → false`);
    assert.equal(cfg.lifecycleMetricsEnabled, false, `metrics should mirror coerced false for ${JSON.stringify(falsey)}`);
  }
  for (const truthy of ["true", "1", "yes", "on", "True", 1]) {
    const cfg = parseConfig({ openaiApiKey: "sk-test", lifecyclePolicyEnabled: truthy });
    assert.equal(cfg.lifecyclePolicyEnabled, true, `expected ${JSON.stringify(truthy)} → true`);
  }
  // Uninterpretable values fall through to the default (`true`).
  const cfg = parseConfig({ openaiApiKey: "sk-test", lifecyclePolicyEnabled: "maybe" });
  assert.equal(cfg.lifecyclePolicyEnabled, true);
});

test("parseConfig supports explicit lifecycle policy settings", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    lifecyclePolicyEnabled: true,
    lifecycleFilterStaleEnabled: true,
    lifecyclePromoteHeatThreshold: 0.7,
    lifecycleStaleDecayThreshold: 0.8,
    lifecycleArchiveDecayThreshold: 0.95,
    lifecycleProtectedCategories: ["decision", "skill", "unknown", 7],
    lifecycleMetricsEnabled: true,
  });

  assert.equal(cfg.lifecyclePolicyEnabled, true);
  assert.equal(cfg.lifecycleFilterStaleEnabled, true);
  assert.equal(cfg.lifecyclePromoteHeatThreshold, 0.7);
  assert.equal(cfg.lifecycleStaleDecayThreshold, 0.8);
  assert.equal(cfg.lifecycleArchiveDecayThreshold, 0.95);
  assert.deepEqual(cfg.lifecycleProtectedCategories, ["decision", "skill"]);
  assert.equal(cfg.lifecycleMetricsEnabled, true);
});
