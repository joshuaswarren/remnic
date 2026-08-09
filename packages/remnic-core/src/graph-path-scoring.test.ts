import test from "node:test";
import assert from "node:assert/strict";
import type { ActivationPath } from "./graph.js";
import { scoreEvidencePath, type PathNodeState, type PathScoringOptions } from "./graph-path-scoring.js";

const path = (nodeIds: string[], edgeConfidences: number[]): ActivationPath => ({
  nodeIds,
  edgeConfidences,
  graphTypes: edgeConfidences.map(() => "entity"),
});

const score = (
  evidencePath: ActivationPath | null,
  states: ReadonlyMap<string, PathNodeState>,
  options: Partial<PathScoringOptions> = {},
): number =>
  scoreEvidencePath(evidencePath, states, {
    asOf: Date.parse("2026-01-01T00:00:00.000Z"),
    invalidNodePenalty: 0.2,
    ...options,
  });

test("scores edge confidence product across a clean path", () => {
  assert.equal(score(path(["seed", "mid", "candidate"], [0.8, 0.5]), new Map()), 0.4);
});

test("applies the invalid-node penalty once per invalid intermediate", () => {
  const states = new Map([
    ["mid", { status: "superseded" }],
    ["mid-2", { invalidAt: "2025-01-01T00:00:00.000Z" }],
  ]);
  assert.equal(
    score(path(["seed", "mid", "mid-2", "candidate"], [0.8, 0.5, 0.25]), states),
    0.8 * 0.5 * 0.25 * 0.2 * 0.2,
  );
});

test("ignores seed and candidate validity while penalizing entity intermediates", () => {
  const states = new Map([
    ["seed", { status: "rejected" }],
    ["entity-mid", { status: "archived" }],
    ["candidate", { invalidAt: "2025-01-01T00:00:00.000Z" }],
  ]);
  assert.equal(score(path(["seed", "entity-mid", "candidate"], [0.7, 0.6]), states), 0.7 * 0.6 * 0.2);
});

test("treats null or missing state as neutral", () => {
  const states = new Map<string, PathNodeState | null>([["mid", null]]);
  assert.equal(score(path(["seed", "mid", "candidate"], [0.7, 0.6]), states), 0.42);
});

test("uses the exclusive invalidAt boundary and keeps future invalidAt valid", () => {
  const boundary = Date.parse("2026-01-01T00:00:00.000Z");
  const states = new Map([
    ["boundary", { invalidAt: "2026-01-01T00:00:00.000Z" }],
    ["future", { invalidAt: "2026-01-02T00:00:00.000Z" }],
  ]);
  assert.equal(
    score(path(["seed", "boundary", "future", "candidate"], [1, 1, 1]), states, { asOf: boundary }),
    0.2,
  );
});

test("keeps penalty one as a no-op and clamps the multiplier to one", () => {
  assert.equal(
    score(path(["seed", "mid", "candidate"], [2, 3]), new Map([["mid", { status: "rejected" }]]), {
      invalidNodePenalty: 1,
    }),
    1,
  );
});

test("returns one for a missing path", () => {
  assert.equal(score(null, new Map()), 1);
});
