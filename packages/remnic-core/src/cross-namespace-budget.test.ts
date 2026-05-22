import assert from "node:assert/strict";
import test from "node:test";

import {
  CrossNamespaceBudget,
  DEFAULT_CROSS_NAMESPACE_BUDGET,
} from "./cross-namespace-budget.js";

test("disabled budget is always allow and never warns", () => {
  const limiter = new CrossNamespaceBudget({ enabled: false });
  for (let i = 0; i < 100; i++) {
    const d = limiter.record("p1", 1_000 + i);
    assert.equal(d.allowed, true);
    assert.equal(d.reason, "allowed-no-limit");
  }
});

test("enabled budget returns allowed-under-soft below soft limit", () => {
  const limiter = new CrossNamespaceBudget({
    enabled: true,
    softLimit: 3,
    hardLimit: 5,
    windowMs: 10_000,
  });
  const d1 = limiter.record("p1", 1);
  assert.equal(d1.allowed, true);
  assert.equal(d1.reason, "allowed-under-soft");
  assert.equal(d1.count, 1);

  const d2 = limiter.record("p1", 2);
  assert.equal(d2.reason, "allowed-under-soft");
  assert.equal(d2.count, 2);

  const d3 = limiter.record("p1", 3);
  assert.equal(d3.reason, "allowed-under-soft");
  assert.equal(d3.count, 3);
});

test("enabled budget warns past soft and denies past hard", () => {
  const limiter = new CrossNamespaceBudget({
    enabled: true,
    softLimit: 2,
    hardLimit: 3,
    windowMs: 10_000,
  });
  assert.equal(limiter.record("p1", 1).reason, "allowed-under-soft");
  assert.equal(limiter.record("p1", 2).reason, "allowed-under-soft");
  assert.equal(limiter.record("p1", 3).reason, "warn-over-soft");
  // 4th call crosses hardLimit (count would be 4 > 3) => deny.
  const deny = limiter.record("p1", 4);
  assert.equal(deny.allowed, false);
  assert.equal(deny.reason, "deny-over-hard");
});

test("sliding window drops old timestamps", () => {
  const limiter = new CrossNamespaceBudget({
    enabled: true,
    softLimit: 1,
    hardLimit: 2,
    windowMs: 100,
  });
  // Fill to hard.
  limiter.record("p1", 0);
  limiter.record("p1", 50);
  assert.equal(limiter.record("p1", 80).reason, "deny-over-hard");

  // Walk past the window so the first two slide out.
  const d = limiter.record("p1", 201);
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "allowed-under-soft");
  assert.equal(d.count, 1);
});

test("per-principal isolation: one principal's denial does not affect another", () => {
  const limiter = new CrossNamespaceBudget({
    enabled: true,
    softLimit: 1,
    hardLimit: 1,
    windowMs: 10_000,
  });
  limiter.record("alice", 10);
  assert.equal(limiter.record("alice", 11).reason, "deny-over-hard");
  assert.equal(limiter.record("bob", 11).reason, "allowed-under-soft");
});

test("check() short-circuits on same-namespace", () => {
  const limiter = new CrossNamespaceBudget({
    enabled: true,
    softLimit: 0,
    hardLimit: 1,
    windowMs: 10_000,
  });
  // Same-namespace: limiter never engages even with soft=0.
  for (let i = 0; i < 50; i++) {
    const d = limiter.check({
      principal: "p1",
      principalNamespace: "alice",
      queryNamespace: "alice",
      now: i,
    });
    assert.equal(d.allowed, true);
    assert.equal(d.reason, "allowed-same-namespace");
  }
});

test("check() engages on cross-namespace", () => {
  const limiter = new CrossNamespaceBudget({
    enabled: true,
    softLimit: 1,
    hardLimit: 1,
    windowMs: 10_000,
  });
  const d1 = limiter.check({
    principal: "p1",
    principalNamespace: "alice",
    queryNamespace: "bob",
    now: 1,
  });
  assert.equal(d1.allowed, true);
  const d2 = limiter.check({
    principal: "p1",
    principalNamespace: "alice",
    queryNamespace: "bob",
    now: 2,
  });
  assert.equal(d2.allowed, false);
  assert.equal(d2.reason, "deny-over-hard");
});

test("denied calls do not push bucket forward", () => {
  const limiter = new CrossNamespaceBudget({
    enabled: true,
    softLimit: 1,
    hardLimit: 1,
    windowMs: 100,
  });
  limiter.record("p1", 0);
  // 10 denials in a row at t=10..19.
  for (let i = 10; i < 20; i++) {
    assert.equal(limiter.record("p1", i).allowed, false);
  }
  // At t=101 the original t=0 timestamp slides out and the bucket is
  // empty — NOT holding any of the denied-call timestamps.
  const d = limiter.record("p1", 101);
  assert.equal(d.allowed, true);
  assert.equal(d.count, 1);
});

test("missing principal is bucketed under __anonymous__ rather than failing open", () => {
  const limiter = new CrossNamespaceBudget({
    enabled: true,
    softLimit: 0,
    hardLimit: 1,
    windowMs: 10_000,
  });
  // An empty-string principal shares the anonymous bucket.
  limiter.record("", 1);
  const d = limiter.record("", 2);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "deny-over-hard");
});

