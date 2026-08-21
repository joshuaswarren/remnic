import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import {
  resolveAccessSetupCapabilities,
  type AccessSetupCapabilitySet,
} from "./capabilities.js";

/**
 * Parity tests for the access-setup capability set (issue #1566 Cluster B).
 *
 * Every access-setup capability field must project from its `<field>Enabled`
 * config flag, and the default-off semantics for both flags must be preserved.
 */

const ACCESS_FIELD_TO_FLAG: Record<keyof AccessSetupCapabilitySet, string> = {
  recallCrossNamespaceBudget: "recallCrossNamespaceBudgetEnabled",
  recallAuditAnomalyDetection: "recallAuditAnomalyDetectionEnabled",
  recallSingleFlight: "recallSingleFlightEnabled",
};

const ACCESS_FIELDS = Object.keys(ACCESS_FIELD_TO_FLAG) as Array<
  keyof AccessSetupCapabilitySet
>;

test("resolveAccessSetupCapabilities projects every field from its flag (true variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(ACCESS_FIELD_TO_FLAG)) overrides[flag] = true;
  const config = parseConfig(overrides);
  const accessCaps = resolveAccessSetupCapabilities(config);

  for (const field of ACCESS_FIELDS) {
    const flag = ACCESS_FIELD_TO_FLAG[field];
    assert.equal(
      accessCaps[field],
      (config as unknown as Record<string, boolean>)[flag],
      `accessCaps.${field} must equal config.${flag} (true variant)`,
    );
  }
});

test("resolveAccessSetupCapabilities projects every field from its flag (false variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(ACCESS_FIELD_TO_FLAG)) overrides[flag] = false;
  const config = parseConfig(overrides);
  const accessCaps = resolveAccessSetupCapabilities(config);

  for (const field of ACCESS_FIELDS) {
    assert.equal(
      accessCaps[field],
      false,
      `accessCaps.${field} must be false when its flag is false`,
    );
  }
});

test("resolveAccessSetupCapabilities preserves default-off semantics when flags are undefined", () => {
  // parseConfig with no overrides exercises the documented defaults. Both
  // access-setup flags default to false.
  const config = parseConfig({});
  const accessCaps = resolveAccessSetupCapabilities(config);

  assert.equal(
    accessCaps.recallCrossNamespaceBudget,
    false,
    "recallCrossNamespaceBudget must default to false",
  );
  assert.equal(
    accessCaps.recallAuditAnomalyDetection,
    false,
    "recallAuditAnomalyDetection must default to false",
  );
});

test("resolveAccessSetupCapabilities returns a frozen object", () => {
  const accessCaps = resolveAccessSetupCapabilities(parseConfig({}));
  assert.equal(Object.isFrozen(accessCaps), true, "AccessSetupCapabilitySet must be frozen");
});
