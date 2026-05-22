import assert from "node:assert/strict";
import test from "node:test";

import { ASSISTANT_NEXT_BEST_ACTION_SCENARIOS } from "./fixture.js";

test("next-best-action deadline scenarios carry a fixed current-date anchor", () => {
  const deadlineScenario = ASSISTANT_NEXT_BEST_ACTION_SCENARIOS.find(
    (scenario) => scenario.id === "nba.deadline-ranking",
  );

  assert.ok(deadlineScenario);
  assert.equal(deadlineScenario.memoryGraph.currentDate, "Monday, May 18, 2026");

  const renderedScenarioText = [
    deadlineScenario.scenarioPrompt,
    ...deadlineScenario.memoryGraph.facts.map((fact) => fact.summary),
    ...deadlineScenario.memoryGraph.openThreads,
  ].join("\n");
  assert.doesNotMatch(renderedScenarioText, /\byesterday\b/i);
  assert.doesNotMatch(renderedScenarioText, /\bnext\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
});
