import assert from "node:assert/strict";
import test from "node:test";

import {
  annotateStateView,
  capStateViewPackets,
  formatSupersededPrefix,
  isChangeOrientedQuery,
  parseRecallStateViews,
  reconcileStateViewPairs,
  shouldWidenSuperseded,
  type StateViewChain,
  type StateViewResult,
} from "./recall-state-view.js";

function fact(id: string, extra: Partial<StateViewResult> = {}): StateViewResult {
  return { id, ...extra };
}

const PAIR: StateViewChain[] = [{ predecessorId: "old-job", successorId: "new-job", supersededAt: "2026-03-01" }];

const PAIR_RESULTS: StateViewResult[] = [
  fact("new-job", { status: "active" }),
  fact("old-job", { status: "superseded", supersededBy: "new-job", supersededAt: "2026-03-01" }),
];

test("change-intent query labels both facts in a superseded pair", () => {
  const labeled = annotateStateView(PAIR_RESULTS, "when did the job title change", PAIR, { enabled: true });
  assert.equal(labeled.length, 2);
  assert.equal(labeled[0]?.id, "new-job");
  assert.equal(labeled[0]?.stateLabel, "current");
  assert.equal(labeled[1]?.id, "old-job");
  assert.equal(labeled[1]?.stateLabel, "historical");
});

test("change-intent conjugations fire the annotator", () => {
  const phrases = [
    "when did we switch",
    "we used to",
    "before the move",
    "after the cutover",
    "they switched vendors",
    "she switches stacks",
    "switching away from it",
    "the title changed",
    "it changes next week",
    "they are changing providers",
  ];
  for (const query of phrases) {
    assert.equal(isChangeOrientedQuery(query), true, query);
    const labeled = annotateStateView(PAIR_RESULTS, query, PAIR, { enabled: true });
    assert.equal(labeled[0]?.stateLabel, "current", query);
    assert.equal(labeled[1]?.stateLabel, "historical", query);
  }
});

test("change-intent phrase matching uses token boundaries, not substrings", () => {
  const positives = [
    "When did we move offices?",
    "we used to live in Austin",
    "when  did   the vendor change",
  ];
  const negatives = [
    "when Didi arrives", // proper noun must not fire "when did"
    "I was confused to hear that", // "used to" inside "confused to"
  ];
  for (const query of positives) {
    assert.equal(isChangeOrientedQuery(query), true, query);
  }
  for (const query of negatives) {
    assert.equal(isChangeOrientedQuery(query), false, query);
  }
});

test("bare before/after sequencing is not change intent; event-pointing is", () => {
  const positives = [
    "before the move",
    "after the cutover",
    "after a migration",
    "before the migration",
  ];
  const negatives = [
    "before lunch",
    "after install",
    "restart before dinner",
    "shut down after setup",
    "the aftermath report",
  ];
  for (const query of positives) {
    assert.equal(isChangeOrientedQuery(query), true, query);
  }
  for (const query of negatives) {
    assert.equal(isChangeOrientedQuery(query), false, query);
  }
});

test("asOf mode keeps a predecessor whose successor the pin filtered out", () => {
  const predecessor = fact("old-job", {
    status: "superseded",
    supersededBy: "new-job",
    supersededAt: "2026-08-10T00:00:00.000Z",
  });
  const labeled = annotateStateView([predecessor], "when did the job title change", [], {
    enabled: true,
    asOfMs: Date.parse("2026-08-05T00:00:00.000Z"),
  });
  assert.equal(labeled.length, 1, "a valid asOf result must never be emptied");
  assert.equal(
    labeled[0]?.stateLabel,
    "current",
    "the pin predates the supersession, so the row was the live fact at the snapshot",
  );
});

