import assert from "node:assert/strict";
import test from "node:test";

import { enrollSelf, SELF_SPEAKER_ID } from "./enroll.js";
import { CaptureConfigError } from "./errors.js";
import { Spool } from "./spool.js";

test("enrollSelf registers the self identity without an embedding", () => {
  const spool = new Spool(":memory:");
  try {
    const result = enrollSelf({ spool, label: "Jane" });
    assert.equal(result.speakerId, SELF_SPEAKER_ID);
    assert.equal(result.hasEmbedding, false);
    const self = spool.listSpeakers().find((s) => s.id === SELF_SPEAKER_ID);
    assert.equal(self?.isSelf, true);
    assert.equal(self?.label, "Jane");
  } finally {
    spool.close();
  }
});

test("enrollSelf stores a self centroid when an embedding is provided", () => {
  const spool = new Spool(":memory:");
  try {
    const result = enrollSelf({ spool, embedding: [0.1, 0.2, 0.3] });
    assert.equal(result.hasEmbedding, true);
    assert.equal(result.dimensions, 3);
    assert.equal(result.label, "You"); // default label
    const cluster = spool.readSpeakerClusters().find((c) => c.id === SELF_SPEAKER_ID);
    assert.equal(cluster?.isSelf, true);
    assert.deepEqual(cluster?.centroid, [0.1, 0.2, 0.3]);
    assert.equal(cluster?.embeddingCount, 1);
  } finally {
    spool.close();
  }
});

test("enrollSelf rejects an empty or non-finite embedding", () => {
  const spool = new Spool(":memory:");
  try {
    assert.throws(() => enrollSelf({ spool, embedding: [] }), CaptureConfigError);
    assert.throws(() => enrollSelf({ spool, embedding: [Number.NaN] }), CaptureConfigError);
  } finally {
    spool.close();
  }
});
