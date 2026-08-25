import assert from "node:assert/strict";
import test from "node:test";

import {
  RECALL_XRAY_SERVED_BY_VALUES,
  RecallXrayBuilder,
  buildXraySnapshot,
  isRecallXrayServedBy,
  type RecallXrayResult,
} from "./recall-xray.js";
import type { RecallTierExplain } from "./types.js";

function fixedNow(): number {
  return 1_700_000_000_000;
}

function idGen(): () => string {
  let n = 0;
  return () => `snap-${++n}`;
}

function xrayResult(memoryId: string): RecallXrayResult {
  return {
    memoryId,
    path: `/notes/${memoryId}.md`,
    servedBy: "hybrid",
    admittedBy: [`rank:${memoryId}`],
    scoreDecomposition: { final: 0.5 },
  };
}

// ─── isRecallXrayServedBy ─────────────────────────────────────────────────

test("isRecallXrayServedBy accepts every documented value", () => {
  for (const value of RECALL_XRAY_SERVED_BY_VALUES) {
    assert.equal(isRecallXrayServedBy(value), true, `expected ${value} accepted`);
  }
});

test("isRecallXrayServedBy rejects unknown strings and non-strings", () => {
  assert.equal(isRecallXrayServedBy("bogus"), false);
  assert.equal(isRecallXrayServedBy(""), false);
  assert.equal(isRecallXrayServedBy(undefined), false);
  assert.equal(isRecallXrayServedBy(null), false);
  assert.equal(isRecallXrayServedBy(7), false);
});

// ─── buildXraySnapshot: minimal call ──────────────────────────────────────

test("buildXraySnapshot fills defaults for empty input", () => {
  const snapshot = buildXraySnapshot({
    query: "what is the capital of france",
    now: fixedNow,
    snapshotIdGenerator: idGen(),
  });
  assert.equal(snapshot.schemaVersion, "1");
  assert.equal(snapshot.query, "what is the capital of france");
  assert.equal(snapshot.snapshotId, "snap-1");
  assert.equal(snapshot.capturedAt, 1_700_000_000_000);
  assert.equal(snapshot.tierExplain, null);
  assert.deepEqual(snapshot.results, []);
  assert.equal(snapshot.appliedResultLimit, 0);
  assert.deepEqual(snapshot.appliedResults, []);
  assert.deepEqual(snapshot.headroomResults, []);
  assert.deepEqual(snapshot.budget, { chars: 0, used: 0 });
  assert.equal(snapshot.sessionKey, undefined);
  assert.equal(snapshot.namespace, undefined);
  assert.equal(snapshot.traceId, undefined);
});

test("buildXraySnapshot trims whitespace-only session/namespace/traceId to undefined", () => {
  const snapshot = buildXraySnapshot({
    query: "x",
    sessionKey: "   ",
    namespace: "",
    traceId: "  ",
    now: fixedNow,
    snapshotIdGenerator: idGen(),
  });
  assert.equal(snapshot.sessionKey, undefined);
  assert.equal(snapshot.namespace, undefined);
  assert.equal(snapshot.traceId, undefined);
});

test("buildXraySnapshot strips surrounding whitespace from session/namespace/traceId", () => {
  const snapshot = buildXraySnapshot({
    query: "x",
    sessionKey: "  sess-1  ",
    namespace: "\tns\n",
    traceId: " trace-xyz ",
    now: fixedNow,
    snapshotIdGenerator: idGen(),
  });
  assert.equal(snapshot.sessionKey, "sess-1");
  assert.equal(snapshot.namespace, "ns");
  assert.equal(snapshot.traceId, "trace-xyz");
});

// ─── buildXraySnapshot: each decomposition field ──────────────────────────

