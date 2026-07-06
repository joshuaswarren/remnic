import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import { resolveCapabilities, type CapabilitySet } from "./capabilities.js";

/**
 * Characterization tests for the recall-operation CapabilitySet (issue #1523).
 *
 * These guard against composition drift: every capability field must project
 * from its `<field>Enabled` config flag, so a future edit to
 * `resolveCapabilities` that accidentally maps a field to the wrong flag (the
 * rule-39 gate-divergence class, moved up one layer) fails loudly here.
 */

/**
 * Map of CapabilitySet field → the PluginConfig flag it projects from.
 * Kept explicit (rather than derived by string concat) so the two graph flags
 * with non-`<field>Enabled` names are covered too.
 */
const FIELD_TO_FLAG: Record<keyof CapabilitySet, string> = {
  rerankCache: "rerankCacheEnabled",
  recallDirectAnswer: "recallDirectAnswerEnabled",
  recallMemoryWorthFilter: "recallMemoryWorthFilterEnabled",
  recallTrustScore: "trustScoreEnabled",
  recallMmr: "recallMmrEnabled",
  recallReasoningTraceBoost: "recallReasoningTraceBoostEnabled",
  recallPlannerLlm: "recallPlannerLlmEnabled",
  recallPlanner: "recallPlannerEnabled",
  recallConfidenceGate: "recallConfidenceGateEnabled",
  graphRecall: "graphRecallEnabled",
  graphAssistInFullMode: "graphAssistInFullModeEnabled",
  graphExpandedIntent: "graphExpandedIntentEnabled",
};

const FIELDS = Object.keys(FIELD_TO_FLAG) as Array<keyof CapabilitySet>;

test("resolveCapabilities projects every field from its <field>Enabled flag (true variant)", () => {
  // Build a config where every migrated flag is explicitly true.
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(FIELD_TO_FLAG)) overrides[flag] = true;
  const config = parseConfig(overrides);
  const caps = resolveCapabilities(config);

  for (const field of FIELDS) {
    const flag = FIELD_TO_FLAG[field];
    assert.equal(
      caps[field],
      (config as unknown as Record<string, boolean>)[flag],
      `caps.${field} must equal config.${flag} (true variant)`,
    );
    assert.equal(caps[field], true, `caps.${field} should be true here`);
  }
});

test("resolveCapabilities projects every field from its <field>Enabled flag (false variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(FIELD_TO_FLAG)) overrides[flag] = false;
  const config = parseConfig(overrides);
  const caps = resolveCapabilities(config);

  for (const field of FIELDS) {
    const flag = FIELD_TO_FLAG[field];
    // The two optional graph flags carry default-when-undefined semantics, but
    // when explicitly set to a concrete boolean the projection must match it.
    assert.equal(
      caps[field],
      (config as unknown as Record<string, boolean>)[flag],
      `caps.${field} must equal config.${flag} (false variant)`,
    );
    assert.equal(caps[field], false, `caps.${field} should be false here`);
  }
});

test("resolveCapabilities preserves optional-flag defaults when the flag is undefined", () => {
  // parseConfig with no overrides exercises the documented defaults. The two
  // optional graph flags encode asymmetric defaults on purpose:
  //   graphAssistInFullModeEnabled → default-ON  (`!== false`)
  //   graphExpandedIntentEnabled    → default-OFF (`=== true`)
  const config = parseConfig({});
  const caps = resolveCapabilities(config);

  assert.equal(
    caps.graphAssistInFullMode,
    config.graphAssistInFullModeEnabled !== false,
    "graphAssistInFullMode must be default-on unless explicitly false",
  );
  assert.equal(
    caps.graphExpandedIntent,
    config.graphExpandedIntentEnabled === true,
    "graphExpandedIntent must be default-off unless explicitly true",
  );
});

test("resolveCapabilities returns a frozen object", () => {
  const caps = resolveCapabilities(parseConfig({}));
  assert.equal(Object.isFrozen(caps), true, "CapabilitySet must be frozen");
});

