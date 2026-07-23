import assert from "node:assert/strict";
import test from "node:test";

import { cosineSimilarity, SpeakerClusterer } from "./diarization.js";

/** Deterministic pseudo-embedding near a base vector (same speaker) with jitter. */
function nearVoice(base: number[], seed: number, jitter = 0.02): number[] {
  return base.map((v, i) => v + jitter * Math.sin(seed * 7 + i));
}

test("cosineSimilarity: identical=1, orthogonal=0", () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([], [1]), 0);
});

test("fragmentation regression: one synthetic voice across 50 segments stays one cluster", () => {
  const clusterer = new SpeakerClusterer(0.4);
  const base = [0.9, 0.1, 0.4, 0.2, 0.7];
  const ids = new Set<string>();
  for (let i = 0; i < 50; i++) ids.add(clusterer.assign(nearVoice(base, i)));
  assert.equal(ids.size, 1, `expected 1 cluster, got ${[...ids].join(",")}`);
});

test("two distinct voices form two clusters", () => {
  const clusterer = new SpeakerClusterer(0.5);
  const voiceA = [0.9, 0.1, 0.1, 0.0];
  const voiceB = [0.0, 0.1, 0.1, 0.9];
  const a = clusterer.assign(voiceA);
  const b = clusterer.assign(voiceB);
  assert.notEqual(a, b);
  // A third sample close to A rejoins A, not B.
  assert.equal(clusterer.assign(nearVoice(voiceA, 3)), a);
});

test("cluster ids are stable across a restart when seeded from persisted clusters", () => {
  const first = new SpeakerClusterer(0.5);
  const voice = [0.2, 0.8, 0.1, 0.3];
  const id = first.assign(voice);
  const seeded = new SpeakerClusterer(0.5, first.clusters());
  assert.equal(seeded.assign(nearVoice(voice, 1)), id);
  // A new distinct voice does not reuse the seeded id.
  assert.notEqual(seeded.assign([0.9, 0.0, 0.0, 0.1]), id);
});

test("enrolled self voice is labeled `self`", () => {
  const clusterer = new SpeakerClusterer(0.5);
  const selfVoice = [0.5, 0.5, 0.5, 0.5];
  clusterer.enrollSelf(selfVoice);
  assert.equal(clusterer.assign(nearVoice(selfVoice, 2)), "self");
});

test("constructor rejects an out-of-range threshold", () => {
  assert.throws(() => new SpeakerClusterer(0));
  assert.throws(() => new SpeakerClusterer(1));
});
