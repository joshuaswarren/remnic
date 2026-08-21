/**
 * Unit tests for `Orchestrator.runPatternReinforcement` (issue #687
 * PR 2/4) focused on the gate semantics — specifically that
 * `force: true` only bypasses the cadence floor and NEVER bypasses
 * the master `patternReinforcementEnabled` flag (PR #730 review
 * feedback, Cursor Medium).
 */

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
  // Minimal storage stub so that if the gate is (incorrectly) bypassed
  // we still observe a side effect we can assert against.
  orchestrator.storage = {
    readAllMemories: async () => {
      storageReadCalls += 1;
      return [];
    },
    writeMemoryFrontmatter: async () => true,
  };
  // Test should never reach the per-namespace storage path; if it
  // does, fail loudly.
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
  // The fix: a disabled feature must remain disabled regardless of
  // force=true.  The MCP tool description and PR description both
  // state `force` only relaxes the cadence floor.  Operators who
  // have explicitly turned the feature off (the default) must not
  // see corpus mutations from a tool call.
  const harness = makeOrchestratorStub({
    patternReinforcementEnabled: false,
    patternReinforcementCadenceMs: 0,
    patternReinforcementCategories: ["preference"],
    patternReinforcementMinCount: 3,
  });
  const result = await harness.orchestrator.runPatternReinforcement({ force: true });
  assert.equal(result.ran, false, "must not run when disabled, even with force=true");
  assert.equal(result.skippedReason, "disabled");
  // Corpus must not have been touched.
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
  // Pretend a run just happened.
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
  // Pretend a run just happened — cadence would normally block.
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
  // Last run was a long time ago.
  harness.orchestrator.lastPatternReinforcementAtByNs.set("", 0);
  const result = await harness.orchestrator.runPatternReinforcement({});
  assert.equal(result.ran, true);
});
