import test from "node:test";
import assert from "node:assert/strict";
import {
  uptakeAtNext,
  uptakeLatency,
  nonResurrection,
  collateralDelta,
  scopePrecision,
  falseApply,
  reassertion,
  provenanceFidelity,
  computeMetricBundle,
  containsAll,
  containsNone,
  tokenize,
} from "./metrics.js";
import type {
  ProbeLogEntry,
  ResolvedAntiEvent,
  ResolvedCorrection,
  ResolvedReassertion,
} from "./types.js";

function probe(args: {
  scenarioId: string;
  phase: ProbeLogEntry["phase"];
  turnIndex: number;
  namespace?: string;
  recalled: string[];
}): ProbeLogEntry {
  return {
    scenarioId: args.scenarioId,
    phase: args.phase,
    turnIndex: args.turnIndex,
    namespace: args.namespace ?? "ns-a",
    query: "q",
    recalled: args.recalled,
    at: "2026-07-05T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------

test("tokenize lowercases and splits on non-alnum, preserving hyphens", () => {
  assert.deepEqual(
    [...tokenize("Oat-Milk, coffee!")].sort(),
    ["coffee", "oat-milk"].sort(),
  );
});

test("containsAll / containsNone are token-set operations", () => {
  assert.equal(containsAll("the new value is here", ["new", "value"]), true);
  assert.equal(containsAll("only new", ["new", "value"]), false);
  assert.equal(containsNone("nothing relevant", ["old", "value"]), true);
  assert.equal(containsNone("the old fact", ["old"]), false);
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("uptakeAtNext: 1 of 2 corrections reflected on first post-correction probe", () => {
  const corrections: ResolvedCorrection[] = [
    {
      scenarioId: "s1",
      namespace: "ns-a",
      turnIndex: 10,
      retiredContent: ["old"],
      correctedContent: ["new"],
    },
    {
      scenarioId: "s2",
      namespace: "ns-a",
      turnIndex: 10,
      retiredContent: ["old"],
      correctedContent: ["new"],
    },
  ];
  const log: ProbeLogEntry[] = [
    probe({ scenarioId: "s1", phase: "post_correction", turnIndex: 11, recalled: ["now new value"] }),
    probe({ scenarioId: "s2", phase: "post_correction", turnIndex: 11, recalled: ["still old value"] }),
  ];
  assert.equal(uptakeAtNext(log, corrections), 0.5);
});

test("uptakeAtNext: half-open window ignores probes at/before correction turn", () => {
  const corrections: ResolvedCorrection[] = [
    { scenarioId: "s1", namespace: "ns-a", turnIndex: 10, retiredContent: ["old"], correctedContent: ["new"] },
  ];
  const log: ProbeLogEntry[] = [
    probe({ scenarioId: "s1", phase: "post_correction", turnIndex: 10, recalled: ["new value"] }),
    probe({ scenarioId: "s1", phase: "post_correction", turnIndex: 12, recalled: ["new value"] }),
  ];
  assert.equal(uptakeAtNext(log, corrections), 1);
});

test("uptakeAtNext: empty corrections returns 0 (no division by zero)", () => {
  assert.equal(uptakeAtNext([], []), 0);
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("uptakeLatency: mean of resolved + censored, capped", () => {
  const corrections: ResolvedCorrection[] = [
    { scenarioId: "s1", namespace: "ns-a", turnIndex: 10, retiredContent: ["old"], correctedContent: ["new"] },
    { scenarioId: "s2", namespace: "ns-a", turnIndex: 10, retiredContent: ["old"], correctedContent: ["new"] },
  ];
  const log: ProbeLogEntry[] = [
    probe({ scenarioId: "s1", phase: "post_correction", turnIndex: 11, recalled: ["old still"] }),
    probe({ scenarioId: "s1", phase: "post_correction", turnIndex: 12, recalled: ["new value"] }),
    probe({ scenarioId: "s2", phase: "post_correction", turnIndex: 11, recalled: ["old"] }),
    probe({ scenarioId: "s2", phase: "post_correction", turnIndex: 12, recalled: ["old"] }),
    probe({ scenarioId: "s2", phase: "post_correction", turnIndex: 13, recalled: ["old"] }),
    probe({ scenarioId: "s2", phase: "post_correction", turnIndex: 14, recalled: ["old"] }),
    probe({ scenarioId: "s2", phase: "post_correction", turnIndex: 15, recalled: ["old"] }),
    probe({ scenarioId: "s2", phase: "post_correction", turnIndex: 16, recalled: ["new"] }),
  ];
  const result = uptakeLatency(log, corrections, 5);
  assert.equal(result.mean, 3.5);
  assert.equal(result.censored, 1);
});

test("uptakeLatency: a success landing exactly at the cap is resolved, not censored", () => {
  const corrections: ResolvedCorrection[] = [
    { scenarioId: "s1", namespace: "ns-a", turnIndex: 10, retiredContent: ["old"], correctedContent: ["new"] },
  ];
  const log: ProbeLogEntry[] = [
    probe({ scenarioId: "s1", phase: "post_correction", turnIndex: 15, recalled: ["new value"] }),
  ];
  const result = uptakeLatency(log, corrections, 5);
  assert.equal(result.mean, 5);
  assert.equal(result.censored, 0);
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("nonResurrection: retired fact resurrected on re-ingest scores 0", () => {
  const corrections: ResolvedCorrection[] = [
    { scenarioId: "s1", namespace: "ns-a", turnIndex: 5, retiredContent: ["old"], correctedContent: ["new"] },
    { scenarioId: "s2", namespace: "ns-a", turnIndex: 5, retiredContent: ["old"], correctedContent: ["new"] },
  ];
  const log: ProbeLogEntry[] = [
    probe({ scenarioId: "s1", phase: "post_maintenance", turnIndex: 8, recalled: ["new value"] }),
    probe({ scenarioId: "s1", phase: "post_reingest", turnIndex: 12, recalled: ["new value"] }),
    probe({ scenarioId: "s2", phase: "post_maintenance", turnIndex: 8, recalled: ["new value"] }),
    probe({ scenarioId: "s2", phase: "post_reingest", turnIndex: 12, recalled: ["old fact returned"] }),
  ];
  assert.equal(nonResurrection(log, corrections), 0.5);
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("collateralDelta: after minus before over unrelated probes", () => {
  const delta = collateralDelta([1, 1, 0], [1, 0, 0]);
  assert.ok(Math.abs(delta - (1 / 3 - 2 / 3)) < 1e-9, `got ${delta}`);
});

test("collateralDelta: empty returns 0", () => {
  assert.equal(collateralDelta([], []), 0);
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("scopePrecision: twin intact + primary retired passes; twin damaged fails", () => {
  const corrections: ResolvedCorrection[] = [
    {
      scenarioId: "s1",
      namespace: "ns-a",
      turnIndex: 5,
      retiredContent: ["old"],
      correctedContent: ["new"],
      scopedTwin: { namespace: "ns-b", establishingTurns: [], twinContent: "old" },
    },
    {
      scenarioId: "s2",
      namespace: "ns-a",
      turnIndex: 5,
      retiredContent: ["old"],
      correctedContent: ["new"],
      scopedTwin: { namespace: "ns-b", establishingTurns: [], twinContent: "old" },
    },
  ];
  const log: ProbeLogEntry[] = [
    probe({ scenarioId: "s1", phase: "post_correction", turnIndex: 6, namespace: "ns-a", recalled: ["new value"] }),
    probe({ scenarioId: "s1", phase: "post_correction", turnIndex: 6, namespace: "ns-b", recalled: ["old twin intact"] }),
    probe({ scenarioId: "s2", phase: "post_correction", turnIndex: 6, namespace: "ns-a", recalled: ["new value"] }),
    probe({ scenarioId: "s2", phase: "post_correction", turnIndex: 6, namespace: "ns-b", recalled: ["twin overwritten new"] }),
  ];
  assert.equal(scopePrecision(log, corrections), 0.5);
});

test("scopePrecision: no scoped corrections returns null (n/a, not 0)", () => {
  assert.equal(scopePrecision([], []), null);
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("falseApply: anti-event leaking the token counts as triggered", () => {
  const antis: ResolvedAntiEvent[] = [
    { scenarioId: "s1", namespace: "ns-a", probeQuery: "q", shouldNotAppear: "new" },
    { scenarioId: "s2", namespace: "ns-a", probeQuery: "q", shouldNotAppear: "new" },
  ];
  const log: ProbeLogEntry[] = [
    probe({ scenarioId: "s1", phase: "post_correction", turnIndex: 12, recalled: ["new leaked through"] }),
    probe({ scenarioId: "s2", phase: "post_correction", turnIndex: 12, recalled: ["nothing relevant"] }),
  ];
  assert.equal(falseApply(log, antis), 0.5);
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("reassertion: re-asserted content must surface again", () => {
  const res: ResolvedReassertion[] = [
    { scenarioId: "s1", namespace: "ns-a", expectedContent: "old" },
    { scenarioId: "s2", namespace: "ns-a", expectedContent: "old" },
  ];
  const log: ProbeLogEntry[] = [
    probe({ scenarioId: "s1", phase: "post_reassertion", turnIndex: 20, recalled: ["back to old"] }),
    probe({ scenarioId: "s2", phase: "post_reassertion", turnIndex: 20, recalled: ["still new"] }),
  ];
  assert.equal(reassertion(log, res), 0.5);
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("provenanceFidelity: averages scored cites, returns null when all n/a", () => {
  assert.equal(provenanceFidelity([1, 0, null]), 0.5);
  assert.equal(provenanceFidelity([null, null]), null);
  assert.equal(provenanceFidelity([]), null);
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("computeMetricBundle: assembles all 8 metrics from resolved inputs", () => {
  const corrections: ResolvedCorrection[] = [
    { scenarioId: "s1", namespace: "ns-a", turnIndex: 5, retiredContent: ["old"], correctedContent: ["new"] },
  ];
  const log: ProbeLogEntry[] = [
    probe({ scenarioId: "s1", phase: "post_correction", turnIndex: 6, recalled: ["new value"] }),
    probe({ scenarioId: "s1", phase: "post_maintenance", turnIndex: 9, recalled: ["new value"] }),
    probe({ scenarioId: "s1", phase: "post_reingest", turnIndex: 13, recalled: ["new value"] }),
  ];
  const bundle = computeMetricBundle({
    log,
    corrections,
    antiEvents: [],
    reassertions: [],
    collateralBefore: [1, 1],
    collateralAfter: [1, 1],
    provenanceCites: [null],
    uptakeLatencyCap: 5,
  });
  assert.equal(bundle.uptake_at_next, 1);
  assert.equal(bundle.uptake_latency, 1);
  assert.equal(bundle.uptake_latency_censored, 0);
  assert.equal(bundle.non_resurrection, 1);
  assert.equal(bundle.collateral_delta, 0);
  assert.equal(bundle.scope_precision, null);
  assert.equal(bundle.false_apply, 0);
  assert.equal(bundle.reassertion, null);
  assert.equal(bundle.provenance_fidelity, null);
});

test("correction evidence citing old+new is not penalized as stale recall (#1584)", () => {
  const corrections = [
    { scenarioId: "s1", namespace: "ns-a", turnIndex: 10, retiredContent: ["old"], correctedContent: ["new"] },
  ];
  const log: ProbeLogEntry[] = [
    probe({ scenarioId: "s1", phase: "post_correction", turnIndex: 11, recalled: ["the value is not old it is now new"] }),
    probe({ scenarioId: "s1", phase: "post_maintenance", turnIndex: 14, recalled: ["the value is not old it is now new"] }),
    probe({ scenarioId: "s1", phase: "post_reingest", turnIndex: 18, recalled: ["the value is not old it is now new"] }),
  ];
  const bundle = computeMetricBundle({
    log,
    corrections,
    antiEvents: [],
    reassertions: [],
    collateralBefore: [1],
    collateralAfter: [1],
    provenanceCites: [null],
    uptakeLatencyCap: 5,
  });
  assert.equal(bundle.uptake_at_next, 1, "correction evidence should pass uptake@next");
  assert.equal(bundle.uptake_latency, 1);
  assert.equal(bundle.non_resurrection, 1, "correction evidence must not count as resurrection");
});

test("standalone retired recall (no corrected value) still counts as stale (#1584)", () => {
  const corrections = [
    { scenarioId: "s1", namespace: "ns-a", turnIndex: 10, retiredContent: ["old"], correctedContent: ["new"] },
  ];
  const log: ProbeLogEntry[] = [
    probe({ scenarioId: "s1", phase: "post_correction", turnIndex: 11, recalled: ["the value is still old"] }),
  ];
  const bundle = computeMetricBundle({
    log,
    corrections,
    antiEvents: [],
    reassertions: [],
    collateralBefore: [1],
    collateralAfter: [1],
    provenanceCites: [null],
    uptakeLatencyCap: 5,
  });
  assert.equal(bundle.uptake_at_next, 0, "genuine stale recall must still fail");
});