test("buildXraySnapshot preserves every score-decomposition field", () => {
  const result: RecallXrayResult = {
    memoryId: "mem-1",
    path: "/notes/synthetic.md",
    servedBy: "hybrid",
    admittedBy: ["namespace", "trustZone", "importance"],
    scoreDecomposition: {
      vector: 0.83,
      bm25: 0.41,
      importance: 0.72,
      mmrPenalty: 0.05,
      tierPrior: 0.1,
      final: 0.79,
    },
  };
  const snapshot = buildXraySnapshot({
    query: "q",
    results: [result],
    now: fixedNow,
    snapshotIdGenerator: idGen(),
  });
  assert.equal(snapshot.results.length, 1);
  const emitted = snapshot.results[0]!;
  assert.deepEqual(emitted.scoreDecomposition, {
    vector: 0.83,
    bm25: 0.41,
    importance: 0.72,
    mmrPenalty: 0.05,
    tierPrior: 0.1,
    final: 0.79,
  });
  assert.equal(emitted.servedBy, "hybrid");
  assert.deepEqual(emitted.admittedBy, ["namespace", "trustZone", "importance"]);
});

test("buildXraySnapshot drops non-finite score-decomposition fields", () => {
  const result: RecallXrayResult = {
    memoryId: "mem-2",
    path: "/notes/two.md",
    servedBy: "hybrid",
    admittedBy: [],
    scoreDecomposition: {
      vector: Number.NaN,
      bm25: Number.POSITIVE_INFINITY,
      importance: 0.5,
      final: Number.NaN,
    },
  };
  const snapshot = buildXraySnapshot({
    query: "q",
    results: [result],
    now: fixedNow,
    snapshotIdGenerator: idGen(),
  });
  const emitted = snapshot.results[0]!;
  assert.equal(emitted.scoreDecomposition.vector, undefined);
  assert.equal(emitted.scoreDecomposition.bm25, undefined);
  assert.equal(emitted.scoreDecomposition.importance, 0.5);
  // Non-finite `final` collapses to the guaranteed 0 default.
  assert.equal(emitted.scoreDecomposition.final, 0);
});

test("buildXraySnapshot preserves graphPath, auditEntryId, rejectedBy when present", () => {
  const result: RecallXrayResult = {
    memoryId: "mem-3",
    path: "/notes/three.md",
    servedBy: "graph",
    admittedBy: ["namespace"],
    scoreDecomposition: { final: 0.5, tierPrior: 0.3 },
    graphPath: ["alpha", "beta", "gamma"],
    auditEntryId: "audit-42",
    rejectedBy: "mmr-diversity",
  };
  const snapshot = buildXraySnapshot({
    query: "q",
    results: [result],
    now: fixedNow,
    snapshotIdGenerator: idGen(),
  });
  const emitted = snapshot.results[0]!;
  assert.deepEqual(emitted.graphPath, ["alpha", "beta", "gamma"]);
  assert.equal(emitted.auditEntryId, "audit-42");
  assert.equal(emitted.rejectedBy, "mmr-diversity");
});

// ─── Issue #681 PR 3/3 — graphEdgeConfidences ─────────────────────────────

test("buildXraySnapshot preserves graphEdgeConfidences when length matches graphPath - 1", () => {
  const result: RecallXrayResult = {
    memoryId: "mem-x",
    path: "/p.md",
    servedBy: "graph",
    admittedBy: [],
    scoreDecomposition: { final: 0.42 },
    graphPath: ["a", "b", "c"],
    graphEdgeConfidences: [0.9, 0.4],
  };
  const snap = buildXraySnapshot({
    query: "q",
    results: [result],
    now: fixedNow,
    snapshotIdGenerator: idGen(),
  });
  assert.deepEqual(snap.results[0]?.graphEdgeConfidences, [0.9, 0.4]);
});

test("buildXraySnapshot drops graphEdgeConfidences when length disagrees with graphPath", () => {
  // Misaligned snapshots are rejected wholesale rather than rendering
  // partial / shifted confidence pairings — that would invite reviewers
  // to ask "which edge does index 2 refer to?" and the answer is "none".
  const result: RecallXrayResult = {
    memoryId: "mem-x",
    path: "/p.md",
    servedBy: "graph",
    admittedBy: [],
    scoreDecomposition: { final: 0.42 },
    graphPath: ["a", "b", "c"],
    graphEdgeConfidences: [0.9], // length 1, expected 2
  };
  const snap = buildXraySnapshot({
    query: "q",
    results: [result],
    now: fixedNow,
    snapshotIdGenerator: idGen(),
  });
  assert.equal(snap.results[0]?.graphEdgeConfidences, undefined);
});

