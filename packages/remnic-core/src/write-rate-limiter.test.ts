import assert from "node:assert/strict";
import test from "node:test";

import { log } from "./logger.js";
import { WriteRateLimiter } from "./write-rate-limiter.js";

test("WriteRateLimiter: defaults applied when unset or invalid (issue #1937)", () => {
  assert.equal(new WriteRateLimiter().maxRequests, 30);
  assert.equal(new WriteRateLimiter().windowMs, 60_000);
  assert.equal(new WriteRateLimiter(0).maxRequests, 30, "0 is invalid -> default");
  assert.equal(new WriteRateLimiter(1.5).maxRequests, 30, "non-integer -> default");
  const custom = new WriteRateLimiter(120, 30_000);
  assert.equal(custom.maxRequests, 120);
  assert.equal(custom.windowMs, 30_000);
});

test("WriteRateLimiter: capacity check, record, and sampled rejection logging (issue #2029)", () => {
  const limiter = new WriteRateLimiter(1, 60_000);
  const warnings: string[] = [];
  const originalWarn = log.warn;
  log.warn = (msg: string) => {
    warnings.push(msg);
  };
  try {
    assert.equal(limiter.hasCapacity(), true);
    limiter.record();
    assert.equal(limiter.hasCapacity(), false, "over the limit after one recorded write");
    assert.equal(limiter.hasCapacity(), false);
    assert.ok(
      warnings.some((w) => w.includes("write_rate_limited")),
      "a refused write is logged server-side"
    );
    assert.equal(warnings.length, 1, "logging is sampled within the interval, not per-refusal");
  } finally {
    log.warn = originalWarn;
  }
});

test("WriteRateLimiter: reserve returns a release, refuses at the limit, frees on release", () => {
  const limiter = new WriteRateLimiter(1, 60_000);
  const reservation = limiter.reserve();
  assert.ok(reservation, "first reservation succeeds");
  assert.equal(limiter.inFlightFor(), 1);
  assert.equal(limiter.totalSlots(), 1);
  assert.equal(limiter.slotsFor().length, 0);
  assert.equal(limiter.reserve(), null, "second reservation refused at the limit");
  reservation?.release();
  assert.equal(limiter.inFlightFor(), 0, "release frees the reserved slot");
  assert.ok(limiter.reserve(), "capacity restored after release");
});

test("WriteRateLimiter: an in-flight write does not expire and commit starts its window", () => {
  const realNow = Date.now;
  try {
    let now = 1_000_000;
    Date.now = () => now;
    const limiter = new WriteRateLimiter(1, 1000);
    const reservation = limiter.reserve();
    assert.ok(reservation);
    now += 1001;
    assert.equal(limiter.reserve(), null, "an active reservation remains capacity-bound");

    reservation.commit();
    assert.equal(limiter.inFlightFor(), 0);
    assert.equal(limiter.slotsFor()[0]?.recordedAt, now);
    assert.equal(limiter.reserve(), null, "the commit starts a new rolling window");
    now += 1000;
    assert.ok(limiter.reserve(), "capacity returns when the commit window expires");
  } finally {
    Date.now = realNow;
  }
});

test("WriteRateLimiter: old slots pruned after the rolling window", () => {
  const realNow = Date.now;
  try {
    let now = 1_000_000;
    Date.now = () => now;
    const limiter = new WriteRateLimiter(1, 1000);
    limiter.record();
    assert.equal(limiter.hasCapacity(), false, "at the limit within the window");
    now += 1001;
    assert.equal(limiter.hasCapacity(), true, "slot pruned once older than the window");
  } finally {
    Date.now = realNow;
  }
});

test("WriteRateLimiter: buckets are isolated per principal (issue #2029)", () => {
  const limiter = new WriteRateLimiter(1, 60_000);
  limiter.record("alice");
  assert.equal(limiter.hasCapacity("alice"), false, "alice is at her own limit");
  assert.equal(limiter.hasCapacity("bob"), true, "bob is unaffected by alice");
  assert.equal(limiter.hasCapacity(), true, "the no-principal global bucket is separate");
  limiter.record("bob");
  assert.equal(limiter.slotsFor("alice").length, 1);
  assert.equal(limiter.slotsFor("bob").length, 1);
  assert.equal(limiter.totalSlots(), 2, "each principal keeps its own window");
});

test("WriteRateLimiter: rolling-window end is exclusive (issue #2029 review)", () => {
  const realNow = Date.now;
  try {
    let now = 1_000_000;
    Date.now = () => now;
    const limiter = new WriteRateLimiter(1, 1000);
    limiter.record();
    now += 1000; // exactly at recordedAt + windowMs
    assert.equal(limiter.hasCapacity(), true, "a slot at the exact window end is expired");
  } finally {
    Date.now = realNow;
  }
});

test("WriteRateLimiter: expired buckets from transient principals are swept globally (issue #2029 review)", () => {
  const realNow = Date.now;
  try {
    let now = 1_000_000;
    Date.now = () => now;
    const limiter = new WriteRateLimiter(5, 1000);
    limiter.record("ephemeral-1");
    limiter.record("ephemeral-2");
    assert.equal(limiter.totalSlots(), 2);
    now += 1001; // both windows expire
    assert.equal(limiter.totalSlots(), 0, "expired buckets are swept, not reported as live");
  } finally {
    Date.now = realNow;
  }
});