test("asOf mode labels a predecessor historical when the supersession predates the pin", () => {
  const predecessor = fact("old-job", {
    status: "superseded",
    supersededBy: "new-job",
    supersededAt: "2026-08-01T00:00:00.000Z",
  });
  const labeled = annotateStateView([predecessor], "when did the job title change", [], {
    enabled: true,
    asOfMs: Date.parse("2026-08-05T00:00:00.000Z"),
  });
  assert.equal(labeled.length, 1);
  assert.equal(labeled[0]?.stateLabel, "historical");
});

test("asOf mode keeps pair semantics when both rows are valid at the pin", () => {
  const rows = [
    fact("new-job", { status: "active" }),
    fact("old-job", { status: "superseded", supersededBy: "new-job", supersededAt: "2026-03-01" }),
  ];
  const labeled = annotateStateView(rows, "when did the job title change", [], {
    enabled: true,
    asOfMs: Date.parse("2026-08-05T00:00:00.000Z"),
  });
  assert.deepEqual(
    labeled.map((row) => [row.id, row.stateLabel]),
    [
      ["new-job", "current"],
      ["old-job", "historical"],
    ],
  );
});

test("non-change query is identical (same array reference, no labels)", () => {
  const input = PAIR_RESULTS.map((row) => ({ ...row }));
  const out = annotateStateView(input, "what is the current job title", PAIR, { enabled: true });
  assert.equal(out, input);
  assert.equal(out[0]?.stateLabel, undefined);
  assert.equal(out[1]?.stateLabel, undefined);
});

test("recallStateViews false is identity (same array reference)", () => {
  const input = PAIR_RESULTS.map((row) => ({ ...row }));
  assert.equal(annotateStateView(input, "when did the job title change", PAIR), input);
  assert.equal(annotateStateView(input, "when did the job title change", PAIR, { enabled: false }), input);
  assert.equal(input[0]?.stateLabel, undefined);
});

test("superseded never appears without its successor", () => {
  const orphan = [fact("old-job", { status: "superseded", supersededBy: "new-job" })];
  const out = annotateStateView(orphan, "when did this change", PAIR, { enabled: true });
  assert.deepEqual(out, []);
  assert.equal(shouldWidenSuperseded("new-job", new Set(["old-job"])), false);
  assert.equal(shouldWidenSuperseded("new-job", new Set(["old-job", "new-job"])), true);
  assert.equal(shouldWidenSuperseded(undefined, new Set(["new-job"])), false);
});

test("annotateStateView is sort-stable", () => {
  const reversed = [PAIR_RESULTS[1]!, PAIR_RESULTS[0]!];
  const labeled = annotateStateView(reversed, "when did the title change", PAIR, { enabled: true });
  assert.deepEqual(
    labeled.map((row) => row.id),
    ["old-job", "new-job"],
  );
  assert.equal(labeled[0]?.stateLabel, "historical");
  assert.equal(labeled[1]?.stateLabel, "current");
});

test("middle hop of a three-node chain is transition", () => {
  const chains: StateViewChain[] = [
    { predecessorId: "v1", successorId: "v2" },
    { predecessorId: "v2", successorId: "v3" },
  ];
  const results = [
    fact("v1", { status: "superseded", supersededBy: "v2" }),
    fact("v2", { status: "superseded", supersededBy: "v3" }),
    fact("v3", { status: "active" }),
  ];
  const labeled = annotateStateView(results, "what changed", chains, { enabled: true });
  assert.deepEqual(
    labeled.map((row) => [row.id, row.stateLabel]),
    [
      ["v1", "historical"],
      ["v2", "transition"],
      ["v3", "current"],
    ],
  );
});

test("formatSupersededPrefix matches the injected-block contract", () => {
  assert.equal(formatSupersededPrefix("2026-03-01", "new-job"), "[superseded 2026-03-01 by new-job]");
});

test("parseRecallStateViews honors 0/false and defaults off", () => {
  assert.equal(parseRecallStateViews(undefined), false);
  assert.equal(parseRecallStateViews(false), false);
  assert.equal(parseRecallStateViews(0), false);
  assert.equal(parseRecallStateViews("false"), false);
  assert.equal(parseRecallStateViews("0"), false);
  assert.equal(parseRecallStateViews(true), true);
  assert.equal(parseRecallStateViews(1), true);
  assert.equal(parseRecallStateViews("true"), true);
});