test("buildXraySnapshot rejects graphEdgeConfidences with non-finite entries (cursor #735)", () => {
  // Cursor review thread: filtering NaN/Infinity via `continue` and
  // then length-checking the cleaned array would silently shift
  // surviving values to earlier edge indices. We must reject the
  // entire array on any non-finite member so misalignment is
  // impossible — even when the cleaned count happens to match
  // `graphPath.length - 1` by coincidence.
  const result: RecallXrayResult = {
    memoryId: "mem-x",
    path: "/p.md",
    servedBy: "graph",
    admittedBy: [],
    scoreDecomposition: { final: 0.5 },
    graphPath: ["a", "b", "c"], // 2 edges expected
    // Input length 2 (matches expected) but contains NaN: a permissive
    // implementation would render `0.7` as if it were the only edge
    // (length 1) — losing alignment with the second edge.
    graphEdgeConfidences: [Number.NaN, 0.7],
  };
  const snap = buildXraySnapshot({
    query: "q",
    results: [result],
    now: fixedNow,
    snapshotIdGenerator: idGen(),
  });
  assert.equal(snap.results[0]?.graphEdgeConfidences, undefined);
});

test("buildXraySnapshot rejects graphEdgeConfidences with input length mismatch (cursor #735)", () => {
  // Reproduces the exact misalignment vector cursor flagged: when
  // input contains a NaN that would be stripped, the post-strip
  // length might match `graphPath.length - 1` even though the
  // *original* length did not. Reject on input length, not cleaned
  // length, so a future "filter & continue" regression cannot creep
  // back in.
  const result: RecallXrayResult = {
    memoryId: "mem-x",
    path: "/p.md",
    servedBy: "graph",
    admittedBy: [],
    scoreDecomposition: { final: 0.5 },
    graphPath: ["a", "b", "c"], // 2 edges expected
    graphEdgeConfidences: [0.5, Number.NaN, 0.7], // input length 3
  };
  const snap = buildXraySnapshot({
    query: "q",
    results: [result],
    now: fixedNow,
    snapshotIdGenerator: idGen(),
  });
  assert.equal(snap.results[0]?.graphEdgeConfidences, undefined);
});

test("buildXraySnapshot clamps graphEdgeConfidence values into [0, 1]", () => {
  const result: RecallXrayResult = {
    memoryId: "mem-x",
    path: "/p.md",
    servedBy: "graph",
    admittedBy: [],
    scoreDecomposition: { final: 0.5 },
    graphPath: ["a", "b", "c"],
    graphEdgeConfidences: [-0.3, 1.5],
  };
  const snap = buildXraySnapshot({
    query: "q",
    results: [result],
    now: fixedNow,
    snapshotIdGenerator: idGen(),
  });
  assert.deepEqual(snap.results[0]?.graphEdgeConfidences, [0, 1]);
});

test("buildXraySnapshot rejects results with an unknown servedBy tier", () => {
  assert.throws(
    () =>
      buildXraySnapshot({
        query: "q",
        results: [
          {
            memoryId: "x",
            path: "/x",
            // @ts-expect-error — deliberately invalid for the test
            servedBy: "fiction",
            admittedBy: [],
            scoreDecomposition: { final: 0 },
          },
        ],
        now: fixedNow,
        snapshotIdGenerator: idGen(),
      }),
    /servedBy must be one of/,
  );
});