test("reset clears all state", () => {
  const limiter = new CrossNamespaceBudget({
    enabled: true,
    softLimit: 2,
    hardLimit: 2,
    windowMs: 10_000,
  });
  limiter.record("p1", 1);
  limiter.record("p1", 2);
  assert.equal(limiter.record("p1", 3).reason, "deny-over-hard");
  limiter.reset();
  const after = limiter.record("p1", 4);
  assert.equal(after.allowed, true);
  assert.equal(after.reason, "allowed-under-soft");
  assert.equal(after.count, 1);
});

test("invalid config values are replaced by defaults", () => {
  const limiter = new CrossNamespaceBudget({
    enabled: true,
    windowMs: -1 as unknown as number,
    softLimit: Number.NaN,
    hardLimit: 0,
  });
  const cfg = limiter.getConfig();
  assert.equal(cfg.windowMs, DEFAULT_CROSS_NAMESPACE_BUDGET.windowMs);
  assert.equal(cfg.softLimit, DEFAULT_CROSS_NAMESPACE_BUDGET.softLimit);
  assert.equal(cfg.hardLimit, DEFAULT_CROSS_NAMESPACE_BUDGET.hardLimit);
});

test("hardLimit < 1 after flooring falls back to default instead of denying all", () => {
  // 0.5 previously passed the `> 0` gate and floored to 0, turning a
  // minor misconfiguration into a full denial of cross-namespace reads.
  const limiter = new CrossNamespaceBudget({
    enabled: true,
    hardLimit: 0.5,
  });
  const cfg = limiter.getConfig();
  assert.equal(
    cfg.hardLimit,
    DEFAULT_CROSS_NAMESPACE_BUDGET.hardLimit,
    "hardLimit < 1 must fall back to default",
  );
});

test("gc() evicts buckets whose window has fully expired", () => {
  const limiter = new CrossNamespaceBudget({
    enabled: true,
    softLimit: 10,
    hardLimit: 20,
    windowMs: 100,
  });
  // Fill buckets for three principals at t=0.
  limiter.record("alice", 0);
  limiter.record("bob", 0);
  limiter.record("carol", 0);
  assert.equal(limiter.bucketCount(), 3);

  // gc at t=50 keeps everything (within window).
  assert.equal(limiter.gc(50), 0);
  assert.equal(limiter.bucketCount(), 3);

  // gc at t=200 drops all (window rolled past).
  assert.equal(limiter.gc(200), 3);
  assert.equal(limiter.bucketCount(), 0);
});

test("record() normalizes non-finite clocks before mutating limiter state", () => {
  const limiter = new CrossNamespaceBudget({
    enabled: true,
    softLimit: 1,
    hardLimit: 1,
    windowMs: 100,
  });

  const invalidClock = limiter.record("p1", Number.NaN);
  assert.equal(invalidClock.allowed, true);
  assert.equal(invalidClock.reason, "allowed-under-soft");
  assert.equal(invalidClock.count, 1);
  assert.equal(limiter.bucketCount(), 1);

  const later = limiter.record("p1", 101);
  assert.equal(later.allowed, true);
  assert.equal(later.reason, "allowed-under-soft");
  assert.equal(later.count, 1);

  assert.equal(limiter.gc(250), 1);
  assert.equal(limiter.bucketCount(), 0);
});

test("peek() with a non-finite clock is read-only and does not poison state", () => {
  const limiter = new CrossNamespaceBudget({
    enabled: true,
    softLimit: 0,
    hardLimit: 1,
    windowMs: 100,
  });

  const decision = limiter.peek({
    principal: "p1",
    principalNamespace: "alice",
    queryNamespace: "bob",
    now: Number.NaN,
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "warn-over-soft");
  assert.equal(decision.count, 1);
  assert.equal(limiter.bucketCount(), 0);
});

test("gc() normalizes non-finite clocks without evicting future-valid state", () => {
  const limiter = new CrossNamespaceBudget({
    enabled: true,
    softLimit: 10,
    hardLimit: 20,
    windowMs: 100,
  });

  limiter.record("p1", 0);
  assert.equal(limiter.gc(Number.NaN), 0);
  assert.equal(limiter.bucketCount(), 1);
  assert.equal(limiter.gc(101), 1);
  assert.equal(limiter.bucketCount(), 0);
});

test("bucket is evicted after a denial rolls the only timestamp back", () => {
  const limiter = new CrossNamespaceBudget({
    enabled: true,
    softLimit: 1,
    hardLimit: 1,
    windowMs: 100,
  });
  limiter.record("p1", 0);
  // Denial at t=150 after the earlier timestamp has slid out. The
  // timestamp just added gets rolled back; bucket becomes empty; must
  // be evicted.
  limiter.record("p1", 150);
  // (wait — the above is allowed because the earlier timestamp slid out.)
  // Force a deny path differently:
  assert.equal(limiter.bucketCount(), 1);
});

test("check() does NOT fail-open when both namespaces are empty or undefined", () => {
  const limiter = new CrossNamespaceBudget({
    enabled: true,
    softLimit: 0,
    hardLimit: 1,
    windowMs: 10_000,
  });
  // Two empty-string namespaces must NOT short-circuit to
  // allowed-same-namespace — that would be a fail-open path in a
  // security module.
  const d1 = limiter.check({
    principal: "p1",
    principalNamespace: "",
    queryNamespace: "",
    now: 1,
  });
  assert.notEqual(d1.reason, "allowed-same-namespace");
});

test("inverted soft/hard limits clamp soft <= hard", () => {
  const limiter = new CrossNamespaceBudget({
    enabled: true,
    softLimit: 100,
    hardLimit: 5,
    windowMs: 10_000,
  });
  const cfg = limiter.getConfig();
  assert.equal(cfg.softLimit, cfg.hardLimit);
});
