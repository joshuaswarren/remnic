import assert from "node:assert/strict";
import test from "node:test";

import { ACTIVITY_ANALYSIS_STATUSES, buildActivityHealth } from "./privacy-status.js";

const base = {
  enabled: true,
  retentionDays: 30,
  sourceRevision: "rev-42",
  lastAnalysisStatus: "ok",
  observationCount: 7,
  cardCount: 3,
} as const;

test("enabled true returns full snapshot with trimmed revision", () => {
  const snapshot = buildActivityHealth({ ...base, sourceRevision: "  rev-42  " });
  assert.deepEqual(snapshot, {
    enabled: true,
    retentionDays: 30,
    sourceRevision: "rev-42",
    lastAnalysisStatus: "ok",
    observationCount: 7,
    cardCount: 3,
  });
});

test("snapshot keys equal the documented set", () => {
  const snapshot = buildActivityHealth({ ...base });
  assert.deepEqual(Object.keys(snapshot), [
    "enabled",
    "retentionDays",
    "sourceRevision",
    "lastAnalysisStatus",
    "observationCount",
    "cardCount",
  ]);
});

test("enabled false still returns snapshot with counts as given", () => {
  const snapshot = buildActivityHealth({
    ...base,
    enabled: false,
    observationCount: 9,
    cardCount: 0,
  });
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.retentionDays, 30);
  assert.equal(snapshot.observationCount, 9);
  assert.equal(snapshot.cardCount, 0);
});

test("retentionDays 0 (keep forever) is preserved", () => {
  assert.equal(buildActivityHealth({ ...base, retentionDays: 0 }).retentionDays, 0);
});

test("retentionDays must be a non-negative integer", () => {
  assert.throws(
    () => buildActivityHealth({ ...base, retentionDays: -1 }),
    { name: "RangeError", message: /retentionDays/ },
  );
  assert.throws(() => buildActivityHealth({ ...base, retentionDays: 1.5 }), /retentionDays/);
});

test("null or missing sourceRevision maps to null", () => {
  const nulled = buildActivityHealth({ ...base, sourceRevision: null });
  const missing = buildActivityHealth({ ...base, sourceRevision: undefined });
  assert.equal(nulled.sourceRevision, null);
  assert.equal(missing.sourceRevision, null);
});

test("trimmed-blank sourceRevision maps to null", () => {
  const blank = buildActivityHealth({ ...base, sourceRevision: "   \t " });
  const empty = buildActivityHealth({ ...base, sourceRevision: "" });
  assert.equal(blank.sourceRevision, null);
  assert.equal(empty.sourceRevision, null);
});

test("missing lastAnalysisStatus defaults to never", () => {
  const missing = buildActivityHealth({ ...base, lastAnalysisStatus: undefined });
  const nulled = buildActivityHealth({ ...base, lastAnalysisStatus: null });
  assert.equal(missing.lastAnalysisStatus, "never");
  assert.equal(nulled.lastAnalysisStatus, "never");
});

test("each allow-list status round-trips", () => {
  for (const status of ACTIVITY_ANALYSIS_STATUSES) {
    const snapshot = buildActivityHealth({ ...base, lastAnalysisStatus: status });
    assert.equal(snapshot.lastAnalysisStatus, status);
  }
});

test("unknown analysis status throws listing the allow-list", () => {
  assert.throws(
    () => buildActivityHealth({ ...base, lastAnalysisStatus: "pending" }),
    (err: unknown) => {
      assert.ok(err instanceof TypeError);
      assert.match(err.message, /analysis status/);
      for (const status of ACTIVITY_ANALYSIS_STATUSES) {
        assert.ok(err.message.includes(status), `message lists ${status}`);
      }
      return true;
    },
  );
});

test("negative or non-integer counts throw", () => {
  assert.throws(
    () => buildActivityHealth({ ...base, observationCount: -1 }),
    { name: "RangeError", message: /count/ },
  );
  assert.throws(
    () => buildActivityHealth({ ...base, cardCount: -2 }),
    { name: "RangeError", message: /count/ },
  );
  assert.throws(() => buildActivityHealth({ ...base, observationCount: 1.5 }), /count/);
  assert.throws(() => buildActivityHealth({ ...base, cardCount: Number.NaN }), /count/);
});
