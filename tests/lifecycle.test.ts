import test from "node:test";
import assert from "node:assert/strict";
import type { MemoryFile, MemoryFrontmatter } from "../src/types.js";
import {
  computeDecay,
  computeHeat,
  decideLifecycleTransition,
  resolveLifecycleState,
} from "../src/lifecycle.js";

function buildMemory(overrides: Partial<MemoryFrontmatter> = {}): Pick<MemoryFile, "frontmatter"> {
  const frontmatter: MemoryFrontmatter = {
    id: "fact-lifecycle-test",
    category: "fact",
    created: "2026-02-01T00:00:00.000Z",
    updated: "2026-02-01T00:00:00.000Z",
    source: "test",
    confidence: 0.8,
    confidenceTier: "implied",
    tags: [],
    ...overrides,
  };
  return { frontmatter };
}

test("resolveLifecycleState maps archived status to archived lifecycle state", () => {
  const state = resolveLifecycleState(buildMemory({ status: "archived", lifecycleState: "active" }).frontmatter);
  assert.equal(state, "archived");
});

test("computeHeat stays within [0,1]", () => {
  const now = new Date("2026-02-22T00:00:00.000Z");
  const low = computeHeat(buildMemory({ accessCount: 0, confidenceTier: "speculative" }), now);
  const high = computeHeat(buildMemory({ accessCount: 100, confidenceTier: "explicit" }), now);
  assert.equal(low >= 0 && low <= 1, true);
  assert.equal(high >= 0 && high <= 1, true);
});

test("computeDecay stays within [0,1]", () => {
  const now = new Date("2026-02-22T00:00:00.000Z");
  const fresh = computeDecay(buildMemory({ updated: "2026-02-21T00:00:00.000Z", lastAccessed: "2026-02-21T00:00:00.000Z" }), now);
  const stale = computeDecay(buildMemory({ updated: "2024-01-01T00:00:00.000Z", lastAccessed: "2024-01-01T00:00:00.000Z" }), now);
  assert.equal(fresh >= 0 && fresh <= 1, true);
  assert.equal(stale >= 0 && stale <= 1, true);
});

test("computeHeat is monotonic with higher access count", () => {
  const now = new Date("2026-02-22T00:00:00.000Z");
  const lowAccess = computeHeat(buildMemory({ accessCount: 0, lastAccessed: "2026-02-20T00:00:00.000Z" }), now);
  const highAccess = computeHeat(buildMemory({ accessCount: 12, lastAccessed: "2026-02-20T00:00:00.000Z" }), now);
  assert.equal(highAccess > lowAccess, true);
});

test("computeDecay increases for older and unaccessed memories", () => {
  const now = new Date("2026-02-22T00:00:00.000Z");
  const recent = computeDecay(buildMemory({
    updated: "2026-02-21T00:00:00.000Z",
    lastAccessed: "2026-02-21T00:00:00.000Z",
    confidenceTier: "explicit",
  }), now);
  const old = computeDecay(buildMemory({
    updated: "2024-01-01T00:00:00.000Z",
    lastAccessed: "2024-01-01T00:00:00.000Z",
    confidenceTier: "speculative",
  }), now);
  assert.equal(old > recent, true);
});

test("computeDecay caps age/staleness components for very old but active memories", () => {
  const now = new Date("2026-02-22T00:00:00.000Z");
  const decay = computeDecay(buildMemory({
    updated: "2010-01-01T00:00:00.000Z",
    lastAccessed: "2026-02-22T00:00:00.000Z",
    accessCount: 50,
    confidenceTier: "explicit",
    verificationState: "user_confirmed",
  }), now, { feedbackScore: 1 });
  assert.equal(decay < 0.65, true);
});

test("decideLifecycleTransition never promotes disputed memory to active", () => {
  const now = new Date("2026-02-22T00:00:00.000Z");
  const decision = decideLifecycleTransition(
    buildMemory({
      lifecycleState: "candidate",
      verificationState: "disputed",
      accessCount: 50,
      lastAccessed: "2026-02-22T00:00:00.000Z",
      confidenceTier: "explicit",
    }),
    {},
    now,
  );
  assert.notEqual(decision.nextState, "active");
  assert.equal(decision.nextState, "stale");
});

test("decideLifecycleTransition keeps archived state terminal", () => {
  const now = new Date("2026-02-22T00:00:00.000Z");
  const decision = decideLifecycleTransition(
    buildMemory({
      status: "archived",
      lifecycleState: "archived",
      verificationState: "user_confirmed",
      accessCount: 50,
      lastAccessed: "2026-02-22T00:00:00.000Z",
    }),
    {},
    now,
  );
  assert.equal(decision.nextState, "archived");
  assert.equal(decision.changed, false);
});

test("decideLifecycleTransition does not auto-archive protected categories", () => {
  const now = new Date("2026-02-22T00:00:00.000Z");
  const decision = decideLifecycleTransition(
    buildMemory({
      category: "decision",
      lifecycleState: "active",
      updated: "2020-01-01T00:00:00.000Z",
      lastAccessed: "2020-01-01T00:00:00.000Z",
      confidenceTier: "speculative",
    }),
    {
      staleDecayThreshold: 0.4,
      archiveDecayThreshold: 0.6,
      protectedCategories: ["decision"],
    },
    now,
  );
  assert.notEqual(decision.nextState, "archived");
});

test("decideLifecycleTransition promotes to active when heat threshold is met and verified", () => {
  const now = new Date("2026-02-22T00:00:00.000Z");
  const decision = decideLifecycleTransition(
    buildMemory({
      lifecycleState: "validated",
      verificationState: "user_confirmed",
      accessCount: 30,
      lastAccessed: "2026-02-22T00:00:00.000Z",
      updated: "2026-02-22T00:00:00.000Z",
      confidenceTier: "explicit",
    }),
    {
      promoteHeatThreshold: 0.5,
      staleDecayThreshold: 0.8,
      archiveDecayThreshold: 0.95,
    },
    now,
  );
  assert.equal(decision.nextState, "active");
});
