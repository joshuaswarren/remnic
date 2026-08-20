import assert from "node:assert/strict";
import test from "node:test";

import {
  DISCLOSURE_LEVELS,
  disclosureRank,
  planDisclosureStep,
} from "./recall-navigate-disclosure.js";

// The declared input type is strings; agents send arbitrary JSON. Cast only
// at this boundary so the invalid-shape cases stay one line each.
const plan = (from: unknown, to: unknown) =>
  planDisclosureStep({ from, to } as unknown as { from: string; to: string });

test("disclosureRank returns the index of every level, shallowest first", () => {
  for (const [i, level] of DISCLOSURE_LEVELS.entries()) {
    assert.equal(disclosureRank(level), i);
  }
  assert.ok(
    disclosureRank(DISCLOSURE_LEVELS[0]) < disclosureRank(DISCLOSURE_LEVELS[1]),
  );
  assert.ok(
    disclosureRank(DISCLOSURE_LEVELS[1]) < disclosureRank(DISCLOSURE_LEVELS[2]),
  );
});

test("disclosureRank throws a RangeError listing allowed values", () => {
  assert.throws(
    () => disclosureRank("full"),
    (err: unknown) =>
      err instanceof RangeError &&
      /disclosure level/.test(err.message) &&
      err.message.includes("chunk") &&
      err.message.includes("section") &&
      err.message.includes("raw"),
  );
});

test("chunk→section is one step", () => {
  assert.deepEqual(planDisclosureStep({ from: "chunk", to: "section" }), {
    ok: true,
    from: "chunk",
    to: "section",
    steps: 1,
  });
});

test("section→raw is one step", () => {
  assert.deepEqual(planDisclosureStep({ from: "section", to: "raw" }), {
    ok: true,
    from: "section",
    to: "raw",
    steps: 1,
  });
});

test("chunk→raw is two steps", () => {
  assert.deepEqual(planDisclosureStep({ from: "chunk", to: "raw" }), {
    ok: true,
    from: "chunk",
    to: "raw",
    steps: 2,
  });
});

test("every level pair is only deeper in one direction", () => {
  for (const shallower of DISCLOSURE_LEVELS) {
    for (const deeper of DISCLOSURE_LEVELS) {
      const result = planDisclosureStep({ from: shallower, to: deeper });
      if (disclosureRank(shallower) < disclosureRank(deeper)) {
        assert.deepEqual(result, {
          ok: true,
          from: shallower,
          to: deeper,
          steps: disclosureRank(deeper) - disclosureRank(shallower),
        });
      } else {
        assert.deepEqual(result, { ok: false, error: "not_deeper" });
      }
    }
  }
});

test("equal levels are not_deeper", () => {
  for (const level of DISCLOSURE_LEVELS) {
    assert.deepEqual(planDisclosureStep({ from: level, to: level }), {
      ok: false,
      error: "not_deeper",
    });
  }
});

test("shallower pairs are not_deeper", () => {
  for (const [from, to] of [
    ["section", "chunk"],
    ["raw", "section"],
    ["raw", "chunk"],
  ] as const) {
    assert.deepEqual(planDisclosureStep({ from, to }), {
      ok: false,
      error: "not_deeper",
    });
  }
});

test("unknown level on either side is unknown_level, not a throw", () => {
  assert.deepEqual(plan("full", "raw"), { ok: false, error: "unknown_level" });
  assert.deepEqual(plan("chunk", "full"), { ok: false, error: "unknown_level" });
  assert.deepEqual(plan("full", "worse"), { ok: false, error: "unknown_level" });
});

test("non-string level on either side is unknown_level", () => {
  for (const bad of [5, null, undefined, true, { level: "raw" }, ["raw"]]) {
    assert.deepEqual(plan(bad, "raw"), { ok: false, error: "unknown_level" });
    assert.deepEqual(plan("chunk", bad), { ok: false, error: "unknown_level" });
  }
});

test("empty string level is unknown_level", () => {
  assert.deepEqual(plan("", "raw"), { ok: false, error: "unknown_level" });
  assert.deepEqual(plan("chunk", ""), { ok: false, error: "unknown_level" });
});

test("levels match exactly — no case folding, no trimming", () => {
  assert.deepEqual(plan("Raw", "chunk"), { ok: false, error: "unknown_level" });
  assert.deepEqual(plan(" raw", "raw"), { ok: false, error: "unknown_level" });
  assert.deepEqual(plan("raw", "RAW"), { ok: false, error: "unknown_level" });
});
