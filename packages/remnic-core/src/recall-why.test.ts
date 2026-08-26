import assert from "node:assert/strict";
import { test } from "node:test";

import { planRecallMode } from "./intent.js";
import {
  explainRecallMiss,
  RECALL_WHY_STAGES,
  RecallWhyInputError,
  type RecallWhyDeps,
  type RecallWhyMemoryRef,
  type RecallWhyRecallOutcome,
} from "./recall-why.js";
import {
  parseRecallWhyFormat,
  renderRecallWhy,
  renderRecallWhyJson,
  summarizeRecallWhy,
} from "./recall-why-renderer.js";
import { parseWhyCliOptions } from "./recall-why-cli.js";
import { buildXraySnapshot, type RecallXrayResult, type RecallXraySnapshot } from "./recall-xray.js";
import type { MemoryStatus, RecallPlanMode } from "./types.js";

// ─── fixtures ─────────────────────────────────────────────────────────────
//
// A synthetic store whose memories are each engineered to be dropped at a
// DIFFERENT pipeline stage. All content is invented for this test.

interface FixtureMemory extends RecallWhyMemoryRef {
  /** When set, the memory reaches capture and the pipeline rejected it here. */
  rejectedBy?: string;
  /** When true, the memory survives filtering but is cut by the cap. */
  capEvicted?: boolean;
  /** When true, the memory survives every stage. */
  recalled?: boolean;
}

const RECALL_NAMESPACES = ["team-alpha"] as const;

const FIXTURES: FixtureMemory[] = [
  {
    memoryId: "fact-recalled-0001",
    path: "facts/2026-01-02/fact-recalled-0001.md",
    status: "active",
    namespace: "team-alpha",
    recalled: true,
  },
  {
    memoryId: "fact-superseded-0002",
    path: "facts/2026-01-02/fact-superseded-0002.md",
    status: "superseded",
    namespace: "team-alpha",
  },
  {
    memoryId: "fact-archived-0003",
    path: "facts/2026-01-02/fact-archived-0003.md",
    status: "archived",
    namespace: "team-alpha",
  },
  {
    memoryId: "fact-excluded-0004",
    // `artifacts/` is served by its own surface and is excluded from generic
    // recall by `isGenericRecallExcludedPath`.
    path: "artifacts/report-0004.md",
    status: "active",
    namespace: "team-alpha",
  },
  {
    memoryId: "fact-otherns-0005",
    path: "namespaces/team-beta/facts/2026-01-02/fact-otherns-0005.md",
    status: "active",
    namespace: "team-beta",
  },
  {
    memoryId: "fact-capped-0006",
    path: "facts/2026-01-02/fact-capped-0006.md",
    status: "active",
    namespace: "team-alpha",
    capEvicted: true,
  },
  {
    memoryId: "fact-rejected-0007",
    path: "facts/2026-01-02/fact-rejected-0007.md",
    status: "active",
    namespace: "team-alpha",
    rejectedBy: "namespace-scope",
  },
  {
    memoryId: "fact-stale-index-0008",
    path: "facts/2026-01-02/fact-stale-index-0008.md",
    status: "active",
    namespace: "team-alpha",
  },
];

function xrayResult(memory: FixtureMemory): RecallXrayResult {
  return {
    memoryId: memory.memoryId,
    path: memory.path,
    servedBy: "hybrid",
    scoreDecomposition: { final: 0.5 },
    admittedBy: ["namespace-scope"],
    ...(memory.rejectedBy !== undefined ? { rejectedBy: memory.rejectedBy } : {}),
  };
}

/**
 * Snapshot shaped exactly as the real capture would be for this fixture set:
 * `results` is everything captured, `headroomResults` is what survived the
 * policy filters, `appliedResults` is what survived the final cap.
 */
function fixtureSnapshot(): RecallXraySnapshot {
  const captured = FIXTURES.filter((m) => m.recalled === true || m.capEvicted === true || m.rejectedBy !== undefined);
  const survived = captured.filter((m) => m.rejectedBy === undefined);
  return buildXraySnapshot({
    query: "what did we decide about the database?",
    results: captured.map(xrayResult),
    appliedResultLimit: 1,
    headroomResults: survived.map(xrayResult),
    appliedResults: survived.filter((m) => m.recalled === true).map(xrayResult),
    filters: [
      { name: "namespace-scope", considered: captured.length, admitted: survived.length },
      { name: "status | active-only", considered: survived.length, admitted: survived.length },
    ],
    budget: { chars: 4096, used: 128 },
    namespace: "team-alpha",
    now: () => 1_700_000_000_000,
    snapshotIdGenerator: () => "00000000-0000-4000-8000-000000000000",
  });
}

