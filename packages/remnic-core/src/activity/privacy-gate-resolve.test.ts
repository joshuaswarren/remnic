import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVITY_FEATURE_GATES,
  resolveActivityGates,
} from "./privacy-gate-resolve.js";

function allTrue(): Record<string, unknown> {
  return { analysis: true, journal: true, weekly: true, export: true, memoryCreation: true };
}

function allFalse(gates: Record<string, boolean>): boolean {
  return ACTIVITY_FEATURE_GATES.every((gate) => gates[gate] === false);
}

test("master off forces every explicitly-true gate false", () => {
  const gates = resolveActivityGates({ enabled: false, gates: allTrue() });
  for (const gate of ACTIVITY_FEATURE_GATES) {
    assert.equal(gates[gate], false, `gate "${gate}" must be false`);
  }
});

test("master absent behaves as off even with all gates true", () => {
  const gates = resolveActivityGates({ gates: allTrue() });
  assert.ok(allFalse(gates));
});

test("master on with no gates yields all false", () => {
  const gates = resolveActivityGates({ enabled: true });
  assert.ok(allFalse(gates));
  const empty = resolveActivityGates({ enabled: true, gates: {} });
  assert.ok(allFalse(empty));
});

test("master on with one gate on leaves the other four off", () => {
  for (const gate of ACTIVITY_FEATURE_GATES) {
    const gates = resolveActivityGates({ enabled: true, gates: { [gate]: true } });
    for (const other of ACTIVITY_FEATURE_GATES) {
      assert.equal(gates[other], other === gate, `gate "${gate}" case: "${other}" wrong`);
    }
  }
});

test("master on accepts boolean and string token values", () => {
  const on = resolveActivityGates({
    enabled: true,
    gates: { analysis: "true", journal: "1", weekly: "yes", export: "on" },
  });
  assert.equal(on.analysis, true);
  assert.equal(on.journal, true);
  assert.equal(on.weekly, true);
  assert.equal(on.export, true);

  const off = resolveActivityGates({
    enabled: "true",
    gates: { analysis: "false", journal: "0", weekly: "no", export: "off" },
  });
  assert.equal(off.analysis, false);
  assert.equal(off.journal, false);
  assert.equal(off.weekly, false);
  assert.equal(off.export, false);
});

test("unrecognized gate values throw TypeError naming the gate", () => {
  for (const value of ["maybe", 2, {}, null]) {
    assert.throws(
      () => resolveActivityGates({ enabled: true, gates: { weekly: value } }),
      (err: unknown) =>
        err instanceof TypeError && String(err).includes('"weekly"'),
      `value ${JSON.stringify(value)} must throw`,
    );
  }
});

test("unrecognized gate values throw even when master is off", () => {
  assert.throws(
    () => resolveActivityGates({ enabled: false, gates: { journal: "maybe" } }),
    TypeError,
  );
});

test("unknown gate key throws and lists the allow-list", () => {
  assert.throws(
    () => resolveActivityGates({ enabled: true, gates: { analytics: true } }),
    (err: unknown) =>
      err instanceof TypeError &&
      /unknown activity gate/.test(String(err)) &&
      ACTIVITY_FEATURE_GATES.every((gate) => String(err).includes(gate)),
  );
});

test("result contains exactly the five gate keys", () => {
  const gates = resolveActivityGates({ enabled: true, gates: allTrue() });
  assert.deepEqual(Object.keys(gates).sort(), [...ACTIVITY_FEATURE_GATES].sort());
});

test("result is frozen and resists mutation", () => {
  const gates = resolveActivityGates({ enabled: true, gates: { analysis: true } });
  assert.equal(Object.isFrozen(gates), true);
  assert.equal(Reflect.set(gates, "analysis", false), false);
  assert.equal(Reflect.set(gates, "journal", true), false);
  assert.equal(gates.analysis, true);
  assert.equal(gates.journal, false);
});

test("input gates object is not mutated", () => {
  const input = { analysis: "yes" };
  resolveActivityGates({ enabled: true, gates: input });
  assert.deepEqual(input, { analysis: "yes" });
});
