import test from "node:test";
import assert from "node:assert/strict";
import type { ActivationPath } from "./graph.js";
import { scoreEvidencePath, type PathNodeState, type PathScoringOptions } from "./graph-path-scoring.js";

const activationPath = (nodeIds: string[], edgeConfidences: number[]): ActivationPath => ({
  nodeIds,
  edgeConfidences,
  graphTypes: edgeConfidences.map(() => "entity"),
});

const state = (
  id: string,
  status: PathNodeState["status"] = "active",
  invalidAt: string | null = null,
  temporal: Record<string, string | null | undefined> = {},
): PathNodeState => ({
  id,
  status,
  created: "2025-01-01T00:00:00.000Z",
  ...(invalidAt !== null ? { invalid_at: invalidAt } : {}),
  ...temporal,
});

const score = (
  evidencePath: ActivationPath | null,
  states: ReadonlyMap<string, PathNodeState>,
  options: Partial<PathScoringOptions> = {},
): number =>
  scoreEvidencePath(evidencePath, states, {
    asOf: "2026-01-01T00:00:00.000Z",
    invalidNodePenalty: 0.2,
    ...options,
  });

test("scores the edge confidence product across a clean path", () => {
  assert.equal(score(activationPath(["seed", "mid", "candidate"], [0.8, 0.5]), new Map()), 0.4);
});

test("penalizes one invalid intermediate memory", () => {
  const states = new Map([["mid", state("mid", "superseded")]]);
  assert.equal(
    score(activationPath(["seed", "mid", "candidate"], [0.8, 0.5]), states),
    0.8 * 0.5 * 0.2,
  );
});

test("squares the penalty for two invalid intermediate memories", () => {
  const states = new Map([
    ["mid", state("mid", "superseded")],
    ["mid-2", state("mid-2", "active", "2025-01-01T00:00:00.000Z")],
  ]);
  assert.equal(
    score(activationPath(["seed", "mid", "mid-2", "candidate"], [0.8, 0.5, 0.25]), states),
    0.8 * 0.5 * 0.25 * 0.2 * 0.2,
  );
});

test("ignores seed and candidate state", () => {
  const states = new Map([
    ["seed", state("seed", "rejected", "2025-01-01T00:00:00.000Z")],
    ["candidate", state("candidate", "archived", "2025-01-01T00:00:00.000Z")],
  ]);
  assert.equal(score(activationPath(["seed", "candidate"], [0.7]), states), 0.7);
});

test("treats null status as neutral even with invalidAt", () => {
 const states = new Map([
 ["entity-mid", state("entity-mid", null, "2020-01-01T00:00:00.000Z")],
 ]);
 assert.equal(
 score(activationPath(["seed", "entity-mid", "candidate"], [0.7, 0.6]), states),
 0.7 * 0.6,
 );
});
test("treats malformed invalidAt as neutral", () => {
  const states = new Map([
    ["entity-mid", state("entity-mid", "superseded", "not-a-date")],
  ]);
  assert.equal(
    score(activationPath(["seed", "entity-mid", "candidate"], [0.7, 0.6]), states),
    0.7 * 0.6,
  );
});

test("treats an unknown intermediate id as neutral", () => {
  assert.equal(
    score(activationPath(["seed", "unknown", "candidate"], [0.7, 0.6]), new Map()),
    0.7 * 0.6,
  );
});

test("treats invalidAt equal to asOf as invalid", () => {
  const states = new Map([
    ["boundary", state("boundary", "active", "2026-01-01T00:00:00.000Z")],
  ]);
  assert.equal(
    score(activationPath(["seed", "boundary", "candidate"], [1, 1]), states),
    0.2,
  );
});

test("treats a future invalidAt as valid", () => {
  const states = new Map([
    ["future", state("future", "active", "2026-01-02T00:00:00.000Z")],
  ]);
  assert.equal(
    score(activationPath(["seed", "future", "candidate"], [1, 1]), states),
    1,
  );
});

test("keeps penalty one as a no-op", () => {
  const states = new Map([["mid", state("mid", "rejected")]]);
  assert.equal(
    score(activationPath(["seed", "mid", "candidate"], [0.8, 0.5]), states, {
      invalidNodePenalty: 1,
    }),
    0.8 * 0.5,
  );
});

test("returns one for a missing path", () => {
  assert.equal(score(null, new Map()), 1);
});
test("reports path penalty only for invalid intermediate state", async () => {
  const { scoreEvidencePathDetail } = await import("./graph-path-scoring.js");
  const validDetail = scoreEvidencePathDetail(
    activationPath(["seed", "mid", "candidate"], [0.2, 0.3]),
    new Map([["mid", state("mid", "active")]]),
    {
      asOf: "2026-01-01T00:00:00.000Z",
      invalidNodePenalty: 0.2,
    },
  );
  assert.equal(validDetail.score, 0.2 * 0.3);
  assert.equal(validDetail.pathPenaltyApplied, false);

  const invalidDetail = scoreEvidencePathDetail(
    activationPath(["seed", "mid", "candidate"], [1, 1]),
    new Map([["mid", state("mid", "superseded")]]),
    {
      asOf: "2026-01-01T00:00:00.000Z",
      invalidNodePenalty: 0.2,
    },
  );
  assert.equal(invalidDetail.pathPenaltyApplied, true);
});

test("uses invalidAt for historical supersession validity", () => {
  const states = new Map([
    ["mid", state("mid", "superseded", "2026-02-01T00:00:00.000Z")],
  ]);
  assert.equal(
    score(
      activationPath(["seed", "mid", "candidate"], [1, 1]),
      states,
      { asOf: "2026-01-01T00:00:00.000Z" },
    ),
    1,
  );
  assert.equal(
    score(
      activationPath(["seed", "mid", "candidate"], [1, 1]),
      states,
      { asOf: "2026-03-01T00:00:00.000Z" },
    ),
    0.2,
  );
});

test("penalizes an active intermediate that begins after historical asOf", () => {
  const states = new Map([
    [
      "mid",
      state("mid", "active", null, {
        valid_at: "2026-02-01T00:00:00.000Z",
        created: "2026-02-01T00:00:00.000Z",
      }),
    ],
  ]);
  assert.equal(
    score(
      activationPath(["seed", "mid", "candidate"], [1, 1]),
      states,
      { asOf: "2026-01-01T00:00:00.000Z" },
    ),
    0.2,
  );
});

test("uses legacy supersededAt as the historical end bound", () => {
  const states = new Map([
    [
      "mid",
      state("mid", "superseded", null, {
        created: "2025-01-01T00:00:00.000Z",
        supersededAt: "2026-02-01T00:00:00.000Z",
      }),
    ],
  ]);
  const path = activationPath(["seed", "mid", "candidate"], [1, 1]);
  assert.equal(score(path, states, { asOf: "2026-01-01T00:00:00.000Z" }), 1);
  assert.equal(score(path, states, { asOf: "2026-03-01T00:00:00.000Z" }), 0.2);
});

test("rejects a non-finite asOf", () => {
  assert.throws(
    () =>
      score(
        activationPath(["seed", "mid", "candidate"], [1, 1]),
        new Map(),
        { asOf: "not-a-date" },
      ),
    /asOf must be a finite timestamp/,
  );
  assert.throws(
    () =>
      scoreEvidencePath(
        null,
        new Map(),
        { asOf: "not-a-date", invalidNodePenalty: 0.2 },
      ),
    /asOf must be a finite timestamp/,
  );
});