test("buildXraySnapshot normalizes per-result provenance", () => {
  const result: RecallXrayResult = {
    memoryId: "mem-provenance",
    path: "/notes/provenance.md",
    servedBy: "hybrid",
    admittedBy: [],
    scoreDecomposition: { final: 0.7 },
    provenance: {
      source: "conversation",
      created: "2026-04-20T00:00:00.000Z",
      namespace: "default",
      scope: "namespace:default",
      userContextScopes: ["repo", "private"],
      retrievalReason: "served-by=hybrid",
      confidence: 2,
      stale: true,
      corrected: false,
      correctionState: "superseded",
      safeToUse: false,
      safety: "requires-review",
      safetyReasons: ["stale=true", ""],
    },
  };

  const snapshot = buildXraySnapshot({
    query: "q",
    results: [result],
    now: fixedNow,
    snapshotIdGenerator: idGen(),
  });

  assert.deepEqual(snapshot.results[0]?.provenance, {
    source: "conversation",
    created: "2026-04-20T00:00:00.000Z",
    namespace: "default",
    scope: "namespace:default",
    userContextScopes: ["repo", "private"],
    retrievalReason: "served-by=hybrid",
    confidence: 1,
    stale: true,
    corrected: true,
    correctionState: "superseded",
    safeToUse: false,
    safety: "requires-review",
    safetyReasons: ["stale=true"],
  });
});

// ─── Budget accounting ────────────────────────────────────────────────────

test("buildXraySnapshot clamps negative / non-finite budgets to zero", () => {
  const snapshot = buildXraySnapshot({
    query: "q",
    budget: { chars: -5, used: Number.NaN },
    now: fixedNow,
    snapshotIdGenerator: idGen(),
  });
  assert.deepEqual(snapshot.budget, { chars: 0, used: 0 });
});

test("buildXraySnapshot floors fractional budget values", () => {
  const snapshot = buildXraySnapshot({
    query: "q",
    budget: { chars: 10.9, used: 7.2 },
    now: fixedNow,
    snapshotIdGenerator: idGen(),
  });
  assert.deepEqual(snapshot.budget, { chars: 10, used: 7 });
});

// ─── TierExplain round-trip ───────────────────────────────────────────────

test("buildXraySnapshot carries tierExplain verbatim", () => {
  const tierExplain: RecallTierExplain = {
    tier: "direct-answer",
    tierReason: "trusted decisions, unambiguous",
    filteredBy: ["token-overlap-floor"],
    candidatesConsidered: 3,
    latencyMs: 11,
    sourceAnchors: [{ path: "/notes/pm.md", lineRange: [1, 4] }],
  };
  const snapshot = buildXraySnapshot({
    query: "q",
    tierExplain,
    now: fixedNow,
    snapshotIdGenerator: idGen(),
  });
  assert.deepEqual(snapshot.tierExplain, tierExplain);
});

test("buildXraySnapshot deep-copies tierExplain so caller mutation does not tear the snapshot", () => {
  const tierExplain: RecallTierExplain = {
    tier: "direct-answer",
    tierReason: "live",
    filteredBy: ["a"],
    candidatesConsidered: 1,
    latencyMs: 1,
  };
  const snapshot = buildXraySnapshot({
    query: "q",
    tierExplain,
    now: fixedNow,
    snapshotIdGenerator: idGen(),
  });
  tierExplain.filteredBy.push("b");
  assert.deepEqual(snapshot.tierExplain?.filteredBy, ["a"]);
});

// ─── Filter trace ─────────────────────────────────────────────────────────

test("buildXraySnapshot records filters with considered/admitted counts", () => {
  const snapshot = buildXraySnapshot({
    query: "q",
    filters: [
      { name: "namespace", considered: 10, admitted: 8 },
      { name: "trustZone", considered: 8, admitted: 6, reason: "quarantine" },
    ],
    now: fixedNow,
    snapshotIdGenerator: idGen(),
  });
  assert.deepEqual(snapshot.filters, [
    { name: "namespace", considered: 10, admitted: 8 },
    { name: "trustZone", considered: 8, admitted: 6, reason: "quarantine" },
  ]);
});

// ─── Defensive copies ─────────────────────────────────────────────────────

test("buildXraySnapshot shallow-copies results so caller mutation does not leak in", () => {
  const result: RecallXrayResult = {
    memoryId: "mem-1",
    path: "/notes/one.md",
    servedBy: "hybrid",
    admittedBy: ["alpha"],
    scoreDecomposition: { final: 0.5 },
  };
  const snapshot = buildXraySnapshot({
    query: "q",
    results: [result],
    now: fixedNow,
    snapshotIdGenerator: idGen(),
  });
  result.admittedBy.push("beta");
  assert.deepEqual(snapshot.results[0]!.admittedBy, ["alpha"]);
});