test("annotateStateView does not mutate input rows", () => {
  const input = PAIR_RESULTS.map((row) => ({ ...row }));
  annotateStateView(input, "when did this change", PAIR, { enabled: true });
  assert.equal(input[0]?.stateLabel, undefined);
  assert.equal(input[1]?.stateLabel, undefined);
});

test("disputed cycle never labels historical against a missing anchor", () => {
  const results = [
    fact("a", { status: "superseded", supersededBy: "b" }),
    fact("b", { status: "superseded", supersededBy: "a" }),
    fact("c", { status: "active" }),
  ];
  const labeled = annotateStateView(results, "when did this change", [], { enabled: true });
  assert.deepEqual(
    labeled.map((row) => [row.id, row.stateLabel]),
    [
      ["a", "transition"],
      ["b", "transition"],
      ["c", "current"],
    ],
    "cycle members may render as transitions, never historical-vs-current",
  );
});

test("corrected row links through the chain when supersededBy is absent", () => {
  const chains: StateViewChain[] = [
    { predecessorId: "old", successorId: "new", supersededAt: "2026-02-01" },
  ];
  const results = [
    fact("new", { status: "active" }),
    fact("old", { status: "superseded", supersededAt: "2026-02-01" }),
  ];
  const labeled = annotateStateView(results, "before the correction what was it", chains, {
    enabled: true,
  });
  assert.deepEqual(
    labeled.map((row) => [row.id, row.stateLabel]),
    [
      ["new", "current"],
      ["old", "historical"],
    ],
  );
});

test("transitive orphan chains collapse: A→B→(C absent) drops both A and B", () => {
  const results = [
    fact("a", { status: "superseded", supersededBy: "b" }),
    fact("b", { status: "superseded", supersededBy: "c" }),
    fact("unrelated", { status: "active" }),
  ];
  const labeled = annotateStateView(results, "when did this change", [], { enabled: true });
  assert.deepEqual(
    labeled.map((row) => row.id),
    ["unrelated"],
    "the fixpoint must drop A once B is dropped, not render a dangling historical",
  );
});

test("#2859 reverse chain derives from the successor supersedes back-pointer when supersededBy is absent", () => {
  const results = [
    fact("new-job", { status: "active", supersedes: "old-job" }),
    // Corrected row: no supersededBy, and even no "superseded" status —
    // the ONLY link is the successor's back-pointer.
    fact("old-job", {}),
  ];
  const labeled = annotateStateView(results, "when did the job title change", [], { enabled: true });
  assert.deepEqual(
    labeled.map((row) => [row.id, row.stateLabel, row.supersededBy]),
    [
      ["new-job", "current", undefined],
      ["old-job", "historical", "new-job"],
    ],
    "the back-pointer must link the pair, admit the predecessor, and carry derived supersededBy",
  );
});

test("#2859 back-pointer pair survives the orphan fixpoint in both directions", () => {
  const results = [
    fact("v3", { status: "active", supersedes: "v2" }),
    fact("v2", { status: "superseded", supersedes: "v1" }),
    fact("v1", {}),
  ];
  const labeled = annotateStateView(results, "what changed about the database", [], { enabled: true });
  assert.deepEqual(
    labeled.map((row) => [row.id, row.stateLabel]),
    [
      ["v3", "current"],
      ["v2", "transition"],
      ["v1", "historical"],
    ],
  );
});

