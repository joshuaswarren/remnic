import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../config.js";
import {
  applyNoveltyGate,
  DEFAULT_NOVELTY_ADD_THRESHOLD,
  DEFAULT_NOVELTY_NOOP_THRESHOLD,
  scoreNovelty,
  type NoveltyNeighbor,
} from "./novelty-gate.js";

function neighborAtCosine(id: string, cosine: number): NoveltyNeighbor {
  const s = Math.min(1, Math.max(-1, cosine));
  return { id, embedding: [s, Math.sqrt(Math.max(0, 1 - s * s))] };
}

const CANDIDATE = [1, 0];

test("novelty gate: parseConfig defaults keep the gate off with a wide uncertain band", () => {
  const config = parseConfig({});
  assert.equal(config.noveltyGateEnabled, false);
  assert.equal(config.noveltyAddThreshold, DEFAULT_NOVELTY_ADD_THRESHOLD);
  assert.equal(config.noveltyNoopThreshold, DEFAULT_NOVELTY_NOOP_THRESHOLD);
  assert.ok(config.noveltyAddThreshold - config.noveltyNoopThreshold > 0.3);
});

test("novelty gate: conservative preset stays off", () => {
  const config = parseConfig({ memoryOsPreset: "conservative" });
  assert.equal(config.noveltyGateEnabled, false);
});

test("novelty gate: gate off does not call lookup", async () => {
  let called = 0;
  const decision = await applyNoveltyGate({
    enabled: false,
    addThreshold: DEFAULT_NOVELTY_ADD_THRESHOLD,
    noopThreshold: DEFAULT_NOVELTY_NOOP_THRESHOLD,
    lookup: async () => {
      called += 1;
      throw new Error("lookup must not run when the gate is off");
    },
  });
  assert.equal(called, 0);
  assert.equal(decision.decision, "uncertain");
});

test("novelty gate: paraphrase routes noop", () => {
  const decision = scoreNovelty(CANDIDATE, [neighborAtCosine("paraphrase", 0.98)]);
  assert.equal(decision.decision, "noop");
  assert.equal(decision.neighborId, "paraphrase");
  assert.ok(decision.score <= DEFAULT_NOVELTY_NOOP_THRESHOLD);
});

test("novelty gate: unrelated routes add", () => {
  const decision = scoreNovelty(CANDIDATE, [neighborAtCosine("other", 0.05)]);
  assert.equal(decision.decision, "add");
  assert.equal(decision.neighborId, "other");
  assert.ok(decision.score >= DEFAULT_NOVELTY_ADD_THRESHOLD);
});

test("novelty gate: exactly at addThreshold is add", () => {
  const neighbor = neighborAtCosine("edge-add", 1 - DEFAULT_NOVELTY_ADD_THRESHOLD);
  const measured = scoreNovelty(CANDIDATE, [neighbor], { addThreshold: 1, noopThreshold: -1 });
  const decision = scoreNovelty(CANDIDATE, [neighbor], {
    addThreshold: measured.score,
    noopThreshold: DEFAULT_NOVELTY_NOOP_THRESHOLD,
  });
  assert.equal(decision.decision, "add");
});

test("novelty gate: exactly at noopThreshold is noop", () => {
  const neighbor = neighborAtCosine("edge-noop", 1 - DEFAULT_NOVELTY_NOOP_THRESHOLD);
  const measured = scoreNovelty(CANDIDATE, [neighbor], { addThreshold: 1, noopThreshold: -1 });
  const decision = scoreNovelty(CANDIDATE, [neighbor], {
    addThreshold: DEFAULT_NOVELTY_ADD_THRESHOLD,
    noopThreshold: measured.score,
  });
  assert.equal(decision.decision, "noop");
});

test("novelty gate: mid-band routes uncertain", () => {
  const mid = (DEFAULT_NOVELTY_ADD_THRESHOLD + DEFAULT_NOVELTY_NOOP_THRESHOLD) / 2;
  const decision = scoreNovelty(CANDIDATE, [neighborAtCosine("mid", 1 - mid)]);
  assert.equal(decision.decision, "uncertain");
});

test("novelty gate: empty neighborhood is add", () => {
  const decision = scoreNovelty(CANDIDATE, []);
  assert.equal(decision.decision, "add");
  assert.equal(decision.score, 1);
  assert.equal(decision.neighborId, undefined);
});

test("novelty gate: thrown lookup is uncertain", async () => {
  const decision = await applyNoveltyGate({
    enabled: true,
    addThreshold: DEFAULT_NOVELTY_ADD_THRESHOLD,
    noopThreshold: DEFAULT_NOVELTY_NOOP_THRESHOLD,
    lookup: async () => {
      throw new Error("backend down");
    },
  });
  assert.equal(decision.decision, "uncertain");
});
