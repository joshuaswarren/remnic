import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PROJECTION_REBUILD_HEAP_USAGE_LIMIT,
  parseProjectionRebuildHeapUsageLimit,
  parseProjectionRebuildScheduleConfig,
} from "./projection-rebuild-config.js";

const parseIntegerAtLeast: Parameters<typeof parseProjectionRebuildScheduleConfig>[1] = (
  value,
  fallback,
  min,
  keyName,
) => {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    throw new Error(`${keyName} must be an integer >= ${min}; got ${JSON.stringify(value)}`);
  }
  return n;
};

test("parseProjectionRebuildHeapUsageLimit defaults and accepts (0, 1]", () => {
  assert.equal(parseProjectionRebuildHeapUsageLimit(undefined), DEFAULT_PROJECTION_REBUILD_HEAP_USAGE_LIMIT);
  assert.equal(parseProjectionRebuildHeapUsageLimit(null), DEFAULT_PROJECTION_REBUILD_HEAP_USAGE_LIMIT);
  assert.equal(DEFAULT_PROJECTION_REBUILD_HEAP_USAGE_LIMIT, 0.6);
  assert.equal(parseProjectionRebuildHeapUsageLimit(0.5), 0.5);
  assert.equal(parseProjectionRebuildHeapUsageLimit("0.75"), 0.75);
  assert.equal(parseProjectionRebuildHeapUsageLimit(1), 1);
});

test("parseProjectionRebuildHeapUsageLimit rejects 0, negatives, and non-numbers", () => {
  assert.throws(() => parseProjectionRebuildHeapUsageLimit(0), /projectionRebuildHeapUsageLimit/);
  assert.throws(() => parseProjectionRebuildHeapUsageLimit(-0.1), /projectionRebuildHeapUsageLimit/);
  assert.throws(() => parseProjectionRebuildHeapUsageLimit(1.01), /projectionRebuildHeapUsageLimit/);
  assert.throws(() => parseProjectionRebuildHeapUsageLimit(Number.NaN), /projectionRebuildHeapUsageLimit/);
  assert.throws(() => parseProjectionRebuildHeapUsageLimit("abc"), /projectionRebuildHeapUsageLimit/);
  assert.throws(() => parseProjectionRebuildHeapUsageLimit({}), /projectionRebuildHeapUsageLimit/);
});

test("parseProjectionRebuildScheduleConfig defaults and coerces booleans", () => {
  const defaults = parseProjectionRebuildScheduleConfig({}, parseIntegerAtLeast);
  assert.equal(defaults.projectionRebuildEnabled, true);
  assert.equal(defaults.projectionRebuildIntervalMs, 6 * 60 * 60 * 1000);
  assert.equal(defaults.projectionRebuildHeapUsageLimit, 0.6);

  const disabled = parseProjectionRebuildScheduleConfig(
    { projectionRebuildEnabled: "false", projectionRebuildIntervalMs: 120_000, projectionRebuildHeapUsageLimit: 0.4 },
    parseIntegerAtLeast,
  );
  assert.equal(disabled.projectionRebuildEnabled, false);
  assert.equal(disabled.projectionRebuildIntervalMs, 120_000);
  assert.equal(disabled.projectionRebuildHeapUsageLimit, 0.4);
});

test("parseProjectionRebuildScheduleConfig floors the interval via the integer parser", () => {
  assert.throws(
    () =>
      parseProjectionRebuildScheduleConfig(
        { projectionRebuildIntervalMs: 59_999 },
        parseIntegerAtLeast,
      ),
    /projectionRebuildIntervalMs/,
  );
  assert.throws(
    () =>
      parseProjectionRebuildScheduleConfig(
        { projectionRebuildIntervalMs: 90_000.5 },
        parseIntegerAtLeast,
      ),
    /projectionRebuildIntervalMs/,
  );
  const ok = parseProjectionRebuildScheduleConfig(
    { projectionRebuildIntervalMs: 60_000 },
    parseIntegerAtLeast,
  );
  assert.equal(ok.projectionRebuildIntervalMs, 60_000);
});
