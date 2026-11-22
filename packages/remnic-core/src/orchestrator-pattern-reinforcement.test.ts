
import test from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "./orchestrator.js";

interface OrchestratorStubConfig {
  patternReinforcementEnabled: boolean;
  patternReinforcementCadenceMs: number;
  patternReinforcementCategories: readonly string[];
  patternReinforcementMinCount: number;
}

interface PatternReinforcementHarness {
  orchestrator: any;
  getStorageReadCalls: () => number;
}

function makeOrchestratorStub(config: OrchestratorStubConfig): PatternReinforcementHarness {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  let storageReadCalls = 0;
  orchestrator.config = config;
  orchestrator.lastPatternReinforcementAtByNs = new Map<string, number>();
  orchestrator.storage = {
    readAllMemories: async () => {
      storageReadCalls += 1;
      return [];
    },
    writeMemoryFrontmatter: async () => true,
  };
  orchestrator.getStorage = async () => {
    throw new Error("getStorage should not be invoked in single-tenant test paths");
  };
  return {
    orchestrator,
    getStorageReadCalls: () => storageReadCalls,
  };
}

test("runPatternReinforcement: force=false on disabled feature returns disabled", async () => {
  const harness = makeOrchestratorStub({
    patternReinforcementEnabled: false,
    patternReinforcementCadenceMs: 0,
    patternReinforcementCategories: ["preference"],
    patternReinforcementMinCount: 3,
  });
  const result = await harness.orchestrator.runPatternReinforcement({});
  assert.equal(result.ran, false);
  assert.equal(result.skippedReason, "disabled");
  assert.equal(harness.getStorageReadCalls(), 0);
});

test("runPatternReinforcement: force=true does NOT bypass disabled feature gate (Cursor Medium)", async () => {
  const harness = makeOrchestratorStub({
    patternReinforcementEnabled: false,
    patternReinforcementCadenceMs: 0,
    patternReinforcementCategories: ["preference"],
    patternReinforcementMinCount: 3,
  });
  const result = await harness.orchestrator.runPatternReinforcement({ force: true });
  assert.equal(result.ran, false, "must not run when disabled, even with force=true");
  assert.equal(result.skippedReason, "disabled");
  assert.equal(
    harness.getStorageReadCalls(),
    0,
    "storage must not be read when feature is disabled",
  );
});

test("runPatternReinforcement: enabled + cadence not yet elapsed + force=false skips with cadence", async () => {
  const harness = makeOrchestratorStub({
    patternReinforcementEnabled: true,
    patternReinforcementCadenceMs: 60_000,
    patternReinforcementCategories: ["preference"],
    patternReinforcementMinCount: 3,
  });
  harness.orchestrator.lastPatternReinforcementAtByNs.set("", Date.now());
  const result = await harness.orchestrator.runPatternReinforcement({});
  assert.equal(result.ran, false);
  assert.equal(result.skippedReason, "cadence");
});

test("runPatternReinforcement: enabled + force=true bypasses cadence (the only legitimate use of force)", async () => {
  const harness = makeOrchestratorStub({
    patternReinforcementEnabled: true,
    patternReinforcementCadenceMs: 60_000,
    patternReinforcementCategories: ["preference"],
    patternReinforcementMinCount: 3,
  });
  harness.orchestrator.lastPatternReinforcementAtByNs.set("", Date.now());
  const result = await harness.orchestrator.runPatternReinforcement({ force: true });
  assert.equal(result.ran, true, "force=true must bypass cadence when feature is enabled");
  assert.ok(
    harness.getStorageReadCalls() >= 1,
    "storage must have been read on a successful run",
  );
});

test("runPatternReinforcement: enabled + cadence elapsed runs without force", async () => {
  const harness = makeOrchestratorStub({
    patternReinforcementEnabled: true,
    patternReinforcementCadenceMs: 1_000,
    patternReinforcementCategories: ["preference"],
    patternReinforcementMinCount: 3,
  });
  harness.orchestrator.lastPatternReinforcementAtByNs.set("", 0);
  const result = await harness.orchestrator.runPatternReinforcement({});
  assert.equal(result.ran, true);
});