interface DepsOverrides {
  plannerMode?: RecallPlanMode;
  outcome?: RecallWhyRecallOutcome;
  namespacesEnabled?: boolean;
}

function makeDeps(overrides: DepsOverrides = {}): RecallWhyDeps {
  const outcome: RecallWhyRecallOutcome = overrides.outcome ?? {
    ok: true,
    snapshot: fixtureSnapshot(),
  };
  return {
    runRecall: async () => outcome,
    plannerMode: (prompt) => overrides.plannerMode ?? planRecallMode(prompt),
    scopedNamespaces: RECALL_NAMESPACES,
    namespacesEnabled: overrides.namespacesEnabled ?? true,
    // The real predicate, bound with no policy — `artifacts/` is excluded.
    isExcludedPath: (memoryPath) => memoryPath.startsWith("artifacts/"),
    findExpected: async (expect) =>
      FIXTURES.find((m) => m.memoryId === expect) ??
      FIXTURES.find((m) => m.memoryId.includes(expect) || m.path.includes(expect)) ??
      null,
  };
}

const FULL_QUERY = "what did we decide about the database?";

async function expectVerdict(expect: string, overrides: DepsOverrides = {}, query = FULL_QUERY) {
  const report = await explainRecallMiss(query, { deps: makeDeps(overrides), expect });
  assert.ok(report.expectation !== undefined, "an --expect trace must be produced");
  return report;
}

test("the real recall is replayed exactly once, never re-implemented", async () => {
  let invocations = 0;
  const base = makeDeps();
  const deps: RecallWhyDeps = {
    ...base,
    runRecall: async (query, options) => {
      invocations += 1;
      assert.equal(query, FULL_QUERY, "the caller's query is passed through verbatim");
      assert.equal(options.namespace, undefined);
      return { ok: true, snapshot: fixtureSnapshot() };
    },
  };
  await explainRecallMiss(FULL_QUERY, { deps, expect: "fact-superseded-0002" });
  assert.equal(invocations, 1, "one diagnosis must cost exactly one recall");
});

// ─── --expect names the correct stage, per engineered drop cause ───────────

test("a memory that survived every stage reports as recalled", async () => {
  const report = await expectVerdict("fact-recalled-0001");
  assert.equal(report.expectation?.matched, true);
  assert.equal(report.expectation?.recalled, true);
  assert.equal(report.expectation?.stage, undefined);
  assert.equal(report.expectation?.reason, undefined);
  assert.deepEqual(report.recalledMemoryIds, ["fact-recalled-0001"]);
});

test("a superseded memory is dropped at policy-filter with status detail", async () => {
  const report = await expectVerdict("fact-superseded-0002");
  assert.equal(report.expectation?.recalled, false);
  assert.equal(report.expectation?.stage, "policy-filter");
  assert.equal(report.expectation?.reason, "status-filter");
  assert.equal(report.expectation?.detail, "status=superseded");
  assert.match(report.expectation?.remediation ?? "", /active memories/i);
});

test("every non-active status is attributed to the status filter", async () => {
  for (const id of ["fact-superseded-0002", "fact-archived-0003"]) {
    const report = await expectVerdict(id);
    assert.equal(report.expectation?.reason, "status-filter", `${id} must hit the status filter`);
  }
});

test("an excluded path is dropped at policy-filter as path-excluded", async () => {
  const report = await expectVerdict("fact-excluded-0004");
  assert.equal(report.expectation?.stage, "policy-filter");
  assert.equal(report.expectation?.reason, "path-excluded");
  assert.match(report.expectation?.detail ?? "", /artifacts\/report-0004\.md/);
});

test("a memory outside the recall namespaces is dropped at policy-filter", async () => {
  const report = await expectVerdict("fact-otherns-0005");
  assert.equal(report.expectation?.stage, "policy-filter");
  assert.equal(report.expectation?.reason, "namespace-scope");
  assert.match(report.expectation?.detail ?? "", /namespace=team-beta/);
  assert.match(report.expectation?.remediation ?? "", /namespace/i);
});

