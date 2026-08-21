import assert from "node:assert/strict";
import test from "node:test";

import type { ReconcileConflictPolicy } from "./reconcile/plan.js";
import type { ConvergeConflictPolicy } from "./types.js";

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
  ? true
  : false;

const conflictPolicyNamesAreEquivalent: Equal<ReconcileConflictPolicy, ConvergeConflictPolicy> = true;

test("ReconcileConflictPolicy remains a type alias for ConvergeConflictPolicy", () => {
  assert.equal(conflictPolicyNamesAreEquivalent, true);
});
