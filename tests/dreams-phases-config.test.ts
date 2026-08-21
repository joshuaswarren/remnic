/**
 * Tests for the `dreams.phases.{lightSleep,rem,deepSleep}` config block
 * (issue #678 PR 2/4).
 *
 * Spec:
 *   - New nested keys parse correctly.
 *   - New keys WIN over legacy top-level keys when both are set.
 *   - Omitting the block falls back to legacy top-level key defaults.
 *   - Boolean coercion (CLAUDE.md gotcha #36) works for phase `enabled` flags.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

// ── Default / backward-compat behaviour ──────────────────────────────────────

test("dreamsPhases: defaults mirror legacy top-level key defaults when block is absent", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test" });

  // Light sleep defaults mirror lifecycle policy defaults.
  assert.equal(cfg.dreamsPhases.lightSleep.enabled, true, "light sleep enabled mirrors lifecyclePolicyEnabled default (true)");
  assert.equal(cfg.dreamsPhases.lightSleep.cadenceMs, 0);
  assert.equal(cfg.dreamsPhases.lightSleep.promoteHeatThreshold, 0.55);
  assert.equal(cfg.dreamsPhases.lightSleep.staleDecayThreshold, 0.65);
  assert.equal(cfg.dreamsPhases.lightSleep.archiveDecayThreshold, 0.85);
  assert.equal(cfg.dreamsPhases.lightSleep.filterStaleEnabled, false);

  // REM defaults mirror semantic consolidation defaults.
  assert.equal(cfg.dreamsPhases.rem.enabled, false, "REM enabled mirrors semanticConsolidationEnabled default (false)");
  // cadenceMs = 168 h × 3 600 000 ms/h = 604 800 000
  assert.equal(cfg.dreamsPhases.rem.cadenceMs, 168 * 3_600_000);
  assert.equal(cfg.dreamsPhases.rem.similarityThreshold, 0.8);
  assert.equal(cfg.dreamsPhases.rem.minClusterSize, 3);
  assert.equal(cfg.dreamsPhases.rem.maxPerRun, 100);
  assert.equal(cfg.dreamsPhases.rem.minIntervalMs, 10 * 60_000);

  // Deep sleep defaults to least-privileged unless an explicit legacy
  // deep-sleep surface is enabled.
  assert.equal(cfg.dreamsPhases.deepSleep.enabled, false);
  assert.equal(cfg.dreamsPhases.deepSleep.enabledExplicitlySet, false);
  assert.equal(cfg.dreamsPhases.deepSleep.cadenceMs, 24 * 3_600_000);
  assert.equal(cfg.dreamsPhases.deepSleep.versioningEnabled, false, "versioningEnabled mirrors legacy default (false)");
  assert.equal(cfg.dreamsPhases.deepSleep.versioningMaxPerPage, 50);
});

test("dreamsPhases: legacy top-level key changes are reflected when phases block is absent", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    lifecyclePolicyEnabled: false,
    lifecyclePromoteHeatThreshold: 0.7,
    lifecycleStaleDecayThreshold: 0.75,
    lifecycleArchiveDecayThreshold: 0.9,
    lifecycleFilterStaleEnabled: true,
    semanticConsolidationEnabled: true,
    semanticConsolidationIntervalHours: 24,
    semanticConsolidationThreshold: 0.85,
    semanticConsolidationMinClusterSize: 4,
    semanticConsolidationMaxPerRun: 50,
    consolidationMinIntervalMs: 5 * 60_000,
    versioningEnabled: true,
    versioningMaxPerPage: 30,
  });

  assert.equal(cfg.dreamsPhases.lightSleep.enabled, false, "light sleep mirrors lifecyclePolicyEnabled: false");
  assert.equal(cfg.dreamsPhases.lightSleep.promoteHeatThreshold, 0.7);
  assert.equal(cfg.dreamsPhases.lightSleep.staleDecayThreshold, 0.75);
  assert.equal(cfg.dreamsPhases.lightSleep.archiveDecayThreshold, 0.9);
  assert.equal(cfg.dreamsPhases.lightSleep.filterStaleEnabled, true);

  assert.equal(cfg.dreamsPhases.rem.enabled, true, "REM mirrors semanticConsolidationEnabled: true");
  assert.equal(cfg.dreamsPhases.rem.cadenceMs, 24 * 3_600_000);
  assert.equal(cfg.dreamsPhases.rem.similarityThreshold, 0.85);
  assert.equal(cfg.dreamsPhases.rem.minClusterSize, 4);
  assert.equal(cfg.dreamsPhases.rem.maxPerRun, 50);
  assert.equal(cfg.dreamsPhases.rem.minIntervalMs, 5 * 60_000);

  assert.equal(cfg.dreamsPhases.deepSleep.enabled, true, "deep sleep mirrors explicit legacy deep-sleep signals");
  assert.equal(cfg.dreamsPhases.deepSleep.versioningEnabled, true, "deep sleep mirrors versioningEnabled: true");
  assert.equal(cfg.dreamsPhases.deepSleep.versioningMaxPerPage, 30);
});

// ── New keys WIN when set ─────────────────────────────────────────────────────

test("dreamsPhases: dreams.phases.lightSleep.enabled wins over lifecyclePolicyEnabled when both set", () => {
  // Codex P1 on PR 763: the new key must propagate to the legacy runtime
  // fields the orchestrator actually reads, otherwise "new key wins" is a
  // documentation lie. Legacy says enabled=true (default); new key says false.
  // Both `dreamsPhases.lightSleep.enabled` AND the legacy runtime field
  // `lifecyclePolicyEnabled` must reflect the override.
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    lifecyclePolicyEnabled: true,
    dreams: {
      phases: {
        lightSleep: { enabled: false },
      },
    },
  });
  assert.equal(cfg.dreamsPhases.lightSleep.enabled, false, "dreams.phases.lightSleep.enabled=false wins over lifecycle default");
  // Legacy runtime field reflects the override (P1 fix).
  assert.equal(cfg.lifecyclePolicyEnabled, false, "legacy lifecyclePolicyEnabled is overridden by dreams.phases (P1 wiring)");
});

test("dreamsPhases: dreams.phases.lightSleep thresholds win over legacy keys (including legacy runtime fields)", () => {
  // P1: legacy runtime fields used by the orchestrator must reflect the override.
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    lifecyclePromoteHeatThreshold: 0.5,
    lifecycleStaleDecayThreshold: 0.6,
    lifecycleArchiveDecayThreshold: 0.8,
    lifecycleFilterStaleEnabled: false,
    dreams: {
      phases: {
        lightSleep: {
          promoteHeatThreshold: 0.72,
          staleDecayThreshold: 0.78,
          archiveDecayThreshold: 0.91,
          filterStaleEnabled: true,
        },
      },
    },
  });
  assert.equal(cfg.dreamsPhases.lightSleep.promoteHeatThreshold, 0.72);
  assert.equal(cfg.dreamsPhases.lightSleep.staleDecayThreshold, 0.78);
  assert.equal(cfg.dreamsPhases.lightSleep.archiveDecayThreshold, 0.91);
  assert.equal(cfg.dreamsPhases.lightSleep.filterStaleEnabled, true);
  // Legacy runtime fields reflect the override (P1 fix).
  assert.equal(cfg.lifecyclePromoteHeatThreshold, 0.72);
  assert.equal(cfg.lifecycleStaleDecayThreshold, 0.78);
  assert.equal(cfg.lifecycleArchiveDecayThreshold, 0.91);
  assert.equal(cfg.lifecycleFilterStaleEnabled, true);
});

test("dreamsPhases: dreams.phases.rem.enabled wins over semanticConsolidationEnabled (legacy runtime field too)", () => {
  // P1: legacy `semanticConsolidationEnabled` must reflect the override since
  // `runSemanticConsolidation` reads that field, not `dreamsPhases.rem.enabled`.
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    semanticConsolidationEnabled: false,
    dreams: { phases: { rem: { enabled: true } } },
  });
  assert.equal(cfg.dreamsPhases.rem.enabled, true, "dreams.phases.rem.enabled=true wins");
  assert.equal(cfg.semanticConsolidationEnabled, true, "legacy semanticConsolidationEnabled reflects override (P1)");
});

test("dreamsPhases: dreams.phases.rem cadence wins over semanticConsolidationIntervalHours (legacy runtime field too)", () => {
  // P1: legacy `semanticConsolidationIntervalHours` must be derived from the
  // override (rounded up to nearest hour, min 1) so legacy schedulers honour the new key.
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    semanticConsolidationIntervalHours: 168,
    dreams: { phases: { rem: { cadenceMs: 3_600_000 } } },
  });
  assert.equal(cfg.dreamsPhases.rem.cadenceMs, 3_600_000, "explicit cadenceMs wins");
  assert.equal(cfg.semanticConsolidationIntervalHours, 1, "legacy IntervalHours derived from cadenceMs (P1)");
});

test("dreamsPhases: dreams.phases.rem cadenceMs=0 preserves legacy zero interval", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    semanticConsolidationEnabled: true,
    semanticConsolidationIntervalHours: 168,
    dreams: { phases: { rem: { enabled: true, cadenceMs: 0 } } },
  });
  assert.equal(cfg.dreamsPhases.rem.cadenceMs, 0, "explicit zero cadence wins");
  assert.equal(cfg.semanticConsolidationIntervalHours, 0, "legacy IntervalHours preserves zero cadence");
  assert.equal(cfg.semanticConsolidationEnabled, false, "zero cadence disables legacy scheduler to avoid running every maintenance cycle");
});

test("dreamsPhases: dreams.phases.rem.minIntervalMs wins over consolidationMinIntervalMs (legacy runtime field too)", () => {
  // P1: legacy `consolidationMinIntervalMs` must reflect the override.
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    consolidationMinIntervalMs: 10 * 60_000,
    dreams: { phases: { rem: { minIntervalMs: 60_000 } } },
  });
  assert.equal(cfg.dreamsPhases.rem.minIntervalMs, 60_000);
  assert.equal(cfg.consolidationMinIntervalMs, 60_000, "legacy minIntervalMs reflects override (P1)");
});

test("dreamsPhases: dreams.phases.deepSleep.enabled false disables phase", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    nightlyGovernanceCronAutoRegister: true,
    qmdTierMigrationEnabled: true,
    versioningEnabled: true,
    dreams: { phases: { deepSleep: { enabled: false } } },
  });
  assert.equal(cfg.dreamsPhases.deepSleep.enabled, false);
  assert.equal(cfg.dreamsPhases.deepSleep.enabledExplicitlySet, true);
  assert.equal(cfg.nightlyGovernanceCronAutoRegister, false);
  assert.equal(cfg.qmdTierMigrationEnabled, false);
  assert.equal(cfg.versioningEnabled, false);
});

test("dreamsPhases: dreams.phases.deepSleep versioning wins over versioningEnabled (legacy runtime field too)", () => {
  // P1: legacy `versioningEnabled` and `versioningMaxPerPage` must reflect the
  // override since `StorageManager.snapshotBeforeWrite` reads those fields.
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    versioningEnabled: false,
    versioningMaxPerPage: 50,
    dreams: {
      phases: {
        deepSleep: {
          enabled: true,
          versioningEnabled: true,
          versioningMaxPerPage: 20,
        },
      },
    },
  });
  assert.equal(cfg.dreamsPhases.deepSleep.versioningEnabled, true, "dreams.phases wins");
  assert.equal(cfg.dreamsPhases.deepSleep.versioningMaxPerPage, 20, "dreams.phases wins");
  // Legacy runtime fields reflect the override (P1 fix).
  assert.equal(cfg.versioningEnabled, true, "legacy versioningEnabled reflects override (P1)");
  assert.equal(cfg.versioningMaxPerPage, 20, "legacy versioningMaxPerPage reflects override (P1)");
});

// ── Boolean coercion (CLAUDE.md gotcha #36) ───────────────────────────────────

test("dreamsPhases: boolean coercion works for lightSleep.enabled", () => {
  for (const falsey of ["false", "0", "no", "off", false, 0]) {
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      dreams: { phases: { lightSleep: { enabled: falsey } } },
    });
    assert.equal(cfg.dreamsPhases.lightSleep.enabled, false, `${JSON.stringify(falsey)} should coerce to false`);
  }
  for (const truthy of ["true", "1", "yes", "on", true, 1]) {
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      dreams: { phases: { lightSleep: { enabled: truthy } } },
    });
    assert.equal(cfg.dreamsPhases.lightSleep.enabled, true, `${JSON.stringify(truthy)} should coerce to true`);
  }
});

// ── Edge cases ────────────────────────────────────────────────────────────────

test("dreamsPhases: ignores dreams block that is not an object", () => {
  // Malformed `dreams` should not crash.
  const cfg = parseConfig({ openaiApiKey: "sk-test", dreams: "invalid" });
  // Falls back to legacy defaults.
  assert.equal(cfg.dreamsPhases.lightSleep.enabled, true);
});

test("dreamsPhases: ignores phases block that is not an object", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test", dreams: { phases: 42 } });
  assert.equal(cfg.dreamsPhases.rem.enabled, false);
});

test("dreamsPhases: threshold values are clamped to [0, 1]", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    dreams: {
      phases: {
        lightSleep: {
          promoteHeatThreshold: 1.5,  // should clamp to 1
          staleDecayThreshold: -0.1,   // should clamp to 0
        },
        rem: {
          similarityThreshold: 2.0,   // should clamp to 1
        },
      },
    },
  });
  assert.equal(cfg.dreamsPhases.lightSleep.promoteHeatThreshold, 1);
  assert.equal(cfg.dreamsPhases.lightSleep.staleDecayThreshold, 0);
  assert.equal(cfg.dreamsPhases.rem.similarityThreshold, 1);
});

test("dreamsPhases: minClusterSize is clamped to minimum of 2", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    dreams: { phases: { rem: { minClusterSize: 1 } } },
  });
  assert.equal(cfg.dreamsPhases.rem.minClusterSize, 2);
});

test("dreamsPhases: cadenceMs values of 0 are preserved (disable-by-zero convention)", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    dreams: {
      phases: {
        lightSleep: { cadenceMs: 0 },
        rem: { cadenceMs: 0 },
        deepSleep: { cadenceMs: 0 },
      },
    },
  });
  assert.equal(cfg.dreamsPhases.lightSleep.cadenceMs, 0);
  assert.equal(cfg.dreamsPhases.rem.cadenceMs, 0);
  assert.equal(cfg.dreamsPhases.deepSleep.cadenceMs, 0);
});
