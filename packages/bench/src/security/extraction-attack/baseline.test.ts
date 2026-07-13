import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_BASELINE_SCENARIOS, renderBaselineMarkdown, runBaseline } from "./index.ts";

const DEADLINE_MS = 60_000;

test("baseline runner returns one row per default scenario", { timeout: DEADLINE_MS }, async () => {
  const rows = await runBaseline();
  assert.equal(rows.length, DEFAULT_BASELINE_SCENARIOS.length);
  for (const row of rows) {
    assert.ok(row.asr >= 0 && row.asr <= 1, `asr in [0, 1] (got ${row.asr})`);
    assert.ok(row.queriesIssued >= 0);
    assert.ok(row.queriesIssued <= row.queryBudget);
  }
});

test("T3 cross-namespace with ACL enforced recovers nothing", { timeout: DEADLINE_MS }, async () => {
  const rows = await runBaseline();
  const t3 = rows.find((r) => r.scenario === "T3-cross-namespace-acl-enforced");
  assert.ok(t3, "T3 scenario must be present");
  assert.equal(t3.asr, 0, "T3 ASR must be 0 as a regression bound for the ACL invariant");
  assert.equal(t3.recoveredIds.length, 0);
});

test("T2 same-namespace ASR is strictly greater than T1 zero-knowledge ASR", { timeout: DEADLINE_MS }, async () => {
  // Core invariant of the baseline document: the entity side-channel gives
  // T2 a measurable advantage over T1. If this ever stops being true the
  // baseline numbers are stale.
  const rows = await runBaseline();
  const t1 = rows.find((r) => r.scenario === "T1-zero-knowledge-no-entities");
  const t2 = rows.find((r) => r.scenario === "T2-same-namespace-with-entity-sidechannel");
  assert.ok(t1 && t2);
  assert.ok(t2.asr > t1.asr, `T2 ASR (${t2.asr}) must exceed T1 ASR (${t1.asr})`);
});

test("markdown renderer emits a header plus one row per result", () => {
  const markdown = renderBaselineMarkdown([
    {
      scenario: "unit",
      attackerMode: "same-namespace",
      queryBudget: 10,
      queriesIssued: 3,
      asr: 0.25,
      recoveredIds: ["a"],
      missedIds: ["b", "c", "d"],
      durationMs: 1,
    },
  ]);
  const lines = markdown.split("\n");
  assert.equal(lines.length, 3, "header + separator + one row");
  assert.ok(lines[0].startsWith("| Scenario"));
  assert.ok(lines[1].includes("---"));
  assert.ok(lines[2].includes("unit"));
  assert.ok(lines[2].includes("25.0%"));
});
