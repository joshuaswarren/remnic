import assert from "node:assert/strict";
import test from "node:test";

import { boundEvidence } from "./analysis-evidence.js";

function claim(observationId: number, title: string) {
  return { observationId, title };
}

function observation(id: number) {
  return { id };
}

test("drops claims whose observationId is missing", () => {
  const kept = boundEvidence(
    [claim(1, "first"), claim(99, "ghost"), claim(2, "second")],
    [observation(1), observation(2)],
  );
  assert.deepEqual(kept, [claim(1, "first"), claim(2, "second")]);
});

test("keeps claim order", () => {
  const kept = boundEvidence(
    [claim(3, "third"), claim(1, "first"), claim(2, "second")],
    [observation(1), observation(2), observation(3)],
  );
  assert.deepEqual(kept, [claim(3, "third"), claim(1, "first"), claim(2, "second")]);
});

test("empty observations return no claims", () => {
  assert.deepEqual(boundEvidence([claim(1, "first")], []), []);
});
