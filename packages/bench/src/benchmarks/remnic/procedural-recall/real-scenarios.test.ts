import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runProceduralAblation } from "./ablation.ts";
import {
  PROCEDURAL_REAL_SCENARIOS,
  PROCEDURAL_REAL_SCENARIOS_SMOKE,
  type ProceduralRealScenarioCategory,
} from "./real-scenarios.ts";

const REQUIRED_CATEGORIES: ProceduralRealScenarioCategory[] = [
  "exact-re-run",
  "parameter-variation",
  "decomposition",
  "distractor-rejection",
];

test("PROCEDURAL_REAL_SCENARIOS: fixture shape and coverage", () => {
  assert.ok(
    PROCEDURAL_REAL_SCENARIOS.length >= 20,
    `expected at least 20 scenarios, got ${PROCEDURAL_REAL_SCENARIOS.length}`,
  );
  const ids = new Set<string>();
  for (const s of PROCEDURAL_REAL_SCENARIOS) {
    assert.equal(typeof s.id, "string");
    assert.ok(s.id.length > 0, "scenario id must be non-empty");
    assert.ok(!ids.has(s.id), `duplicate scenario id: ${s.id}`);
    ids.add(s.id);
    assert.equal(typeof s.prompt, "string");
    assert.equal(typeof s.procedurePreamble, "string");
    assert.ok(Array.isArray(s.procedureSteps) && s.procedureSteps.length > 0);
    assert.ok(Array.isArray(s.procedureTags));
    assert.equal(typeof s.expectMatch, "boolean");
    assert.ok(
      REQUIRED_CATEGORIES.includes(s.category),
      `unknown category: ${s.category}`,
    );
  }
  for (const cat of REQUIRED_CATEGORIES) {
    assert.ok(
      PROCEDURAL_REAL_SCENARIOS.some((s) => s.category === cat),
      `category missing: ${cat}`,
    );
  }
});

test("PROCEDURAL_REAL_SCENARIOS_SMOKE: spans all categories", () => {
  const cats = new Set(PROCEDURAL_REAL_SCENARIOS_SMOKE.map((s) => s.category));
  for (const cat of REQUIRED_CATEGORIES) {
    assert.ok(cats.has(cat), `smoke slice missing ${cat}`);
  }
});

test("PROCEDURAL_REAL_SCENARIOS: ablation lift >= 3 points (reproducible)", async () => {
  const scenarios = PROCEDURAL_REAL_SCENARIOS.map((s) => ({
    id: s.id,
    prompt: s.prompt,
    procedurePreamble: s.procedurePreamble,
    procedureSteps: s.procedureSteps,
    procedureTags: s.procedureTags,
    expectMatch: s.expectMatch,
  }));

  const artifact = await runProceduralAblation({
    scenarios,
    seed: 0x72656d6e,
    bootstrapIterations: 500,
  });

  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.fixture.scenarioCount, scenarios.length);
  assert.ok(
    artifact.lift >= 0.03,
    `lift must be >= 3 points, got ${artifact.lift.toFixed(4)} (on=${artifact.onScore.toFixed(4)}, off=${artifact.offScore.toFixed(4)})`,
  );
  const distractors = artifact.perCase.filter((c) => c.expectMatch === false);
  for (const c of distractors) {
    assert.equal(
      c.onMatched,
      false,
      `distractor ${c.id} wrongly recalled on ON side`,
    );
    assert.equal(
      c.offMatched,
      false,
      `distractor ${c.id} wrongly recalled on OFF side`,
    );
  }
});

test("procedural-recall-baseline.json matches a fresh deterministic run", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const baselinePath = path.resolve(
    here,
    "../../../../baselines/procedural-recall-baseline.json",
  );

  const raw = await readFile(baselinePath, "utf8");
  const baseline = JSON.parse(raw) as {
    schemaVersion: number;
    fixture: { scenarioCount: number };
    onScore: number;
    offScore: number;
    lift: number;
    confidenceInterval: { lower: number; upper: number; level: number };
    perCase: Array<{ id: string; onMatched: boolean; offMatched: boolean }>;
  };

  const scenarios = PROCEDURAL_REAL_SCENARIOS.map((s) => ({
    id: s.id,
    prompt: s.prompt,
    procedurePreamble: s.procedurePreamble,
    procedureSteps: s.procedureSteps,
    procedureTags: s.procedureTags,
    expectMatch: s.expectMatch,
  }));
  const fresh = await runProceduralAblation({
    scenarios,
    seed: 0x72656d6e,
    bootstrapIterations: 500,
  });

  assert.equal(fresh.schemaVersion, baseline.schemaVersion);
  assert.equal(fresh.fixture.scenarioCount, baseline.fixture.scenarioCount);
  assert.equal(fresh.onScore, baseline.onScore);
  assert.equal(fresh.offScore, baseline.offScore);
  assert.equal(fresh.lift, baseline.lift);
  assert.equal(
    fresh.confidenceInterval.lower,
    baseline.confidenceInterval.lower,
  );
  assert.equal(
    fresh.confidenceInterval.upper,
    baseline.confidenceInterval.upper,
  );
  assert.equal(fresh.confidenceInterval.level, baseline.confidenceInterval.level);
  assert.equal(fresh.perCase.length, baseline.perCase.length);
  for (let i = 0; i < fresh.perCase.length; i++) {
    const a = fresh.perCase[i]!;
    const b = baseline.perCase[i]!;
    assert.equal(a.id, b.id, `perCase[${i}] id drifted`);
    assert.equal(a.onMatched, b.onMatched, `perCase[${i}] onMatched drifted`);
    assert.equal(a.offMatched, b.offMatched, `perCase[${i}] offMatched drifted`);
  }
});
