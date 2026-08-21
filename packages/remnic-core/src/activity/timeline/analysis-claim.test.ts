import assert from "node:assert/strict";
import test from "node:test";

import { parseClaimObservationId } from "./analysis-claim.js";

test("ok claim returns trimmed observationId", () => {
  assert.deepEqual(parseClaimObservationId({ observationId: "obs-1" }), {
    ok: true,
    observationId: "obs-1",
  });
});

test("missing observationId is missing_observation", () => {
  assert.deepEqual(parseClaimObservationId({}), { ok: false, error: "missing_observation" });
});

test("empty observationId is missing_observation", () => {
  assert.deepEqual(parseClaimObservationId({ observationId: "" }), {
    ok: false,
    error: "missing_observation",
  });
});

test("trims observationId and treats whitespace as missing", () => {
  assert.deepEqual(parseClaimObservationId({ observationId: "  obs-1  " }), {
    ok: true,
    observationId: "obs-1",
  });
  assert.deepEqual(parseClaimObservationId({ observationId: "   " }), {
    ok: false,
    error: "missing_observation",
  });
});
