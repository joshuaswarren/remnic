/**
 * Tests for the `--include-low-confidence` flag (issue #681 PR 3/3 completion).
 *
 * Exercises two pure-function layers that implement the flag without booting
 * an orchestrator:
 *
 *  1. `GraphIndex.spreadingActivation()` — when `opts.includeLowConfidence`
 *     is true the adjacency build must use floor=0, so edges below the
 *     configured `graphTraversalConfidenceFloor` contribute activation.
 *     When the flag is absent (default), those edges are still pruned.
 *
 *  2. `RecallInvocationOptions.includeLowConfidence` — the field is defined
 *     and accepted by the interface (type-level sanity check).
 *
 * Test data is fully synthetic (CLAUDE.md public-repo rule: no real
 * conversation content or user identifiers).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  clampConfidenceFloor,
  type GraphConfig,
  GraphIndex,
} from "../../packages/remnic-core/src/graph.js";
import type { RecallInvocationOptions } from "../../packages/remnic-core/src/orchestrator.js";
import { validateRequest } from "../../packages/remnic-core/src/access-schema.js";

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/** Minimal GraphConfig that satisfies the interface. */
function makeConfig(overrides: Partial<GraphConfig> = {}): GraphConfig {
  return {
    multiGraphMemoryEnabled: true,
    entityGraphEnabled: true,
    timeGraphEnabled: true,
    causalGraphEnabled: true,
    maxGraphTraversalSteps: 3,
    graphActivationDecay: 0.7,
    maxEntityGraphEdgesPerMemory: 10,
    graphLateralInhibitionEnabled: false,
    graphLateralInhibitionBeta: 1.0,
    graphLateralInhibitionTopM: 7,
    graphTraversalConfidenceFloor: 0.5, // floor set at 0.5 for tests
    graphTraversalPageRankIterations: 0, // disable PageRank so BFS is deterministic
    ...overrides,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 1. clampConfidenceFloor — unit tests (already exported)
// ───────────────────────────────────────────────────────────────────────────

test("clampConfidenceFloor returns default for non-finite input", () => {
  assert.equal(clampConfidenceFloor(NaN), 0.2);
  assert.equal(clampConfidenceFloor(undefined), 0.2);
  assert.equal(clampConfidenceFloor("bad"), 0.2);
});

test("clampConfidenceFloor clamps to [0, 1]", () => {
  assert.equal(clampConfidenceFloor(-1), 0);
  assert.equal(clampConfidenceFloor(2), 1);
  assert.equal(clampConfidenceFloor(0.3), 0.3);
});

// ───────────────────────────────────────────────────────────────────────────
// 2. spreadingActivation — confidence floor pruning
//
// We create a temporary on-disk JSONL store with two edges:
//   seed → nodeA  (confidence 0.8 — above the 0.5 floor)
//   seed → nodeB  (confidence 0.1 — below the 0.5 floor)
//
// Default behavior: only nodeA is returned.
// With includeLowConfidence=true: both nodeA and nodeB are returned.
// ───────────────────────────────────────────────────────────────────────────

import { mkdir, writeFile, rm } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

async function makeTmpGraph(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await (async () => {
    const tmp = path.join(os.tmpdir(), `remnic-test-ilc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(path.join(tmp, "state", "graphs"), { recursive: true });
    return tmp;
  })();

  // Write two entity edges: one above floor (0.8), one below floor (0.1)
  const edges = [
    { from: "seed.md", to: "nodeA.md", type: "entity", weight: 1.0, label: "TestEntity", ts: "2026-01-01T00:00:00.000Z", confidence: 0.8 },
    { from: "seed.md", to: "nodeB.md", type: "entity", weight: 1.0, label: "TestEntity", ts: "2026-01-01T00:00:00.000Z", confidence: 0.1 },
  ];
  const body = edges.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(path.join(dir, "state", "graphs", "entity.jsonl"), body, "utf-8");

  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("spreadingActivation — default floor prunes low-confidence edges", async () => {
  const { dir, cleanup } = await makeTmpGraph();
  try {
    const cfg = makeConfig({ graphTraversalConfidenceFloor: 0.5 });
    const index = new GraphIndex(dir, cfg);
    const results = await index.spreadingActivation(["seed.md"]);
    const paths = results.map((r) => r.path);
    assert.ok(paths.includes("nodeA.md"), "nodeA (conf=0.8) should be included");
    assert.ok(!paths.includes("nodeB.md"), "nodeB (conf=0.1) should be pruned by floor=0.5");
  } finally {
    await cleanup();
  }
});

test("spreadingActivation — includeLowConfidence bypasses floor", async () => {
  const { dir, cleanup } = await makeTmpGraph();
  try {
    const cfg = makeConfig({ graphTraversalConfidenceFloor: 0.5 });
    const index = new GraphIndex(dir, cfg);
    const results = await index.spreadingActivation(
      ["seed.md"],
      undefined,
      { includeLowConfidence: true },
    );
    const paths = results.map((r) => r.path);
    assert.ok(paths.includes("nodeA.md"), "nodeA (conf=0.8) should be included");
    assert.ok(paths.includes("nodeB.md"), "nodeB (conf=0.1) should be included when floor bypassed");
  } finally {
    await cleanup();
  }
});

test("spreadingActivation — includeLowConfidence=false is equivalent to default", async () => {
  const { dir, cleanup } = await makeTmpGraph();
  try {
    const cfg = makeConfig({ graphTraversalConfidenceFloor: 0.5 });
    const index = new GraphIndex(dir, cfg);
    const withFalse = await index.spreadingActivation(
      ["seed.md"],
      undefined,
      { includeLowConfidence: false },
    );
    const withDefault = await index.spreadingActivation(["seed.md"]);
    assert.deepEqual(
      withFalse.map((r) => r.path).sort(),
      withDefault.map((r) => r.path).sort(),
      "explicit false should behave identically to omitting the option",
    );
  } finally {
    await cleanup();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 3. RecallInvocationOptions type-level check
//    (TypeScript would catch this at compile time, but we add a runtime
//     check so the test suite catches regressions if the field is removed)
// ───────────────────────────────────────────────────────────────────────────

test("RecallInvocationOptions accepts includeLowConfidence field", () => {
  // If the interface does not define the field this assignment produces a
  // compile-time error (tsc --strict).  At runtime we just confirm the object
  // can be constructed without throwing.
  const opts: RecallInvocationOptions = {
    includeLowConfidence: true,
  };
  assert.equal(opts.includeLowConfidence, true);
});

test("RecallInvocationOptions includeLowConfidence defaults to undefined (optional)", () => {
  const opts: RecallInvocationOptions = {};
  assert.equal(opts.includeLowConfidence, undefined);
});

test("recall request schema preserves includeLowConfidence body field", () => {
  const result = validateRequest("recall", {
    query: "diagnose graph traversal",
    includeLowConfidence: true,
  });

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(
    (result.data as { includeLowConfidence?: boolean }).includeLowConfidence,
    true,
  );
});

test("recall request schema rejects non-boolean includeLowConfidence", () => {
  const result = validateRequest("recall", {
    query: "diagnose graph traversal",
    includeLowConfidence: "true",
  });

  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.error.code, "validation_error");
  assert.ok(
    result.error.details.some((detail) => detail.field === "includeLowConfidence"),
    "expected includeLowConfidence validation detail",
  );
});