test("buildXraySnapshot keeps ordered applied and headroom results separate from presentation results", () => {
  const presentationResults = [xrayResult("presentation")];
  const appliedResults = [xrayResult("applied-1"), xrayResult("applied-2")];
  const headroomResults = [xrayResult("headroom-1"), xrayResult("headroom-2")];
  const snapshot = buildXraySnapshot({
    query: "q",
    results: presentationResults,
    appliedResultLimit: 2,
    appliedResults,
    headroomResults,
    now: fixedNow,
    snapshotIdGenerator: idGen(),
  });

  presentationResults[0]!.admittedBy.push("mutated");
  appliedResults[0]!.admittedBy.push("mutated");
  headroomResults[0]!.admittedBy.push("mutated");
  appliedResults.reverse();
  headroomResults.reverse();

  assert.equal(snapshot.appliedResultLimit, 2);
  assert.deepEqual(snapshot.results.map((result) => result.memoryId), ["presentation"]);
  assert.deepEqual(snapshot.appliedResults.map((result) => result.memoryId), [
    "applied-1",
    "applied-2",
  ]);
  assert.deepEqual(snapshot.headroomResults.map((result) => result.memoryId), [
    "headroom-1",
    "headroom-2",
  ]);
  assert.deepEqual(snapshot.appliedResults[0]!.admittedBy, ["rank:applied-1"]);
  assert.deepEqual(snapshot.headroomResults[0]!.admittedBy, ["rank:headroom-1"]);
});

