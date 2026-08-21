import assert from "node:assert/strict";
import test from "node:test";

import { labelStateView } from "./recall-state-view-label.js";

const DATE = "2026-03-01";
const SUCCESSOR = "new-job";

test("kind current is current", () => {
  assert.equal(
    labelStateView({ kind: "current", supersededAt: DATE, successorId: SUCCESSOR }),
    "current",
  );
});

test("kind historical with both fields is historical", () => {
  assert.equal(
    labelStateView({ kind: "historical", supersededAt: DATE, successorId: SUCCESSOR }),
    "historical",
  );
});

test("missing supersededAt or successorId is current", () => {
  assert.equal(
    labelStateView({ kind: "historical", successorId: SUCCESSOR }),
    "current",
  );
  assert.equal(
    labelStateView({ kind: "transition", supersededAt: DATE }),
    "current",
  );
});

test("unknown kind throws", () => {
  assert.throws(() => labelStateView({ kind: "ghost" }), /unknown state view kind/);
});
