import assert from "node:assert/strict";
import test from "node:test";

import { ASSISTANT_MORNING_BRIEF_SCENARIOS } from "./fixture.ts";

test("stale-content guard fixture includes stale control and changed-since-Friday evidence", () => {
  const scenario = ASSISTANT_MORNING_BRIEF_SCENARIOS.find(
    (candidate) => candidate.id === "morning-brief.stale-content-guard",
  );
  assert.ok(scenario, "expected stale-content guard scenario");

  const facts = scenario.memoryGraph.facts;
  assert.ok(
    facts.some(
      (fact) =>
        fact.tags.includes("stale") &&
        /last edited three months ago/i.test(fact.summary),
    ),
    "expected stale negative-control fact",
  );

  const evidenceText = [
    ...facts.map((fact) => fact.summary),
    ...scenario.memoryGraph.openThreads,
  ].join("\n");
  assert.match(evidenceText, /Saturday 10:30/);
  assert.match(evidenceText, /after Friday|changed-since-friday/i);
});
