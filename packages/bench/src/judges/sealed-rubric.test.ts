import assert from "node:assert/strict";
import test from "node:test";

import { parseRubricResponse } from "./sealed-rubric.ts";

test("parseRubricResponse accepts nested scores objects from structured judges", () => {
  const parsed = parseRubricResponse(
    JSON.stringify({
      scores: {
        identity_accuracy: "4",
        stance_coherence: 3,
        novelty: 5,
        calibration: "4.5",
      },
      notes: "valid nested score payload",
    }),
  );

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.scores, {
    identity_accuracy: 4,
    stance_coherence: 3,
    novelty: 5,
    calibration: 4.5,
  });
  assert.equal(parsed.notes, "valid nested score payload");
});

test("parseRubricResponse prefers complete nested scores over partial top-level dimensions", () => {
  const parsed = parseRubricResponse(
    JSON.stringify({
      scores: {
        identity_accuracy: 4,
        stance_coherence: 3,
        novelty: 5,
        calibration: 4,
      },
      identity_accuracy: 1,
      notes: "nested score payload wins",
    }),
  );

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.scores, {
    identity_accuracy: 4,
    stance_coherence: 3,
    novelty: 5,
    calibration: 4,
  });
  assert.equal(parsed.notes, "nested score payload wins");
});

test("parseRubricResponse prefers nested scores over invalid complete top-level dimensions", () => {
  const parsed = parseRubricResponse(
    JSON.stringify({
      scores: {
        identity_accuracy: 4,
        stance_coherence: 3,
        novelty: 5,
        calibration: 4,
      },
      identity_accuracy: null,
      stance_coherence: "",
      novelty: {},
      calibration: [],
      notes: "valid nested scores",
    }),
  );

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.scores, {
    identity_accuracy: 4,
    stance_coherence: 3,
    novelty: 5,
    calibration: 4,
  });
  assert.equal(parsed.notes, "valid nested scores");
});

test("parseRubricResponse still rejects payloads without all rubric dimensions", () => {
  const parsed = parseRubricResponse(
    JSON.stringify({
      scores: {
        identity_accuracy: 4,
        novelty: 5,
        calibration: 4,
      },
      notes: "missing stance",
    }),
  );

  assert.equal(parsed.ok, false);
  assert.match(parsed.notes, /missing dimension stance_coherence/);
});