test("namespace scope is not applied when namespaces are disabled", async () => {
  // Same fixture, namespaces off: the namespace gate must not fire, so the
  // memory falls through to the stale-index verdict instead.
  const report = await expectVerdict("fact-otherns-0005", { namespacesEnabled: false });
  assert.notEqual(report.expectation?.reason, "namespace-scope");
  assert.equal(report.expectation?.reason, "not-a-candidate");
});

test("a memory cut by the final cap is dropped at cap", async () => {
  const report = await expectVerdict("fact-capped-0006");
  assert.equal(report.expectation?.stage, "cap");
  assert.equal(report.expectation?.reason, "cap-eviction");
  assert.match(report.expectation?.detail ?? "", /appliedResultLimit=1/);
});

test("a candidate the pipeline itself rejected reports that filter verbatim", async () => {
  const report = await expectVerdict("fact-rejected-0007");
  assert.equal(report.expectation?.stage, "policy-filter");
  assert.equal(report.expectation?.reason, "namespace-scope");
  assert.equal(report.expectation?.detail, "rejectedBy=namespace-scope");
});

test("a memory that passes every filter but never reached retrieval blames the index", async () => {
  const report = await expectVerdict("fact-stale-index-0008");
  assert.equal(report.expectation?.stage, "retrieval");
  assert.equal(report.expectation?.reason, "not-a-candidate");
  assert.match(report.expectation?.remediation ?? "", /[Rr]eindex/);
});

test("planner mode no_recall is attributed to retrieval, ahead of any policy filter", async () => {
  // The REAL planner classifies a bare acknowledgement as no_recall.
  assert.equal(planRecallMode("ok"), "no_recall");
  const report = await explainRecallMiss("ok", {
    deps: makeDeps({ outcome: { ok: true, snapshot: null } }),
    expect: "fact-superseded-0002",
  });
  assert.equal(report.plannerMode, "no_recall");
  assert.equal(report.expectation?.stage, "retrieval");
  assert.equal(report.expectation?.reason, "planner-mode");
  assert.match(report.expectation?.detail ?? "", /no_recall/);
  // The planner gates retrieval, so it outranks the status filter this
  // memory would also have failed.
  assert.notEqual(report.expectation?.reason, "status-filter");
});

test("planner mode minimal is attributed to retrieval after the policy filters", async () => {
  // The REAL planner classifies a short operational directive as minimal.
  assert.equal(planRecallMode("check the deploy"), "minimal");
  const report = await explainRecallMiss("check the deploy", {
    deps: makeDeps({ outcome: { ok: true, snapshot: null } }),
    expect: "fact-stale-index-0008",
  });
  assert.equal(report.plannerMode, "minimal");
  assert.equal(report.expectation?.stage, "retrieval");
  assert.equal(report.expectation?.reason, "planner-mode");
  assert.match(report.expectation?.detail ?? "", /minimal/);
  // A minimal-mode report annotates the retrieval stage rather than
  // silently reporting a full-headroom run.
  const retrieval = report.stages.find((s) => s.stage === "retrieval");
  assert.match(retrieval?.reason ?? "", /minimal/);
});

test("an unmatched --expect says so instead of naming a stage falsely", async () => {
  const report = await expectVerdict("fact-does-not-exist-9999");
  assert.equal(report.expectation?.matched, false);
  assert.equal(report.expectation?.memoryId, undefined);
  assert.equal(report.expectation?.reason, "not-a-candidate");
  assert.match(report.expectation?.detail ?? "", /no stored memory matches/);
});

test("--expect accepts a substring, not only a full id", async () => {
  const report = await expectVerdict("superseded-0002");
  assert.equal(report.expectation?.memoryId, "fact-superseded-0002");
  assert.equal(report.expectation?.reason, "status-filter");
});

// ─── backend failure is never an empty pipeline (checklist #22) ────────────