test("resolveCapabilities is deterministic — same config always yields identical gate values (one-resolution-per-op #1523)", () => {
  // The one-resolution-per-op contract (issue #1523): resolve ONCE at the
  // operation entry, thread the frozen result down. This test proves the
  // resolution is deterministic — calling it twice with the same config
  // produces identical values for every gate, so there is never a reason to
  // re-resolve mid-operation.
  const config = parseConfig({
    rerankCacheEnabled: true,
    recallDirectAnswerEnabled: false,
    recallMmrEnabled: true,
    recallPlannerLlmEnabled: true,
    graphRecallEnabled: true,
  });
  const first = resolveCapabilities(config);
  const second = resolveCapabilities(config);
  for (const field of FIELDS) {
    assert.equal(
      first[field],
      second[field],
      `field ${field} must be deterministic across resolutions`,
    );
  }
  // Both must be frozen — a mid-operation mutation would break the contract.
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(second), true);
});


// ---------------------------------------------------------------------------
// GraphConstructionCapabilitySet — gate-parity tests (issue #1566 Cluster A).
//
// Same invariant as the recall CapabilitySet tests above: every caps field
// must project from its `<field>Enabled` config flag, so a future edit to
// `resolveGraphConstructionCapabilities` that maps a field to the wrong flag
// (or drops the `!== false` default for the optional session-adjacency flag)
// fails loudly here.
//
// Parity contract: a caps-resolved run and a config-derived run MUST produce
// identical boolean values for every gate — on AND off. These tests are the
// executable proof of that contract.
// ---------------------------------------------------------------------------

import {
  resolveGraphConstructionCapabilities,
  type GraphConstructionCapabilitySet,
} from "./capabilities.js";

const GRAPH_FIELD_TO_FLAG: Record<keyof GraphConstructionCapabilitySet, string> = {
  entityGraph: "entityGraphEnabled",
  timeGraph: "timeGraphEnabled",
  causalGraph: "causalGraphEnabled",
  multiGraphMemory: "multiGraphMemoryEnabled",
  graphWriteSessionAdjacency: "graphWriteSessionAdjacencyEnabled",
};

const GRAPH_FIELDS = Object.keys(GRAPH_FIELD_TO_FLAG) as Array<
  keyof GraphConstructionCapabilitySet
>;

test("resolveGraphConstructionCapabilities projects every field from its flag (true variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(GRAPH_FIELD_TO_FLAG)) overrides[flag] = true;
  const config = parseConfig(overrides);
  const graphCaps = resolveGraphConstructionCapabilities(config);

  for (const field of GRAPH_FIELDS) {
    const flag = GRAPH_FIELD_TO_FLAG[field];
    assert.equal(
      graphCaps[field],
      (config as unknown as Record<string, boolean>)[flag],
      `graphCaps.${field} must equal config.${flag} (true variant)`,
    );
    assert.equal(graphCaps[field], true, `graphCaps.${field} should be true here`);
  }
});

test("resolveGraphConstructionCapabilities projects every field from its flag (false variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(GRAPH_FIELD_TO_FLAG)) overrides[flag] = false;
  const config = parseConfig(overrides);
  const graphCaps = resolveGraphConstructionCapabilities(config);

  for (const field of GRAPH_FIELDS) {
    const flag = GRAPH_FIELD_TO_FLAG[field];
    assert.equal(
      graphCaps[field],
      (config as unknown as Record<string, boolean>)[flag],
      `graphCaps.${field} must equal config.${flag} (false variant)`,
    );
    assert.equal(graphCaps[field], false, `graphCaps.${field} should be false here`);
  }
});

test("resolveGraphConstructionCapabilities preserves graphWriteSessionAdjacency default-on when undefined", () => {
  // graphWriteSessionAdjacencyEnabled is optional — `!== false` means
  // default-ON. This is the exact semantics the migrated call site used
  // (orchestrator.ts buildGraphEdge), and the parity test below verifies
  // the caps resolver does not drift from it.
  const config = parseConfig({});
  const graphCaps = resolveGraphConstructionCapabilities(config);

  assert.equal(
    graphCaps.graphWriteSessionAdjacency,
    config.graphWriteSessionAdjacencyEnabled !== false,
    "graphWriteSessionAdjacency must be default-on unless explicitly false",
  );
  assert.equal(
    graphCaps.graphWriteSessionAdjacency,
    true,
    "with no explicit override, graphWriteSessionAdjacency should be true",
  );

  // Explicit-false must propagate (not get swallowed by the default).
  const disabled = parseConfig({ graphWriteSessionAdjacencyEnabled: false });
  assert.equal(
    resolveGraphConstructionCapabilities(disabled).graphWriteSessionAdjacency,
    false,
    "explicit false must disable graphWriteSessionAdjacency",
  );
});