test("#2859 asOf label uses the validity boundary, not the supersededAt write time", () => {
  const pin = Date.parse("2026-08-05T00:00:00.000Z");
  // Write time January, validity flip September: at an August pin the row
  // was still the live fact even though supersededAt PREDATES the pin.
  const predecessor = fact("old-job", {
    status: "superseded",
    supersededBy: "new-job",
    supersededAt: "2026-01-01T00:00:00.000Z",
    invalidAt: "2026-09-01T00:00:00.000Z",
  });
  const labeled = annotateStateView([predecessor], "when did the job title change", [], {
    enabled: true,
    asOfMs: pin,
  });
  assert.equal(
    labeled[0]?.stateLabel,
    "current",
    "the boundary is invalidAt, so a pin before the flip labels the row current-at-snapshot",
  );

  // Past the boundary the same row labels historical (boundary <= pin).
  const afterFlip = annotateStateView([predecessor], "when did the job title change", [], {
    enabled: true,
    asOfMs: Date.parse("2026-09-05T00:00:00.000Z"),
  });
  assert.equal(
    afterFlip[0]?.stateLabel,
    "historical",
    "a pin past the validity flip labels the row historical",
  );

  // Legacy row without a validity window keeps the supersededAt fallback.
  const legacy = fact("old-legacy", {
    status: "superseded",
    supersededBy: "new-legacy",
    supersededAt: "2026-01-01T00:00:00.000Z",
  });
  const legacyLabel = annotateStateView([legacy], "when did the job title change", [], {
    enabled: true,
    asOfMs: pin,
  });
  assert.equal(
    legacyLabel[0]?.stateLabel,
    "historical",
    "no invalidAt → the supersededAt write time is the only recorded boundary",
  );
});

test("#2859 namespace-qualified identities: same id across namespaces never cross-anchors", () => {
  // ns-a has the superseded predecessor; ns-b has an UNRELATED row that
  // happens to reuse the successor id. Bare-id matching would admit the
  // ns-a predecessor on the ns-b anchor.
  const results = [
    fact("m-1", { namespace: "ns-b", status: "active" }),
    fact("m-0", { namespace: "ns-a", status: "superseded", supersededBy: "m-1" }),
  ];
  const labeled = annotateStateView(results, "when did this change", [], { enabled: true });
  assert.deepEqual(
    labeled.map((row) => row.id),
    ["m-1"],
    "a foreign-namespace successor must not anchor the superseded row",
  );

  // Positive control: the same-namespace successor anchors it.
  const anchored = annotateStateView(
    [
      fact("m-1", { namespace: "ns-a", status: "active" }),
      fact("m-0", { namespace: "ns-a", status: "superseded", supersededBy: "m-1" }),
    ],
    "when did this change",
    [],
    { enabled: true },
  );
  assert.deepEqual(
    anchored.map((row) => [row.id, row.stateLabel]),
    [
      ["m-1", "current"],
      ["m-0", "historical"],
    ],
  );
});

test("#2859 namespace-qualified chains: a chain link never crosses namespaces", () => {
  const chains: StateViewChain[] = [
    { predecessorId: "old", successorId: "new", namespace: "ns-a" },
  ];
  const results = [
    fact("new", { namespace: "ns-b", status: "active" }),
    fact("old", { namespace: "ns-a", status: "superseded", supersededAt: "2026-02-01" }),
  ];
  const labeled = annotateStateView(results, "before the correction what was it", chains, {
    enabled: true,
  });
  assert.deepEqual(
    labeled.map((row) => row.id),
    ["new"],
    "the ns-a chain link must not pair against the ns-b successor",
  );
});

test("reconcile drops a linkless superseded row so it cannot consume a packet slot", () => {
  const rows = [
    fact("legacy", { status: "superseded", supersededAt: "2026-01-01" }),
    fact("live", { status: "active" }),
  ];
  assert.deepEqual(
    reconcileStateViewPairs(rows).map((row) => row.id),
    ["live"],
    "audit/kill-switch status-only rows have no successor and must leave before the cap",
  );
  assert.deepEqual(
    capStateViewPackets(reconcileStateViewPairs(rows), 1).map((row) => row.id),
    ["live"],
  );
});

test("reconcile still keeps an unlinked active row", () => {
  const rows = [fact("solo", { status: "active" })];
  assert.deepEqual(
    reconcileStateViewPairs(rows).map((row) => row.id),
    ["solo"],
  );
});
