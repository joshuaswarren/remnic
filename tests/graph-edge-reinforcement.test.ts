/**
 * Unit tests for graph edge confidence + reinforcement primitives (issue #681 PR 1/3).
 *
 * Pure-function tests — no filesystem, no async. Covers:
 *   - reinforceEdge: round-trip, ceiling cap at 1.0, idempotency, custom delta
 *   - decayEdgeConfidence: no-op inside grace window, exact-boundary behavior,
 *     linear decay past the window, floor clamp, legacy edge fallback
 *   - readEdgeConfidence / readLastReinforcedAt fallback semantics
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CONFIDENCE_CEILING,
  DEFAULT_DECAY_FLOOR,
  DEFAULT_DECAY_PER_WINDOW,
  DEFAULT_DECAY_WINDOW_MS,
  DEFAULT_REINFORCE_DELTA,
  decayEdgeConfidence,
  readEdgeConfidence,
  readLastReinforcedAt,
  reinforceEdge,
} from "../src/graph-edge-reinforcement.js";
import type { GraphEdge } from "../src/graph.js";

function baseEdge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    from: "facts/2026-01-01/a.md",
    to: "facts/2026-01-01/b.md",
    type: "entity",
    weight: 1.0,
    label: "person:Alice",
    ts: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ─── readEdgeConfidence ─────────────────────────────────────────────────────

test("readEdgeConfidence treats missing confidence as 1.0", () => {
  assert.equal(readEdgeConfidence(baseEdge()), 1.0);
});

test("readEdgeConfidence clamps out-of-range values into [0, 1]", () => {
  assert.equal(readEdgeConfidence(baseEdge({ confidence: 1.7 })), 1.0);
  assert.equal(readEdgeConfidence(baseEdge({ confidence: -0.5 })), 0);
  assert.equal(readEdgeConfidence(baseEdge({ confidence: Number.NaN })), 1.0);
});

// ─── readLastReinforcedAt ───────────────────────────────────────────────────

test("readLastReinforcedAt falls back to edge.ts when missing", () => {
  const edge = baseEdge();
  assert.equal(readLastReinforcedAt(edge), edge.ts);
});

test("readLastReinforcedAt prefers explicit lastReinforcedAt", () => {
  const edge = baseEdge({ lastReinforcedAt: "2026-02-01T00:00:00.000Z" });
  assert.equal(readLastReinforcedAt(edge), "2026-02-01T00:00:00.000Z");
});

// ─── reinforceEdge ──────────────────────────────────────────────────────────

test("reinforceEdge bumps confidence by default delta and stamps lastReinforcedAt", () => {
  const edge = baseEdge({ confidence: 0.5 });
  const now = "2026-03-01T12:00:00.000Z";
  const out = reinforceEdge(edge, now);
  assert.equal(out.confidence, 0.5 + DEFAULT_REINFORCE_DELTA);
  assert.equal(out.lastReinforcedAt, now);
  // Other fields preserved
  assert.equal(out.from, edge.from);
  assert.equal(out.to, edge.to);
  assert.equal(out.label, edge.label);
  assert.equal(out.weight, edge.weight);
  // Input is not mutated.
  assert.equal(edge.confidence, 0.5);
  assert.equal(edge.lastReinforcedAt, undefined);
});

test("graph edge decay docs describe the default reinforcement bump", async () => {
  const docs = await readFile(new URL("../docs/graph-edge-decay.md", import.meta.url), "utf8");
  assert.match(docs, /bumps `confidence` by the default reinforcement delta \(`0\.05`\)/);
  assert.match(docs, /capped at\s+`1\.0`/);
});

test("reinforceEdge round-trip: legacy edge (missing confidence) starts at 1.0 and stays capped", () => {
  const edge = baseEdge();
  const out = reinforceEdge(edge, "2026-03-01T00:00:00.000Z");
  assert.equal(out.confidence, CONFIDENCE_CEILING);
});

test("reinforceEdge caps at 1.0 even with large delta", () => {
  const edge = baseEdge({ confidence: 0.95 });
  const out = reinforceEdge(edge, "2026-03-01T00:00:00.000Z", 0.5);
  assert.equal(out.confidence, CONFIDENCE_CEILING);
});

test("reinforceEdge with delta=0 is a stamp-only idempotent operation", () => {
  const edge = baseEdge({ confidence: 0.42 });
  const now = "2026-03-15T00:00:00.000Z";
  const once = reinforceEdge(edge, now, 0);
  const twice = reinforceEdge(once, now, 0);
  assert.equal(once.confidence, 0.42);
  assert.equal(twice.confidence, 0.42);
  assert.equal(twice.lastReinforcedAt, now);
});

test("reinforceEdge with custom delta accumulates correctly across calls", () => {
  let edge = baseEdge({ confidence: 0.1 });
  edge = reinforceEdge(edge, "2026-04-01T00:00:00.000Z", 0.2);
  edge = reinforceEdge(edge, "2026-04-02T00:00:00.000Z", 0.2);
  edge = reinforceEdge(edge, "2026-04-03T00:00:00.000Z", 0.2);
  assert.equal(Math.round((edge.confidence ?? 0) * 10) / 10, 0.7);
});

test("reinforceEdge with non-finite delta is treated as zero", () => {
  const edge = baseEdge({ confidence: 0.6 });
  const out = reinforceEdge(edge, "2026-03-01T00:00:00.000Z", Number.NaN);
  assert.equal(out.confidence, 0.6);
});

// ─── decayEdgeConfidence ────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function isoOffset(baseIso: string, offsetMs: number): string {
  return new Date(Date.parse(baseIso) + offsetMs).toISOString();
}

test("decayEdgeConfidence is a no-op inside the grace window", () => {
  const edge = baseEdge({
    confidence: 0.9,
    lastReinforcedAt: "2026-01-01T00:00:00.000Z",
  });
  const now = isoOffset("2026-01-01T00:00:00.000Z", 30 * DAY_MS);
  const out = decayEdgeConfidence(edge, now);
  assert.equal(out.confidence, 0.9);
});

test("decayEdgeConfidence boundary: age === windowMs is INSIDE grace (no decay)", () => {
  const edge = baseEdge({
    confidence: 0.9,
    lastReinforcedAt: "2026-01-01T00:00:00.000Z",
  });
  const now = isoOffset("2026-01-01T00:00:00.000Z", DEFAULT_DECAY_WINDOW_MS);
  const out = decayEdgeConfidence(edge, now);
  assert.equal(out.confidence, 0.9);
});

test("decayEdgeConfidence applies one window of decay just past the boundary", () => {
  const edge = baseEdge({
    confidence: 0.9,
    lastReinforcedAt: "2026-01-01T00:00:00.000Z",
  });
  const now = isoOffset("2026-01-01T00:00:00.000Z", DEFAULT_DECAY_WINDOW_MS + 1);
  const out = decayEdgeConfidence(edge, now);
  // age - windowMs = 1ms ⇒ floor(1 / window) + 1 = 1 window past
  assert.equal(out.confidence, 0.9 - DEFAULT_DECAY_PER_WINDOW);
});

test("decayEdgeConfidence applies linear decay across multiple windows", () => {
  const edge = baseEdge({
    confidence: 0.9,
    lastReinforcedAt: "2026-01-01T00:00:00.000Z",
  });
  // 3x the window past the start ⇒ 2 windows of decay
  // (windowsPast = ceil((3w - 1w)/1w) = 2; the boundary fix in
  // graph-edge-reinforcement.ts addresses codex P2 over-counting at
  // exact window multiples).
  const now = isoOffset("2026-01-01T00:00:00.000Z", 3 * DEFAULT_DECAY_WINDOW_MS);
  const out = decayEdgeConfidence(edge, now);
  assert.equal(out.confidence, 0.9 - 2 * DEFAULT_DECAY_PER_WINDOW);
});

test("decayEdgeConfidence clamps at the floor", () => {
  const edge = baseEdge({
    confidence: 0.2,
    lastReinforcedAt: "2026-01-01T00:00:00.000Z",
  });
  // Far enough out that linear decay would go negative.
  const now = isoOffset("2026-01-01T00:00:00.000Z", 100 * DEFAULT_DECAY_WINDOW_MS);
  const out = decayEdgeConfidence(edge, now);
  assert.equal(out.confidence, DEFAULT_DECAY_FLOOR);
});

test("decayEdgeConfidence honors custom window/perWindow/floor options", () => {
  const edge = baseEdge({
    confidence: 1.0,
    lastReinforcedAt: "2026-01-01T00:00:00.000Z",
  });
  const opts = { windowMs: DAY_MS, perWindow: 0.25, floor: 0.5 };
  // 3 days past start ⇒ windowsPast = floor((3d - 1d)/1d) + 1 = 3
  const now = isoOffset("2026-01-01T00:00:00.000Z", 3 * DAY_MS);
  const out = decayEdgeConfidence(edge, now, opts);
  // 1.0 - 3*0.25 = 0.25 ⇒ clamped at floor 0.5
  assert.equal(out.confidence, 0.5);
});

test("decayEdgeConfidence on legacy edge falls back to edge.ts", () => {
  const edge = baseEdge({ ts: "2026-01-01T00:00:00.000Z" }); // no confidence, no lastReinforcedAt
  const now = isoOffset("2026-01-01T00:00:00.000Z", 2 * DEFAULT_DECAY_WINDOW_MS);
  const out = decayEdgeConfidence(edge, now);
  // Legacy confidence treated as 1.0; at exactly 2*windowMs only one
  // post-grace window has elapsed (windowsPast = ceil((2w-1w)/1w) = 1).
  assert.equal(out.confidence, 1.0 - 1 * DEFAULT_DECAY_PER_WINDOW);
});

test("decayEdgeConfidence reinforce-then-decay round trip resets the clock", () => {
  const original = baseEdge({
    confidence: 0.5,
    lastReinforcedAt: "2026-01-01T00:00:00.000Z",
  });
  // First, reinforce — that resets lastReinforcedAt to "now".
  const reinforcedAt = "2026-06-01T00:00:00.000Z";
  const reinforced = reinforceEdge(original, reinforcedAt);
  // Decay-check 30 days after reinforcement should be a no-op.
  const checkAt = isoOffset(reinforcedAt, 30 * DAY_MS);
  const out = decayEdgeConfidence(reinforced, checkAt);
  assert.equal(out.confidence, reinforced.confidence);
});

test("decayEdgeConfidence with invalid options returns normalized confidence", () => {
  const edge = baseEdge({
    confidence: 0.7,
    lastReinforcedAt: "2026-01-01T00:00:00.000Z",
  });
  const out = decayEdgeConfidence(edge, "2026-06-01T00:00:00.000Z", {
    windowMs: -1,
  });
  assert.equal(out.confidence, 0.7);
});

test("decayEdgeConfidence with unparseable timestamps returns normalized confidence", () => {
  const edge = baseEdge({
    confidence: 0.7,
    lastReinforcedAt: "not-a-date",
  });
  const out = decayEdgeConfidence(edge, "also-not-a-date");
  assert.equal(out.confidence, 0.7);
});

test("decayEdgeConfidence does not over-decay at exact window multiples (codex P2)", () => {
  const edge = baseEdge({
    confidence: 0.9,
    lastReinforcedAt: "2026-01-01T00:00:00.000Z",
  });
  // At exactly 2*windowMs, only ONE post-grace window has elapsed —
  // sitting on the boundary doesn't count as a completed second window.
  const out2 = decayEdgeConfidence(
    edge,
    isoOffset("2026-01-01T00:00:00.000Z", 2 * DEFAULT_DECAY_WINDOW_MS),
  );
  assert.equal(out2.confidence, 0.9 - 1 * DEFAULT_DECAY_PER_WINDOW);

  // Just past the boundary, still counts as one window.
  const out2b = decayEdgeConfidence(
    edge,
    isoOffset("2026-01-01T00:00:00.000Z", 2 * DEFAULT_DECAY_WINDOW_MS + 1),
  );
  assert.equal(out2b.confidence, 0.9 - 2 * DEFAULT_DECAY_PER_WINDOW);

  // Halfway through the second post-grace window, still 1.
  const out15 = decayEdgeConfidence(
    edge,
    isoOffset("2026-01-01T00:00:00.000Z", 1.5 * DEFAULT_DECAY_WINDOW_MS),
  );
  assert.equal(out15.confidence, 0.9 - 1 * DEFAULT_DECAY_PER_WINDOW);
});