test("a backend outage reports backend_unavailable, not zero candidates", async () => {
  const report = await explainRecallMiss(FULL_QUERY, {
    deps: makeDeps({
      outcome: {
        ok: false,
        reason: "backend_unavailable",
        detail: "search index did not respond",
      },
    }),
    expect: "fact-recalled-0001",
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.failure, {
    reason: "backend_unavailable",
    detail: "search index did not respond",
  });
  assert.equal(report.expectation?.reason, "backend-unavailable");
  assert.equal(report.expectation?.stage, "retrieval");
  // Only the retrieval stage is reported. No downstream stage ran, so none
  // may claim it "considered 0" — that is exactly the empty-vs-failed
  // conflation this asserts against.
  assert.deepEqual(
    report.stages.map((s) => s.stage),
    ["retrieval"]
  );
  assert.match(report.stages[0]?.reason ?? "", /backend_unavailable/);
  assert.match(summarizeRecallWhy(report), /backend_unavailable/);
});

test("an honest empty recall stays ok:true and is not reported as an outage", async () => {
  const report = await explainRecallMiss(FULL_QUERY, {
    deps: makeDeps({ outcome: { ok: true, snapshot: null } }),
  });
  assert.equal(report.ok, true);
  assert.equal(report.failure, undefined);
  assert.deepEqual(report.recalledMemoryIds, []);
});

// ─── stage records ────────────────────────────────────────────────────────

test("stages are reported in contract order with real per-stage counts", async () => {
  const report = await explainRecallMiss(FULL_QUERY, { deps: makeDeps() });
  assert.deepEqual(
    report.stages.map((s) => s.stage),
    [...RECALL_WHY_STAGES]
  );
  const byStage = new Map(report.stages.map((s) => [s.stage, s]));
  // 3 captured (recalled + cap-evicted + rejected), 1 rejected by policy.
  assert.equal(byStage.get("retrieval")?.considered, 3);
  assert.equal(byStage.get("policy-filter")?.considered, 3);
  assert.equal(byStage.get("policy-filter")?.admitted, 2);
  assert.equal(byStage.get("cap")?.considered, 2);
  assert.equal(byStage.get("cap")?.admitted, 1);
  assert.equal(byStage.get("format")?.considered, 1);
});

test("drops are attributed to the stage that dropped them", async () => {
  const report = await explainRecallMiss(FULL_QUERY, { deps: makeDeps() });
  const byStage = new Map(report.stages.map((s) => [s.stage, s]));
  assert.deepEqual(
    byStage.get("policy-filter")?.drops.map((d) => d.memoryId),
    ["fact-rejected-0007"]
  );
  assert.deepEqual(
    byStage.get("cap")?.drops.map((d) => d.memoryId),
    ["fact-capped-0006"]
  );
  assert.equal(byStage.get("cap")?.drops[0]?.reason, "cap-eviction");
});

test("cap drops are sorted by (memoryId, path), not by capture order", async () => {
  // Fed in DESCENDING id order: a report that echoed capture order would
  // fail this, and a comparator that never returns 0 would be unstable.
  const evicted = ["fact-zzz-0003", "fact-mmm-0002", "fact-aaa-0001"].map((memoryId) => ({
    memoryId,
    path: `facts/2026-01-02/${memoryId}.md`,
    status: "active" as MemoryStatus,
    namespace: "team-alpha",
    capEvicted: true,
  }));
  const snapshot = buildXraySnapshot({
    query: FULL_QUERY,
    results: evicted.map(xrayResult),
    headroomResults: evicted.map(xrayResult),
    appliedResults: [],
    appliedResultLimit: 0,
    budget: { chars: 4096, used: 0 },
  });
  const deps = makeDeps({ outcome: { ok: true, snapshot } });
  const first = await explainRecallMiss(FULL_QUERY, { deps });
  const second = await explainRecallMiss(FULL_QUERY, { deps });
  const capDrops = first.stages.find((s) => s.stage === "cap")?.drops ?? [];
  assert.deepEqual(
    capDrops.map((d) => d.memoryId),
    ["fact-aaa-0001", "fact-mmm-0002", "fact-zzz-0003"]
  );
  assert.deepEqual(first.stages, second.stages);
});

// ─── input validation (checklists #1, #39, #45) ────────────────────────────

test("an empty or whitespace-only query is rejected, never silently defaulted", async () => {
  for (const bad of ["", "   ", "\t\n"]) {
    await assert.rejects(
      () => explainRecallMiss(bad, { deps: makeDeps() }),
      RecallWhyInputError,
      `query ${JSON.stringify(bad)} must be rejected`
    );
  }
});

test("a whitespace-only --expect is rejected rather than treated as absent", async () => {
  await assert.rejects(() => explainRecallMiss(FULL_QUERY, { deps: makeDeps(), expect: "   " }), RecallWhyInputError);
});

test("a non-finite appliedResultLimit cannot leak into the report", async () => {
  // A corrupt upstream value must clamp to 0, never surface as NaN. The
  // spread is fully typed — `appliedResultLimit` is a `number`, and NaN is
  // a number — so no cast is needed to plant it.
  const snapshot: RecallXraySnapshot = {
    ...fixtureSnapshot(),
    appliedResultLimit: Number.NaN,
  };
  const report = await explainRecallMiss(FULL_QUERY, {
    deps: makeDeps({ outcome: { ok: true, snapshot } }),
  });
  assert.equal(report.appliedResultLimit, 0);
  assert.equal(Number.isFinite(report.appliedResultLimit), true);
});

// ─── renderer + CLI parsing ───────────────────────────────────────────────

test("the markdown renderer names the drop stage and the remediation", async () => {
  const report = await expectVerdict("fact-superseded-0002");
  const markdown = renderRecallWhy(report, "markdown");
  assert.match(markdown, /# Recall diagnosis/);
  assert.match(markdown, /\*\*Dropped at policy-filter: status-filter\*\*/);
  assert.match(markdown, /Remediation: /);
  assert.match(markdown, /\| policy-filter \| 3 \| 2 \|/);
});

test("the markdown renderer states an outage instead of an empty pipeline", async () => {
  const report = await explainRecallMiss(FULL_QUERY, {
    deps: makeDeps({
      outcome: { ok: false, reason: "backend_unavailable", detail: "index daemon down" },
    }),
  });
  const markdown = renderRecallWhy(report, "markdown");
  assert.match(markdown, /## Backend unavailable/);
  assert.match(markdown, /index daemon down/);
  assert.match(markdown, /not a zero-candidate recall/);
});

test("the JSON renderer round-trips the report verbatim", async () => {
  const report = await expectVerdict("fact-capped-0006");
  assert.deepEqual(JSON.parse(renderRecallWhyJson(report)), JSON.parse(JSON.stringify(report)));
  assert.equal(renderRecallWhy(report, "json"), renderRecallWhyJson(report));
});

test("--format rejects an unknown value and lists the valid ones", () => {
  assert.equal(parseRecallWhyFormat(undefined), "markdown");
  assert.equal(parseRecallWhyFormat("JSON"), "json");
  assert.throws(() => parseRecallWhyFormat("jsno"), /json, markdown/);
  assert.throws(() => parseRecallWhyFormat(true), /json, markdown/);
});

test("the CLI parser rejects a flag supplied without a value", () => {
  assert.deepEqual(parseWhyCliOptions("why did that miss?", {}), {
    query: "why did that miss?",
    format: "markdown",
  });
  assert.deepEqual(parseWhyCliOptions("q", { expect: " fact-1 ", namespace: "team-alpha", out: "report.md" }), {
    query: "q",
    format: "markdown",
    expect: "fact-1",
    namespace: "team-alpha",
    outPath: "report.md",
  });
  // Commander hands a valueless `--expect` through as `true`.
  assert.throws(() => parseWhyCliOptions("q", { expect: true }), /--expect expects/);
  assert.throws(() => parseWhyCliOptions("q", { namespace: "  " }), /--namespace expects/);
  assert.throws(() => parseWhyCliOptions("   ", {}), /non-empty query/);
});

test("an inherited option is never read as a supplied flag", () => {
  const inherited = Object.create({ expect: "fact-recalled-0001" }) as Record<string, unknown>;
  assert.deepEqual(parseWhyCliOptions("q", inherited), { query: "q", format: "markdown" });
});

// ─── status coverage is exhaustive (checklist #41) ─────────────────────────

test("only the active status survives the status gate", async () => {
  const statuses: MemoryStatus[] = ["pending_review", "rejected", "quarantined", "superseded", "archived"];
  for (const status of statuses) {
    const deps: RecallWhyDeps = {
      ...makeDeps({ outcome: { ok: true, snapshot: null } }),
      findExpected: async () => ({
        memoryId: "fact-status-probe",
        path: "facts/2026-01-02/fact-status-probe.md",
        status,
        namespace: "team-alpha",
      }),
    };
    const report = await explainRecallMiss(FULL_QUERY, { deps, expect: "fact-status-probe" });
    assert.equal(
      report.expectation?.reason,
      "status-filter",
      `status ${status} must be reported as a status-filter drop`
    );
    assert.equal(report.expectation?.detail, `status=${status}`);
  }
});
