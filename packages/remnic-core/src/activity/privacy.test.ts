import assert from "node:assert/strict";
import test from "node:test";

import {
  MS_PER_DAY,
  observationsForExport,
  parseActivityPrivacy,
  shouldRetain,
} from "./privacy.js";

test("retentionDays 0 keeps forever", () => {
  const policy = parseActivityPrivacy({ enabled: true, retentionDays: 0 });
  assert.equal(policy.retentionDays, 0);
  const now = 1_700_000_000_000;
  assert.equal(shouldRetain(now - 400 * MS_PER_DAY, now, policy.retentionDays), true);
  assert.equal(shouldRetain(now, now, 0), true);
});

test("negative retentionDays throws", () => {
  assert.throws(() => parseActivityPrivacy({ retentionDays: -1 }), /non-negative integer/);
  assert.throws(() => parseActivityPrivacy({ retentionDays: -30 }), /non-negative integer/);
  assert.throws(() => shouldRetain(0, 0, -1), /non-negative integer/);
});

test("exact expiry boundary is half-open", () => {
  const now = 1_700_000_000_000;
  const days = 30;
  const captured = now - days * MS_PER_DAY;
  assert.equal(shouldRetain(captured, now, days), false);
  assert.equal(shouldRetain(captured + 1, now, days), true);
  assert.equal(shouldRetain(captured - 1, now, days), false);
});

test("disabled master denies retain and empties export", () => {
  const policy = parseActivityPrivacy({
    enabled: false,
    retentionDays: 0,
    exportIncludeObservations: true,
  });
  assert.equal(policy.enabled, false);
  assert.equal(shouldRetain(1_700_000_000_000, 1_700_000_000_000, policy.retentionDays, policy.enabled), false);
  assert.deepEqual(observationsForExport(["obs"], policy), []);
  assert.equal(parseActivityPrivacy(undefined).enabled, false);
});

test("exportIncludeObservations defaults false", () => {
  assert.equal(parseActivityPrivacy(undefined).exportIncludeObservations, false);
  assert.equal(parseActivityPrivacy({ enabled: true }).exportIncludeObservations, false);
  const policy = parseActivityPrivacy({ enabled: true });
  assert.deepEqual(observationsForExport(["obs"], policy), []);
  const included = parseActivityPrivacy({ enabled: true, exportIncludeObservations: true });
  assert.deepEqual(observationsForExport(["obs"], included), ["obs"]);
});