test("resolveGraphConstructionCapabilities returns a frozen object", () => {
  const graphCaps = resolveGraphConstructionCapabilities(parseConfig({}));
  assert.equal(Object.isFrozen(graphCaps), true, "GraphConstructionCapabilitySet must be frozen");
});

test("resolveGraphConstructionCapabilities matches pre-migration config reads (parity contract)", () => {
  // This is the core parity test: for EVERY combination of the 5 cluster-A
  // flags, the caps-resolved values MUST be identical to what the old
  // scattered `this.config.<flag>Enabled` reads would have produced.
  //
  // We exercise representative combinations rather than the full 2^5 space
  // (32 cases) to keep the test cheap, but we cover:
  //   - all-off (the "no graphs" baseline)
  //   - all-on (the "full graph" mode)
  //   - only entity graph
  //   - multiGraph off but others on (the recall-without-write split)
  //   - session-adjacency undefined vs explicit-false
  const cases: Record<string, Record<string, boolean | undefined>> = {
    "all-off": {
      entityGraphEnabled: false,
      timeGraphEnabled: false,
      causalGraphEnabled: false,
      multiGraphMemoryEnabled: false,
      graphWriteSessionAdjacencyEnabled: false,
    },
    "all-on": {
      entityGraphEnabled: true,
      timeGraphEnabled: true,
      causalGraphEnabled: true,
      multiGraphMemoryEnabled: true,
      graphWriteSessionAdjacencyEnabled: true,
    },
    "entity-only": {
      entityGraphEnabled: true,
      timeGraphEnabled: false,
      causalGraphEnabled: false,
      multiGraphMemoryEnabled: true,
      graphWriteSessionAdjacencyEnabled: true,
    },
    "multigraph-off": {
      entityGraphEnabled: true,
      timeGraphEnabled: true,
      causalGraphEnabled: true,
      multiGraphMemoryEnabled: false,
      graphWriteSessionAdjacencyEnabled: true,
    },
    "session-adj-undefined": {
      entityGraphEnabled: true,
      timeGraphEnabled: true,
      causalGraphEnabled: true,
      multiGraphMemoryEnabled: true,
      // graphWriteSessionAdjacencyEnabled deliberately omitted
    },
  };

  for (const [label, overrides] of Object.entries(cases)) {
    const config = parseConfig(overrides);
    const graphCaps = resolveGraphConstructionCapabilities(config);

    // Parity: each caps field must equal the pre-migration config read.
    // entityGraph/timeGraph/causalGraph/multiGraphMemory used bare reads:
    //   config.entityGraphEnabled  → graphCaps.entityGraph
    // graphWriteSessionAdjacency used `!== false`:
    //   config.graphWriteSessionAdjacencyEnabled !== false  → graphCaps.graphWriteSessionAdjacency
    assert.equal(graphCaps.entityGraph, config.entityGraphEnabled, `[${label}] entityGraph parity`);
    assert.equal(graphCaps.timeGraph, config.timeGraphEnabled, `[${label}] timeGraph parity`);
    assert.equal(graphCaps.causalGraph, config.causalGraphEnabled, `[${label}] causalGraph parity`);
    assert.equal(
      graphCaps.multiGraphMemory,
      config.multiGraphMemoryEnabled,
      `[${label}] multiGraphMemory parity`,
    );
    assert.equal(
      graphCaps.graphWriteSessionAdjacency,
      config.graphWriteSessionAdjacencyEnabled !== false,
      `[${label}] graphWriteSessionAdjacency parity (must match !== false)`,
    );
  }
});