test("buildXraySnapshot normalizes invalid and fractional applied result limits", () => {
  for (const [value, expected] of [
    [-1, 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [2.9, 2],
  ] as const) {
    const snapshot = buildXraySnapshot({
      query: "q",
      appliedResultLimit: value,
      now: fixedNow,
      snapshotIdGenerator: idGen(),
    });
    assert.equal(snapshot.appliedResultLimit, expected);
  }
});

test("buildXraySnapshot validates applied and headroom candidates like presentation results", () => {
  const invalid = { ...xrayResult("invalid"), servedBy: "unknown-tier" as never };
  assert.throws(
    () =>
      buildXraySnapshot({
        query: "q",
        appliedResults: [invalid],
        now: fixedNow,
        snapshotIdGenerator: idGen(),
      }),
    /servedBy must be one of/,
  );
  assert.throws(
    () =>
      buildXraySnapshot({
        query: "q",
        headroomResults: [invalid],
        now: fixedNow,
        snapshotIdGenerator: idGen(),
      }),
    /servedBy must be one of/,
  );
});

// ─── RecallXrayBuilder ────────────────────────────────────────────────────

test("RecallXrayBuilder accumulates results and filters then builds a snapshot", () => {
  const builder = new RecallXrayBuilder({
    query: "test query",
    sessionKey: "s1",
  });
  builder.setNamespace("ns1");
  builder.setTraceId("trace-1");
  builder.setBudget({ chars: 4096, used: 1024 });
  builder.setTierExplain({
    tier: "hybrid",
    tierReason: "served by hybrid",
    filteredBy: [],
    candidatesConsidered: 2,
    latencyMs: 5,
  });
  builder.recordFilter({ name: "namespace", considered: 5, admitted: 4 });
  builder.recordResult({
    memoryId: "mem-1",
    path: "/notes/one.md",
    servedBy: "hybrid",
    admittedBy: ["namespace", "trustZone"],
    scoreDecomposition: { final: 0.9, vector: 0.88 },
  });
  const snap = builder.build({
    now: fixedNow,
    snapshotIdGenerator: idGen(),
  });
  assert.equal(snap.snapshotId, "snap-1");
  assert.equal(snap.sessionKey, "s1");
  assert.equal(snap.namespace, "ns1");
  assert.equal(snap.traceId, "trace-1");
  assert.deepEqual(snap.budget, { chars: 4096, used: 1024 });
  assert.equal(snap.results.length, 1);
  assert.equal(snap.filters.length, 1);
  assert.equal(snap.tierExplain?.tier, "hybrid");
});

test("RecallXrayBuilder produces unique snapshotId per build when no generator injected", () => {
  const builder = new RecallXrayBuilder({ query: "x" });
  const a = builder.build();
  const b = builder.build();
  assert.ok(typeof a.snapshotId === "string" && a.snapshotId.length > 0);
  assert.ok(typeof b.snapshotId === "string" && b.snapshotId.length > 0);
  assert.notEqual(a.snapshotId, b.snapshotId);
});

// ─── Issue #1577 — cloneResult preserves the trust projection (review Oqg_o) ─

test("RecallXrayBuilder clones the trust projection so the snapshot surfaces it (#1577)", () => {
  // Review Oqg_o: cloneResult was silently dropping the `trust` field, so a
  // snapshot built via recordResult() lost trust score/band/quarantine reason
  // even when the live capture had it. The clone must deep-copy the projection.
  const builder = new RecallXrayBuilder({ query: "q" });
  builder.recordResult({
    memoryId: "mem-admitted",
    path: "mems/a.md",
    servedBy: "hybrid",
    scoreDecomposition: { final: 0.9 },
    admittedBy: [],
    trust: {
      score: 0.82,
      band: "high",
      components: { faithfulness: { value: 1, weight: 0.4 } },
      multiplier: 1.15,
      quarantined: false,
    },
  });
  builder.recordResult({
    memoryId: "mem-quarantined",
    path: "mems/b.md",
    servedBy: "hybrid",
    scoreDecomposition: { final: 0 },
    admittedBy: [],
    rejectedBy: "trust-score:quarantine",
    trust: {
      score: 0,
      band: "quarantine",
      components: { faithfulness: { value: 0, weight: 0.4 } },
      multiplier: 1,
      quarantined: true,
      quarantineReason: "faithfulness: contradicted",
    },
  });
  const snap = builder.build();
  const admitted = snap.results.find((r) => r.memoryId === "mem-admitted");
  const quarantined = snap.results.find((r) => r.memoryId === "mem-quarantined");
  assert.ok(admitted, "admitted result present in snapshot");
  assert.ok(admitted!.trust, "admitted result keeps its trust projection through the clone");
  assert.equal(admitted!.trust!.score, 0.82);
  assert.equal(admitted!.trust!.band, "high");
  assert.equal(admitted!.trust!.multiplier, 1.15);
  assert.equal(admitted!.trust!.quarantined, false);
  assert.deepEqual(
    admitted!.trust!.components,
    { faithfulness: { value: 1, weight: 0.4 } },
    "components deep-copied",
  );
  assert.ok(quarantined, "quarantined result present in snapshot");
  assert.ok(quarantined!.trust, "quarantined result keeps its trust projection through the clone");
  assert.equal(quarantined!.trust!.band, "quarantine");
  assert.equal(quarantined!.trust!.quarantined, true);
  assert.equal(
    quarantined!.trust!.quarantineReason,
    "faithfulness: contradicted",
    "quarantine reason preserved so exclusion never looks like 'no result' (rule 34)",
  );
});

test("#2972 healthy xray snapshot omits the degradation marker", () => {
  const snapshot = buildXraySnapshot({
    query: "q",
    now: fixedNow,
    snapshotIdGenerator: idGen(),
  });
  assert.equal("degradation" in snapshot, false);
  assert.ok(!JSON.stringify(snapshot).includes("degradation"));
});

test("#2972 xray snapshot copies degradation and isolates caller mutation", () => {
  const degradation = {
    state: "degraded" as const,
    reason: "budget-clipped" as const,
    budget: { contextBudget: 20, fullChars: 100, deliveredChars: 20 },
  };
  const snapshot = buildXraySnapshot({
    query: "q",
    degradation,
    now: fixedNow,
    snapshotIdGenerator: idGen(),
  });
  assert.deepEqual(snapshot.degradation, degradation);
  degradation.budget.deliveredChars = 0;
  assert.equal(snapshot.degradation?.budget?.deliveredChars, 20);
});

