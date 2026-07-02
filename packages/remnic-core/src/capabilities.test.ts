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
